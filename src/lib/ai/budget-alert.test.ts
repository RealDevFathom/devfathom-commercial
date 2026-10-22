import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const october: AIBudgetNotice = {
  event: 'EIGHTY_PERCENT',
  organizationId: 'org_1',
  monthStart: new Date('2026-09-30T19:00:00.000Z'),
  monthEnd: new Date('2026-10-31T19:00:00.000Z'),
  spendUsd: 160,
  budgetUsd: 200,
};

describe('AI budget notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeRaw.mockResolvedValue(1);
  });

  it('claims the 80% notification once and suppresses a repeat call', async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ id: 'alert_october' }])
      .mockResolvedValueOnce([{ id: 'platform_1', name: 'Admin', email: 'admin@example.test' }])
      .mockResolvedValueOnce([{ id: 'owner_1', name: 'Owner', email: 'owner@example.test' }])
      .mockResolvedValueOnce([]);

    await expect(sendAIBudgetNotice(october)).resolves.toBe(true);
    await expect(sendAIBudgetNotice(october)).resolves.toBe(false);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('can claim the same event again in a new month', async () => {
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
});
