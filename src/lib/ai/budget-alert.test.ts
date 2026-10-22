import { beforeEach, describe, expect, it, vi } from 'vitest';
import eightyPercentFixture from '../../../tests/fixtures/ai/budget-alert/eighty-percent.json';
import bedrockSwitchFixture from '../../../tests/fixtures/ai/budget-alert/bedrock-switch.json';
import duplicateFixture from '../../../tests/fixtures/ai/budget-alert/duplicate-event.json';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(async () => 1),
  sendEmail: vi.fn(async () => ({ messageId: 'mail-1' })),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) =>
    run({ $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw }),
}));

import { sendAIBudgetNotice, type AIBudgetNotice } from './budget-alert';

type Sql = { strings: readonly string[]; values: readonly unknown[] };
const sqlText = (sql: Sql) => sql.strings.join('?').replace(/\s+/g, ' ').trim();

function noticeFrom(fixture: { input: { event: string; organizationId: string; monthStart: string; monthEnd: string; spendUsd: number; budgetUsd: number } }): AIBudgetNotice {
  return {
    ...fixture.input,
    event: fixture.input.event as AIBudgetNotice['event'],
    monthStart: new Date(fixture.input.monthStart),
    monthEnd: new Date(fixture.input.monthEnd),
  };
}

const october = noticeFrom(eightyPercentFixture);

function successfulQueries() {
  mocks.queryRaw
    .mockResolvedValueOnce([{ id: 'alert_october' }])
    .mockResolvedValueOnce([{ id: 'platform_1', name: 'Admin', email: 'admin@example.test' }])
    .mockResolvedValueOnce([{ id: 'owner_1', name: 'Owner', email: 'owner@abbasi.test' }]);
}

describe('DevFathom AI pharmacy budget notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeRaw.mockResolvedValue(1);
  });

  it('delivers the happy-path alert to platform admins and the matching pharmacy owner', async () => {
    successfulQueries();

    await expect(sendAIBudgetNotice(october)).resolves.toBe(true);

    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail).toHaveBeenCalledWith({
      to: { name: 'Owner', email: 'owner@abbasi.test' },
      subject: eightyPercentFixture.expected.title,
      text: eightyPercentFixture.expected.message,
      html: `<p>${eightyPercentFixture.expected.message}</p>`,
    });
  });

  it('keeps the owner read and notification write tenant scoped so org A cannot read org B', async () => {
    successfulQueries();
    await sendAIBudgetNotice(october);

    const ownerRead = mocks.queryRaw.mock.calls[2][0] as Sql;
    const tenantWrite = mocks.executeRaw.mock.calls[1][0] as Sql;
    expect(sqlText(ownerRead)).toContain(
      'WHERE u."organizationId" = ? AND r."organizationId" = ?'
    );
    expect(ownerRead.values.filter((value) => value === 'org_abbasi')).toHaveLength(2);
    expect(ownerRead.values).not.toContain('org_competitor');
    expect(sqlText(tenantWrite)).toContain(
      'WHERE u."organizationId" = ? AND r."organizationId" = ?'
    );
    expect(tenantWrite.values.filter((value) => value === 'org_abbasi')).toHaveLength(2);
  });

  it('writes the durable alert ledger and both notification audit entries before email delivery', async () => {
    const order: string[] = [];
    mocks.queryRaw
      .mockImplementationOnce(async () => {
        order.push('claim');
        return [{ id: 'alert_october' }];
      })
      .mockResolvedValueOnce([{ id: 'platform_1', name: 'Admin', email: 'admin@example.test' }])
      .mockResolvedValueOnce([{ id: 'owner_1', name: 'Owner', email: 'owner@abbasi.test' }]);
    mocks.executeRaw.mockImplementation(async () => {
      order.push('notification');
      return 1;
    });
    mocks.sendEmail.mockImplementation(async () => {
      order.push('email');
      return { messageId: 'mail-1' };
    });

    await sendAIBudgetNotice(october);

    const claim = mocks.queryRaw.mock.calls[0][0] as Sql;
    expect(sqlText(claim)).toContain('INSERT INTO "ai_budget_alerts"');
    expect(sqlText(claim)).toContain('ON CONFLICT ("event", "monthStart") DO NOTHING');
    expect(mocks.executeRaw.mock.calls.map(([sql]) => sqlText(sql as Sql))).toEqual([
      expect.stringContaining('INSERT INTO "platform_notifications"'),
      expect.stringContaining('INSERT INTO "notifications"'),
    ]);
    expect(order.slice(0, 3)).toEqual(['claim', 'notification', 'notification']);
    expect(order.slice(3)).toEqual(['email', 'email']);
  });

  it('is idempotent: a duplicate claim creates no notifications, emails, or second audit entry', async () => {
    successfulQueries();
    await expect(sendAIBudgetNotice(october)).resolves.toBe(true);
    mocks.queryRaw.mockResolvedValueOnce([]);

    await expect(sendAIBudgetNotice(noticeFrom(duplicateFixture))).resolves.toBe(false);

    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(4);
  });

  it('can claim the same event again in a new Karachi month', async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ id: 'alert_november' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(
      sendAIBudgetNotice({
        ...october,
        monthStart: october.monthEnd,
        monthEnd: new Date('2026-11-30T19:00:00.000Z'),
      })
    ).resolves.toBe(true);
  });

  it('uses the approved DevFathom AI label and evaluated Bedrock-switch copy', async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ id: 'alert_switch' }])
      .mockResolvedValueOnce([{ id: 'platform_1', name: 'Admin', email: 'admin@example.test' }])
      .mockResolvedValueOnce([]);

    await sendAIBudgetNotice(noticeFrom(bedrockSwitchFixture));

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: bedrockSwitchFixture.expected.title,
        text: bedrockSwitchFixture.expected.message,
      })
    );
    expect(bedrockSwitchFixture.expected.title).toMatch(/^DevFathom AI/);
  });

  it('does not let email failure roll back or duplicate the durable alert', async () => {
    successfulQueries();
    mocks.sendEmail.mockRejectedValue(new Error('mail unavailable'));

    await expect(sendAIBudgetNotice(october)).resolves.toBe(true);
    mocks.queryRaw.mockResolvedValueOnce([]);
    await expect(sendAIBudgetNotice(october)).resolves.toBe(false);

    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
  });
});
