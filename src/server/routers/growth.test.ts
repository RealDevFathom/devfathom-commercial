import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  can: vi.fn(),
}));

vi.mock('@/lib/growth', () => ({ isGrowthEnabled: mocks.enabled }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordTrpcAudit: vi.fn(async () => undefined),
  annotateAudit: vi.fn(),
}));

import { growthRouter } from './growth';

let sequence = 0;

function caller() {
  sequence += 1;
  const organizationId = `org_growth_ui_${sequence}`;
  return growthRouter.createCaller({
    db: {},
    entitlements: {
      organizationId,
      enabledModules: ['growth_ai'],
      modules: [],
      seatLimit: 5,
      activeSeats: 1,
      limits: {},
    },
    session: {
      user: {
        id: 'user_owner',
        name: 'Hina Malik',
        email: 'hina@sehat.test',
        organizationId,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    },
    organization: { id: organizationId, isDemo: false, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

const settingsInput = {
  monthlyBudgetMinor: 1_500_000,
  autoApproveUnderMinor: 50_000,
  quietHoursStart: 22,
  quietHoursEnd: 8,
  maxMsgsPerDay: 200,
  maxDiscountPct: 25,
  customDates: ['2026-11-09'],
  waInstanceName: 'sehat-pharmacy',
  waApiUrl: 'http://127.0.0.1:8080',
};

beforeEach(() => {
  mocks.enabled.mockResolvedValue(true);
  mocks.can.mockResolvedValue(true);
});

describe('growth admin procedures', () => {
  it('lists proposals and approves one onto the scheduled queue', async () => {
    const api = caller();
    const proposed = await api.campaigns.list({ tab: 'proposed' });
    expect(proposed.campaigns.map((campaign) => campaign.name)).toEqual([
      'Wapas aao',
      'November birthdays',
    ]);
    const approved = await api.campaigns.approve({ id: 'cmp_winback' });
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('user_owner');
    const scheduled = await api.campaigns.list({ tab: 'scheduled' });
    expect(scheduled.campaigns.map((campaign) => campaign.id)).toContain('cmp_winback');
    await expect(api.campaigns.approve({ id: 'cmp_winback' })).rejects.toBeInstanceOf(TRPCError);
  });

  it('rejects a proposal and refuses edits after it has been sent', async () => {
    const api = caller();
    const rejected = await api.campaigns.cancel({ id: 'cmp_birthday' });
    expect(rejected.status).toBe('cancelled');
    expect(
      (await api.campaigns.list({ tab: 'proposed' })).campaigns.map((campaign) => campaign.id)
    ).not.toContain('cmp_birthday');
    await expect(
      api.campaigns.update({
        id: 'cmp_eid',
        name: 'Changed',
        kind: 'holiday',
        segment: { type: 'all' },
        sendAt: '2026-10-24T06:00:00.000Z',
        discountType: 'none',
        discountValue: null,
        budgetCapMinor: 0,
        templateId: 'tpl_holiday',
        rationale: null,
      })
    ).rejects.toMatchObject({ message: 'Only a proposal can be edited.' });
  });

  it('edits a proposal and creates a manual one', async () => {
    const api = caller();
    const edited = await api.campaigns.update({
      id: 'cmp_winback',
      name: 'Wapas aao, softer',
      kind: 'winback',
      segment: { type: 'churn_band', band: 'high' },
      sendAt: '2026-10-24T06:00:00.000Z',
      discountType: 'percent',
      discountValue: 5,
      budgetCapMinor: 400_000,
      templateId: 'tpl_winback',
      rationale: 'A smaller code.',
    });
    expect(edited.name).toBe('Wapas aao, softer');
    expect(edited.discountValue).toBe(5);
    const created = await api.campaigns.create({
      name: 'Manual Friday',
      kind: 'manual',
      segment: { type: 'all' },
      sendAt: '2026-10-25T06:00:00.000Z',
      discountType: 'percent',
      discountValue: 10,
      budgetCapMinor: 100_000,
      templateId: 'tpl_generic',
      rationale: 'Counter was quiet.',
    });
    expect(created.status).toBe('proposed');
    expect(created.createdBy).toBe('user_owner');
    expect(created.estimatedReach).toBe(128);
  });

  it('masks phones and reports reach, spend, and redemptions', async () => {
    const api = caller();
    const detail = await api.campaigns.get({ id: 'cmp_eid' });
    expect(detail.campaign.estimatedReach).toBe(40);
    expect(detail.campaign.spentMinor).toBe(180_000);
    expect(detail.campaign.budgetCapMinor).toBe(500_000);
    expect(detail.campaign.redemptionCount).toBe(2);
    expect(JSON.stringify(detail)).not.toContain('+923001112233');
    expect(detail.recipients.map((recipient) => recipient.phoneMasked)).toContain('•••• 2233');
    expect(detail.preview).toContain('Ayesha Khan');
    const summary = await api.metrics.summary();
    expect(summary.optedInCustomers).toBe(128);
    expect(summary.highChurnCustomers).toBe(17);
    expect(summary.monthlyBudgetMinor).toBe(1_500_000);
    expect(summary.redemptionsThisMonth).toBe(2);
    expect(summary.monthSpendMinor).toBe(180_000);
  });

  it('round-trips quiet hours and never returns the API key', async () => {
    const api = caller();
    const saved = await api.settings.update({ ...settingsInput, waApiKey: 'new-secret-1234' });
    expect(saved.quietHoursStart).toBe(22);
    expect(saved.quietHoursEnd).toBe(8);
    expect(saved.waApiKeyHint).toBe('••••1234');
    expect(JSON.stringify(saved)).not.toContain('new-secret-1234');
    expect(JSON.stringify(await api.settings.get())).not.toContain('fixture-key-9f3a');
    const cleared = await api.settings.update({ ...settingsInput, waInstanceName: null });
    expect(cleared.quietHoursStart).toBe(22);
    expect((await api.connection.status()).status).toBe('needs_pairing');
  });

  it('refuses a template with an unknown variable and does not save it', async () => {
    const api = caller();
    const before = (await api.templates.list()).templates.find(
      (template) => template.id === 'tpl_generic'
    );
    await expect(
      api.templates.update({ id: 'tpl_generic', body: 'Salaam {{nope}}. Reply STOP to opt out.' })
    ).rejects.toMatchObject({ message: expect.stringMatching(/\{\{nope\}\}/) });
    const after = (await api.templates.list()).templates.find(
      (template) => template.id === 'tpl_generic'
    );
    expect(after?.body).toBe(before?.body);
    await expect(
      api.templates.update({ id: 'tpl_generic', body: 'Salaam {{name}}' })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/STOP/),
    });
  });

  it('queues a test without storing the phone number', async () => {
    const api = caller();
    const message = await api.messages.sendTest({ toE164: '+923001234567' });
    expect(message.status).toBe('queued');
    expect(message.direction).toBe('out');
    expect(message.body).toMatch(/STOP/);
    expect(message.body).not.toContain('923001234567');
    expect((await api.messages.list()).messages.some((row) => row.id === message.id)).toBe(true);
    await expect(api.messages.sendTest({ toE164: '03001234567' })).rejects.toBeInstanceOf(
      TRPCError
    );
  });

  it('denies a shop with the flag off and a cashier', async () => {
    mocks.enabled.mockResolvedValue(false);
    await expect(caller().metrics.summary()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Growth AI is off for this shop.',
    });
    mocks.enabled.mockResolvedValue(true);
    mocks.can.mockResolvedValue(false);
    await expect(caller().metrics.summary()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
