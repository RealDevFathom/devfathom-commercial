import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from '../trpc';
const mocks = vi.hoisted(() => ({
  licensed: vi.fn(),
  entitlements: vi.fn(),
  actor: vi.fn(),
  permissions: vi.fn(),
  branchMatch: vi.fn(),
  growthHistory: vi.fn(),
  growthReview: vi.fn(),
  growthBuild: vi.fn(),
  growthSave: vi.fn(),
  growthGenerate: vi.fn(),
  organization: vi.fn(),
  branch: vi.fn(),
  history: vi.fn(),
  transaction: vi.fn(),
  settings: vi.fn(),
  assist: vi.fn(),
  capture: vi.fn(),
  approve: vi.fn(),
  withTenantDb: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(),
  withTenantDb: mocks.withTenantDb,
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.licensed,
  resolveOrganizationEntitlements: mocks.entitlements,
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/ai/ask-fathom-settings', () => ({ readAskFathomSettings: mocks.settings }));
vi.mock('@/lib/pharmacy/marketing-assistance', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/marketing-assistance')>(
    '@/lib/pharmacy/marketing-assistance'
  )),
  draftMarketingCopy: mocks.assist,
}));
vi.mock('@/lib/pharmacy/marketing-service', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/marketing-service')>(
    '@/lib/pharmacy/marketing-service'
  )),
  marketingHistory: mocks.history,
  captureMarketingCampaign: mocks.capture,
  approveMarketingCampaign: mocks.approve,
}));
vi.mock('@/lib/pharmacy/growth-insights', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/growth-insights')>(
    '@/lib/pharmacy/growth-insights'
  )),
  listGrowthInsights: mocks.growthHistory,
  reviewGrowthInsight: mocks.growthReview,
  buildPharmacyGrowthInput: mocks.growthBuild,
  saveGrowthInsight: mocks.growthSave,
}));
vi.mock('@/lib/ai/growth-recommendations', async () => ({
  ...(await vi.importActual<typeof import('@/lib/ai/growth-recommendations')>(
    '@/lib/ai/growth-recommendations'
  )),
  generateGrowthRecommendations: mocks.growthGenerate,
}));
import { pharmacyMarketingRouter } from './pharmacy-marketing';
let audit: TRPCContext['audit'];
function caller(role = 'ADMIN') {
  const transactionDb = {
    user: { findFirst: mocks.actor, findUnique: mocks.permissions },
    $queryRaw: mocks.branchMatch,
    organization: { findUnique: mocks.organization },
    pharmacyBranch: { findFirst: mocks.branch },
  };
  const db = { ...transactionDb, $transaction: mocks.transaction };
  mocks.transaction.mockImplementation((fn) => fn(transactionDb));
  audit = { detail: {} };
  return pharmacyMarketingRouter.createCaller({
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-crm'], modules: [] },
    organization: { id: 'org-a' },
    session: {
      expires: 'later',
      user: { id: 'owner-a', role, status: 'ACTIVE', organizationId: 'org-a' },
    },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit,
  } as unknown as TRPCContext);
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.licensed.mockReturnValue(true);
  mocks.entitlements.mockResolvedValue({
    organizationId: 'org-a',
    enabledModules: ['pharmacy-crm'],
  });
  mocks.actor.mockResolvedValue({ id: 'owner-a' });
  mocks.permissions.mockResolvedValue({
    organizationRole: { permissions: [{ capability: '*', effect: 'ALLOW' }] },
    permissionOverrides: [],
  });
  mocks.branchMatch.mockResolvedValue([{ allowed: true }]);
  mocks.growthHistory.mockResolvedValue({ insights: [], reviews: [] });
  mocks.organization.mockResolvedValue({
    id: 'org-a',
    status: 'ACTIVE',
    vertical: 'PHARMACY',
    timezone: 'Asia/Karachi',
  });
  mocks.branch.mockResolvedValue({ id: 'branch-a' });
  mocks.history.mockResolvedValue({ campaigns: [] });
  mocks.capture.mockResolvedValue({ prepared: 1 });
  mocks.approve.mockResolvedValue({ status: 'APPROVED' });
});
const input = { branchId: 'branch-a' };
describe('marketing workflow authorization', () => {
  it('binds tenant, branch, actor, and timezone before a transaction', async () => {
    await caller().history(input);
    expect(mocks.branch).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: 'branch-a', active: true },
      select: { id: true },
    });
    expect(mocks.history).toHaveBeenCalledWith(expect.anything(), {
      organizationId: 'org-a',
      branchId: 'branch-a',
      actorId: 'owner-a',
      timezone: 'Asia/Karachi',
    });
  });
  it('binds UTC for a stored zone Intl refuses, so quiet hours and the page agree', async () => {
    mocks.organization.mockResolvedValue({
      id: 'org-a',
      status: 'ACTIVE',
      vertical: 'PHARMACY',
      timezone: 'PKT',
    });
    await caller().history(input);
    expect(mocks.history).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timezone: 'UTC' })
    );
  });
  it.each(['STAFF', 'MANAGER', 'PHARMACIST'])(
    'denies nonowner %s before reading data',
    async (role) => {
      await expect(caller(role).history(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.organization).not.toHaveBeenCalled();
      expect(mocks.history).not.toHaveBeenCalled();
    }
  );
  it('denies the wrong package before reading data', async () => {
    mocks.licensed.mockReturnValue(false);
    await expect(caller().history(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.organization).not.toHaveBeenCalled();
  });
  it('denies a foreign or inactive branch before mutation', async () => {
    mocks.branch.mockResolvedValue(null);
    await expect(caller().capture({ ...input, campaignId: 'campaign-a' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'SUSPENDED', vertical: 'PHARMACY' },
    { status: 'ACTIVE', vertical: 'AGENCY' },
  ])('denies unavailable organization %j', async (organization) => {
    mocks.organization.mockResolvedValue({ id: 'org-a', ...organization });
    await expect(caller().history(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it('uses the transaction client for atomic capture', async () => {
    await caller().capture({ ...input, campaignId: 'campaign-a' });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: 'org-a' }),
      'campaign-a'
    );
  });
  it('passes the PIN to owner approval while keeping it out of audit input', async () => {
    await caller().approve({ ...input, campaignId: 'campaign-a', pin: '4821' });
    expect(mocks.approve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorId: 'owner-a' }),
      'campaign-a',
      expect.any(Date),
      '4821',
      expect.any(Function)
    );
    expect(audit.detail).toMatchObject({
      action: 'pharmacy_marketing_approval',
      targetId: 'campaign-a',
      skipInput: true,
    });
    expect(JSON.stringify(audit.detail)).not.toContain('4821');
  });
  it('rejects a refused PIN as FORBIDDEN with the campaign audit target', async () => {
    const api = caller();
    let committed = false;
    mocks.transaction.mockImplementation(async (fn) => {
      const result = await fn({});
      committed = true;
      return result;
    });
    mocks.approve.mockResolvedValue({
      blocked: 'Enter your owner PIN to approve monetary vouchers.',
    });
    await expect(
      api.approve({ ...input, campaignId: 'campaign-a', pin: '4822' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(committed).toBe(true);
    expect(audit.detail).toMatchObject({ targetId: 'campaign-a', skipInput: true });
  });
  it('keeps failed PIN attempts committed when the request transaction rolls back', async () => {
    const api = caller();
    const credentialWrites: unknown[] = [];
    const committedWrites: unknown[] = [];
    // The request transaction discards its writes when the procedure refuses.
    mocks.transaction.mockImplementation(async (fn) => {
      const requestWrites: unknown[] = [];
      try {
        return await fn({ requestWrites });
      } finally {
        requestWrites.length = 0;
      }
    });
    // An independent tenant transaction commits as soon as its callback resolves.
    mocks.withTenantDb.mockImplementation(async (_organizationId, run) => {
      const result = await run({ credentialWrites });
      committedWrites.push(...credentialWrites);
      return result;
    });
    mocks.approve.mockImplementation(
      async (_db, _scope, _campaignId, _now, _pin, credentialTransaction) => {
        await credentialTransaction(async (db: { credentialWrites: unknown[] }) =>
          db.credentialWrites.push({ failedAttempts: 1 })
        );
        return { blocked: 'Enter your owner PIN to approve monetary vouchers.' };
      }
    );
    await expect(
      api.approve({ ...input, campaignId: 'campaign-a', pin: '4822' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.withTenantDb).toHaveBeenCalledWith('org-a', expect.any(Function), {
      userId: 'owner-a',
      skipDrain: true,
      maxWait: 5_000,
      timeout: 10_000,
    });
    expect(committedWrites).toEqual([{ failedAttempts: 1 }]);
    expect(JSON.stringify(audit.detail)).not.toContain('4822');
  });
  it('redacts a malformed PIN before input validation refuses it', async () => {
    await expect(
      caller().approve({ ...input, campaignId: 'campaign-a', pin: 'invalid-secret' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(audit.detail.skipInput).toBe(true);
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it('honors current AI-off policy without calling the provider', async () => {
    mocks.settings.mockResolvedValue({ askFathomEnabled: false });
    expect(await caller().assist({ ...input, occasion: 'WELCOME', tone: 'FRIENDLY' })).toEqual({
      available: false,
      body: null,
      approved: false,
    });
    expect(mocks.assist).not.toHaveBeenCalled();
  });
  it('passes server-authorized tenant attribution separately from the allowed AI input', async () => {
    mocks.settings.mockResolvedValue({ askFathomEnabled: true });
    await caller().assist({ ...input, occasion: 'WELCOME', tone: 'FRIENDLY' });
    expect(mocks.assist).toHaveBeenCalledWith(
      { occasion: 'WELCOME', tone: 'FRIENDLY' },
      { organizationId: 'org-a', branchId: 'branch-a' }
    );
  });
});

describe('growth current authorization', () => {
  const review = {
    branchId: 'branch-a',
    insightId: '00000000-0000-4000-8000-000000000001',
    recommendation: 0,
    decision: 'REJECT' as const,
  };
  it.each(['reports:financial', 'reports:operational'])(
    'honors an explicit %s DENY for generation, saved snapshots and review',
    async (capability) => {
      for (const source of ['role', 'override']) {
        const deny = { capability, effect: 'DENY' };
        mocks.permissions.mockResolvedValue({
          organizationRole: {
            permissions: [
              { capability: '*', effect: 'ALLOW' },
              ...(source === 'role' ? [deny] : []),
            ],
          },
          permissionOverrides: source === 'override' ? [deny] : [],
        });
        await expect(
          caller().generateGrowth({
            ...input,
            from: new Date('2026-09-01'),
            cutoff: new Date('2026-10-01'),
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(caller().growthHistory(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(caller().reviewGrowth(review)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(mocks.settings).not.toHaveBeenCalled();
      expect(mocks.growthBuild).not.toHaveBeenCalled();
      expect(mocks.growthGenerate).not.toHaveBeenCalled();
      expect(mocks.growthSave).not.toHaveBeenCalled();
      expect(mocks.growthHistory).not.toHaveBeenCalled();
      expect(mocks.growthReview).not.toHaveBeenCalled();
    }
  );
  it('requires report grants even for an ADMIN without explicit DENY rules', async () => {
    mocks.permissions.mockResolvedValue({ organizationRole: null, permissionOverrides: [] });
    await expect(caller().growthHistory(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.growthHistory).not.toHaveBeenCalled();
  });
  it.each(['branch', 'actor', 'licence', 'lifecycle'] as const)(
    'denies current %s revocation before review writes',
    async (kind) => {
      if (kind === 'branch') mocks.branchMatch.mockResolvedValue([{ allowed: false }]);
      if (kind === 'actor') mocks.actor.mockResolvedValue(null);
      if (kind === 'licence') mocks.licensed.mockReturnValue(false);
      if (kind === 'lifecycle')
        mocks.organization.mockResolvedValue({
          id: 'org-a',
          vertical: 'PHARMACY',
          status: 'SUSPENDED',
        });
      await expect(caller().reviewGrowth(review)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.growthReview).not.toHaveBeenCalled();
    }
  );
  it('re-resolves licence inside the transaction', async () => {
    await caller().growthHistory(input);
    const transactionDb = mocks.entitlements.mock.calls[0][1];
    expect(transactionDb).not.toHaveProperty('$transaction');
    expect(mocks.growthHistory.mock.calls[0][0]).toBe(transactionDb);
    expect(transactionDb.user.findUnique).toBe(mocks.permissions);
    expect(mocks.permissions).toHaveBeenCalledTimes(2);
    expect(mocks.actor).toHaveBeenCalledWith({
      where: { id: 'owner-a', organizationId: 'org-a', role: 'ADMIN', status: 'ACTIVE' },
      select: { id: true },
    });
    expect(mocks.entitlements).toHaveBeenCalledWith(
      'org-a',
      expect.objectContaining({ user: expect.anything() })
    );
    expect(mocks.growthHistory).toHaveBeenCalledTimes(1);
  });
  it.each(['branch', 'actor', 'licence', 'lifecycle', 'reports:financial', 'reports:operational'] as const)(
    'rejects %s revocation during model latency',
    async (kind) => {
      mocks.settings.mockResolvedValue({ askFathomEnabled: true });
      mocks.growthBuild.mockResolvedValue({ facts: [] });
      mocks.growthGenerate.mockImplementation(async () => {
        if (kind === 'branch') mocks.branchMatch.mockResolvedValue([{ allowed: false }]);
        if (kind === 'actor') mocks.actor.mockResolvedValue(null);
        if (kind === 'licence') mocks.licensed.mockReturnValue(false);
        if (kind === 'reports:financial' || kind === 'reports:operational')
          mocks.permissions.mockResolvedValue({
            organizationRole: { permissions: [{ capability: '*', effect: 'ALLOW' }] },
            permissionOverrides: [{ capability: kind, effect: 'DENY' }],
          });
        if (kind === 'lifecycle')
          mocks.organization.mockResolvedValue({
            id: 'org-a',
            vertical: 'PHARMACY',
            status: 'SUSPENDED',
          });
        return { status: 'UNAVAILABLE' };
      });
      await expect(
        caller().generateGrowth({
          ...input,
          from: new Date('2026-09-01'),
          cutoff: new Date('2026-10-01'),
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.growthGenerate).toHaveBeenCalledTimes(1);
      expect(mocks.growthSave).not.toHaveBeenCalled();
    }
  );
});
