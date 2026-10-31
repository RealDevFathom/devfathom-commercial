import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from '../trpc';
const mocks = vi.hoisted(() => ({
  licensed: vi.fn(),
  entitlements: vi.fn(),
  actor: vi.fn(),
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
  reply: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
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
vi.mock('@/lib/pharmacy/business-profile', () => ({
  draftBusinessReviewReply: mocks.reply,
}));
import { pharmacyMarketingRouter } from './pharmacy-marketing';
function callerWithContext(role = 'ADMIN') {
  const transactionDb = {
    user: { findFirst: mocks.actor },
    $queryRaw: mocks.branchMatch,
    organization: { findUnique: mocks.organization },
    pharmacyBranch: { findFirst: mocks.branch },
  };
  const db = { ...transactionDb, $transaction: mocks.transaction };
  mocks.transaction.mockImplementation((fn) => fn(transactionDb));
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-crm'], modules: [] },
    organization: { id: 'org-a' },
    session: {
      expires: 'later',
      user: { id: 'owner-a', role, status: 'ACTIVE', organizationId: 'org-a' },
    },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { caller: pharmacyMarketingRouter.createCaller(context), context };
}
function caller(role = 'ADMIN') {
  return callerWithContext(role).caller;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.licensed.mockReturnValue(true);
  mocks.entitlements.mockResolvedValue({
    organizationId: 'org-a',
    enabledModules: ['pharmacy-crm'],
  });
  mocks.actor.mockResolvedValue({ id: 'owner-a' });
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
  mocks.reply.mockResolvedValue({
    available: true,
    draft: 'Thank you.',
    posted: false,
    approved: false,
  });
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
  it('authorizes and audits review drafting without retaining review text', async () => {
    mocks.settings.mockResolvedValue({ askFathomEnabled: true });
    const { caller: ownerCaller, context } = callerWithContext();
    await ownerCaller.draftReviewReply({ ...input, rating: 4, review: 'Helpful.', tone: 'WARM' });
    expect(mocks.reply).toHaveBeenCalledWith({ rating: 4, review: 'Helpful.', tone: 'WARM' });
    expect(context.audit.detail).toMatchObject({
      action: 'business_review_reply_draft',
      targetId: 'branch-a',
      skipInput: true,
      metadata: {
        providerAttempted: true,
        outcome: 'draft_generated',
        approved: false,
        posted: false,
      },
    });
    expect(JSON.stringify(context.audit.detail)).not.toContain('Helpful.');
  });
  it('denies nonowners and foreign branches before review provider use', async () => {
    mocks.settings.mockResolvedValue({ askFathomEnabled: true });
    const request = { ...input, rating: 2, review: 'Slow.', tone: 'FORMAL' as const };
    await expect(caller('STAFF').draftReviewReply(request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.branch.mockResolvedValue(null);
    await expect(caller().draftReviewReply(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.reply).not.toHaveBeenCalled();
  });
  it('records disabled AI without attempting review generation', async () => {
    mocks.settings.mockResolvedValue({ askFathomEnabled: false });
    const { caller: ownerCaller, context } = callerWithContext();
    await ownerCaller.draftReviewReply({ ...input, rating: 3, review: 'Okay.', tone: 'WARM' });
    expect(mocks.reply).not.toHaveBeenCalled();
    expect(context.audit.detail.metadata).toEqual({
      providerAttempted: false,
      outcome: 'disabled',
      approved: false,
      posted: false,
    });
  });
});

describe('growth current authorization', () => {
  const review = {
    branchId: 'branch-a',
    insightId: '00000000-0000-4000-8000-000000000001',
    recommendation: 0,
    decision: 'REJECT' as const,
  };
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
  it.each(['branch', 'actor', 'licence', 'lifecycle'] as const)(
    'rejects %s revocation during model latency',
    async (kind) => {
      mocks.settings.mockResolvedValue({ askFathomEnabled: true });
      mocks.growthBuild.mockResolvedValue({ facts: [] });
      mocks.growthGenerate.mockImplementation(async () => {
        if (kind === 'branch') mocks.branchMatch.mockResolvedValue([{ allowed: false }]);
        if (kind === 'actor') mocks.actor.mockResolvedValue(null);
        if (kind === 'licence') mocks.licensed.mockReturnValue(false);
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
