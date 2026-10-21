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

import { decryptSecret } from '@/lib/secret-crypto';

import { growthRouter, growthStore } from './growth';

let sequence = 0;

function caller() {
  sequence += 1;
  const organizationId = `org_growth_ui_${sequence}`;
  const countAudience = vi.fn(async () => 7);
  const api = growthRouter.createCaller({
    db: { growthWaCustomer: { count: countAudience } },
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
  return { api, organizationId, countAudience };
}

const proposal = {
  name: 'Welcome back',
  kind: 'manual' as const,
  segment: { type: 'all' as const },
  sendAt: '2026-10-24T06:00:00.000Z',
  discountType: 'none' as const,
  discountValue: null,
  budgetCapMinor: 0,
  templateId: 'tpl_generic',
  rationale: null as string | null,
};

const settingsInput = {
  monthlyBudgetMinor: 0,
  autoApproveUnderMinor: 0,
  quietHoursStart: 22,
  quietHoursEnd: 8,
  maxMsgsPerDay: 30,
  maxDiscountPct: 25,
  customDates: [] as string[],
  waInstanceName: 'shop',
  waApiUrl: 'http://127.0.0.1:8080',
};

beforeEach(() => {
  mocks.enabled.mockResolvedValue(true);
  mocks.can.mockResolvedValue(true);
  process.env.PLATFORM_ENCRYPTION_KEY = 'a'.repeat(64);
});

describe('growth admin procedures', () => {
  it('lists the proposal and approves it onto the scheduled queue', async () => {
    const { api } = caller();
    const proposed = await api.campaigns.list({ tab: 'proposed' });
    expect(proposed.campaigns.map((campaign) => campaign.name)).toEqual(['Welcome back']);
    const approved = await api.campaigns.approve({ id: 'cmp_proposal' });
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('user_owner');
    const scheduled = await api.campaigns.list({ tab: 'scheduled' });
    expect(scheduled.campaigns.map((campaign) => campaign.id)).toContain('cmp_proposal');
    await expect(api.campaigns.approve({ id: 'cmp_proposal' })).rejects.toBeInstanceOf(TRPCError);
  });

  it('rejects a proposal and refuses edits once it is no longer proposed', async () => {
    const { api } = caller();
    const rejected = await api.campaigns.cancel({ id: 'cmp_proposal' });
    expect(rejected.status).toBe('cancelled');
    expect(
      (await api.campaigns.list({ tab: 'proposed' })).campaigns.map((campaign) => campaign.id)
    ).not.toContain('cmp_proposal');
    await expect(api.campaigns.update({ ...proposal, id: 'cmp_proposal' })).rejects.toMatchObject({
      message: 'Only a proposal can be edited.',
    });
  });

  it('edits a proposal and creates another that stays proposed when auto-approve is off', async () => {
    const { api } = caller();
    const edited = await api.campaigns.update({
      ...proposal,
      id: 'cmp_proposal',
      name: 'Welcome back, softer',
      rationale: 'A smaller note.',
    });
    expect(edited.name).toBe('Welcome back, softer');
    expect(edited.status).toBe('proposed');
    expect(edited.approvedBy).toBeNull();
    const created = await api.campaigns.create({
      ...proposal,
      name: 'Friday',
      templateId: 'tpl_winback',
    });
    expect(created.status).toBe('proposed');
    expect(created.createdBy).toBe('user_owner');
    expect(created.estimatedReach).toBe(7);
    expect(created.segment).toEqual({ type: 'all' });
  });

  it('approves on the server when the cap is under autoApproveUnderMinor', async () => {
    const { api } = caller();
    await api.settings.update({ ...settingsInput, autoApproveUnderMinor: 50_000 });
    const under = await api.campaigns.create({
      ...proposal,
      name: 'Small',
      budgetCapMinor: 49_999,
    });
    expect(under.status).toBe('approved');
    expect(under.approvedBy).toBe('user_owner');
    expect(under.approvedAt).toEqual(expect.any(String));
    const atThreshold = await api.campaigns.create({
      ...proposal,
      name: 'At the line',
      budgetCapMinor: 50_000,
    });
    expect(atThreshold.status).toBe('proposed');
    expect(atThreshold.approvedBy).toBeNull();
  });

  it('refuses a fixed discount larger than the campaign budget', async () => {
    const { api } = caller();
    await expect(
      api.campaigns.create({
        ...proposal,
        name: 'Too much off',
        discountType: 'fixed',
        discountValue: 20_000,
        budgetCapMinor: 10_000,
      })
    ).rejects.toMatchObject({
      message: 'A fixed discount cannot be larger than the campaign budget.',
    });
    const saved = await api.campaigns.create({
      ...proposal,
      name: 'Fits',
      discountType: 'fixed',
      discountValue: 10_000,
      budgetCapMinor: 10_000,
    });
    expect(saved.discountValue).toBe(10_000);
    expect(saved.status).toBe('proposed');
  });

  it('returns no phone and no spend on the seeded proposal', async () => {
    const { api } = caller();
    const detail = await api.campaigns.get({ id: 'cmp_proposal' });
    expect(detail.campaign.estimatedReach).toBe(0);
    expect(detail.campaign.spentMinor).toBe(0);
    expect(detail.campaign.redemptionCount).toBe(0);
    expect(detail.recipients).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain('phone');
    expect(detail.preview).toMatch(/STOP/);
  });

  it('stores the Evolution key as ciphertext and refuses a host that is not allowlisted', async () => {
    const { api, organizationId } = caller();
    const saved = await api.settings.update({ ...settingsInput, waApiKey: 'new-secret-1234' });
    expect(saved.quietHoursStart).toBe(22);
    expect(saved.quietHoursEnd).toBe(8);
    expect(saved.waApiKeyHint).toBe('••••1234');
    expect(JSON.stringify(saved)).not.toContain('new-secret-1234');
    const stored = growthStore(organizationId).settings.waApiKeyEnc;
    expect(stored?.startsWith('v1.')).toBe(true);
    expect(stored).not.toContain('new-secret-1234');
    expect(decryptSecret(stored ?? '')).toBe('new-secret-1234');
    expect(JSON.stringify(await api.settings.get())).not.toContain('new-secret-1234');
    const kept = await api.settings.update({ ...settingsInput, waApiKey: undefined });
    expect(growthStore(organizationId).settings.waApiKeyEnc).toBe(stored);
    expect(kept.waApiKeyHint).toBe('••••1234');
    expect((await api.connection.status()).managerUrl).toBe('http://127.0.0.1:8080');
    await expect(
      api.settings.update({ ...settingsInput, waApiUrl: 'https://evil.example' })
    ).rejects.toMatchObject({ message: 'That Evolution host is not allowlisted.' });
    const cleared = await api.settings.update({ ...settingsInput, waInstanceName: null });
    expect(cleared.quietHoursStart).toBe(22);
    expect((await api.connection.status()).status).toBe('needs_pairing');
  });

  it('returns approved campaigns to proposed when their template changes', async () => {
    const { api, organizationId } = caller();
    await api.campaigns.approve({ id: 'cmp_proposal' });
    const scheduled = growthStore(organizationId).campaigns.find(
      (campaign) => campaign.id === 'cmp_proposal'
    );
    if (scheduled) {
      scheduled.status = 'scheduled';
      scheduled.approvedBy = 'user_owner';
      scheduled.approvedAt = '2026-10-20T00:00:00.000Z';
    }
    const other = await api.campaigns.create({
      ...proposal,
      name: 'Other template',
      templateId: 'tpl_winback',
    });
    await api.campaigns.approve({ id: other.id });
    await expect(
      api.templates.update({ id: 'tpl_generic', body: 'Salaam {{nope}}. Reply STOP to opt out.' })
    ).rejects.toMatchObject({ message: expect.stringMatching(/\{\{nope\}\}/) });
    expect((await api.campaigns.get({ id: 'cmp_proposal' })).campaign.status).toBe('scheduled');
    await expect(
      api.templates.update({ id: 'tpl_generic', body: 'Salaam {{name}}' })
    ).rejects.toMatchObject({ message: expect.stringMatching(/STOP/) });
    const next = 'Salaam {{name}}. Reply STOP to opt out.';
    await api.templates.update({ id: 'tpl_generic', body: next });
    const reset = (await api.campaigns.get({ id: 'cmp_proposal' })).campaign;
    expect(reset.status).toBe('proposed');
    expect(reset.approvedBy).toBeNull();
    expect(reset.approvedAt).toBeNull();
    expect((await api.campaigns.get({ id: other.id })).campaign.status).toBe('approved');
    expect(
      (await api.templates.list()).templates.find((template) => template.id === 'tpl_generic')?.body
    ).toBe(next);
  });

  it('denies a shop with the flag off and a cashier', async () => {
    mocks.enabled.mockResolvedValue(false);
    await expect(caller().api.campaigns.list()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Growth AI is off for this shop.',
    });
    mocks.enabled.mockResolvedValue(true);
    mocks.can.mockResolvedValue(false);
    await expect(caller().api.campaigns.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

it('computes reach from this session tenant and refreshes it when editing', async () => {
  const { api, organizationId, countAudience } = caller();
  const created = await api.campaigns.create(proposal);
  expect(created.estimatedReach).toBe(7);
  expect(countAudience).toHaveBeenCalledWith({
    where: { organizationId, whatsappOptIn: true, whatsappE164: { not: null } },
  });
  countAudience.mockResolvedValueOnce(3);
  expect((await api.campaigns.update({ ...proposal, id: created.id })).estimatedReach).toBe(3);
});
