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
  reviewReply: vi.fn(),
  capture: vi.fn(),
  audit: vi.fn(),
  freshTransaction: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(),
  withTenantDb: (organizationId: string, run: (db: unknown) => unknown) =>
    mocks.freshTransaction(organizationId, run),
}));
vi.mock('@/lib/pharmacy/review-reply-drafts', () => ({ draftReviewReply: mocks.reviewReply }));
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
import { pharmacyMarketingRouter } from './pharmacy-marketing';
import { WhatsAppComplianceError } from '@/lib/pharmacy/marketing-service';
import { lintWhatsAppMessage } from '@/lib/pharmacy/whatsapp/compliance-linter';
function caller(role = 'ADMIN') {
  const transactionDb = {
    user: { findFirst: mocks.actor, findUnique: mocks.permissions },
    $queryRaw: mocks.branchMatch,
    organization: { findUnique: mocks.organization },
    pharmacyBranch: { findFirst: mocks.branch },
    auditLog: { create: mocks.audit },
  };
  const db = { ...transactionDb, $transaction: mocks.transaction };
  mocks.transaction.mockImplementation((fn) => fn(transactionDb));
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
    audit: { detail: {} },
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
      await expect(caller(role).history(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('owner account is required'),
      });
      expect(mocks.organization).not.toHaveBeenCalled();
      expect(mocks.history).not.toHaveBeenCalled();
    }
  );
  it('denies the wrong package before reading data', async () => {
    mocks.licensed.mockReturnValue(false);
    await expect(caller().history(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('Pharmacy CRM license'),
    });
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
  it('logs a WhatsApp compliance block in a fresh transaction and refuses the request', async () => {
    mocks.freshTransaction.mockImplementation(async (_org, run) =>
      run({ auditLog: { create: mocks.audit } })
    );
    const result = lintWhatsAppMessage({ purpose: 'MARKETING', template: 'Panadol in stock' });
    mocks.capture.mockRejectedValue(
      new WhatsAppComplianceError(result, 'MARKETING_CAMPAIGN', 'campaign-a')
    );
    await expect(caller().capture({ ...input, campaignId: 'campaign-a' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('cannot name a medicine'),
    });
    // The request transaction rolls back; the log uses its own tenant transaction.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.freshTransaction).toHaveBeenCalledWith('org-a', expect.any(Function));
    expect(mocks.audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        actorId: 'owner-a',
        action: 'pharmacy.whatsappCompliance.blocked',
        targetType: 'MARKETING_CAMPAIGN',
        targetId: 'campaign-a',
        outcome: 'FAILURE',
        metadata: expect.objectContaining({
          branchId: 'branch-a',
          linterVersion: 'wa-compliance-lint-v1',
          outcome: 'BLOCK',
        }),
      }),
    });
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
  it.each([
    'branch',
    'actor',
    'licence',
    'lifecycle',
    'reports:financial',
    'reports:operational',
  ] as const)('rejects %s revocation during model latency', async (kind) => {
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
  });
});
describe('campaign generation and approval stay owner-only (DEV-31)', () => {
  const from = new Date('2026-10-01T00:00:00.000Z');
  const cutoff = new Date('2026-10-31T00:00:00.000Z');
  const insightId = '00000000-0000-4000-8000-000000000001';
  type Router = ReturnType<typeof caller>;
  const mutations: [string, (api: Router) => Promise<unknown>][] = [
    [
      'generateBaskets',
      (api) =>
        api.generateBaskets({
          ...input,
          from,
          cutoff,
          config: {
            minimumPairCount: 1,
            minimumSupport: 0.1,
            minimumConfidence: 0.1,
            minimumLift: 1,
            maximumProposals: 1,
          },
        }),
    ],
    [
      'reviewBasket',
      (api) => api.reviewBasket({ ...input, insightId, recommendation: 0, decision: 'APPROVE' }),
    ],
    ['generateGrowth', (api) => api.generateGrowth({ ...input, from, cutoff })],
    [
      'reviewGrowth',
      (api) => api.reviewGrowth({ ...input, insightId, recommendation: 0, decision: 'APPROVE' }),
    ],
    [
      'approveTemplate',
      (api) => api.approveTemplate({ ...input, name: 'Refill', body: 'Hello', reviewed: true }),
    ],
    ['approve', (api) => api.approve({ ...input, campaignId: 'campaign-a' })],
  ];
  it.each(
    mutations.flatMap(([name, run]) => ['EMPLOYEE', 'HR'].map((role) => ({ name, run, role })))
  )('$name refuses a $role member before reading data', async ({ run, role }) => {
    await expect(run(caller(role))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.organization).not.toHaveBeenCalled();
    expect(mocks.growthBuild).not.toHaveBeenCalled();
    expect(mocks.growthGenerate).not.toHaveBeenCalled();
    expect(mocks.growthReview).not.toHaveBeenCalled();
    expect(mocks.growthSave).not.toHaveBeenCalled();
  });
});

describe('marketing send policy procedures (DEV-24)', () => {
  const settings = {
    branchId: 'branch-a',
    weeklyMax: 1,
    monthlyMax: 2,
    quietStartHour: 22,
    quietEndHour: 9,
    blockRatePauseBps: 200,
    blockRateMinSample: 50,
  };
  it.each(['MANAGER', 'CASHIER', 'PHARMACIST'])(
    'refuses %s before reading, changing or resuming the policy',
    async (role) => {
      await expect(caller(role).sendPolicy(input)).rejects.toThrow('An owner account is required');
      await expect(caller(role).updateSendPolicy(settings)).rejects.toThrow(
        'An owner account is required'
      );
      await expect(caller(role).resumeSending(input)).rejects.toThrow(
        'An owner account is required'
      );
      expect(mocks.transaction).not.toHaveBeenCalled();
    }
  );
  it('rejects a weekly cap above the monthly cap before any transaction', async () => {
    await expect(caller().updateSendPolicy({ ...settings, weeklyMax: 3 })).rejects.toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('Google Business Profile health and review replies (DEV-13)', () => {
  const facts = {
    primaryCategoryIsPharmacy: true,
    phoneListed: true,
    websiteOrOrderLinkListed: false,
    descriptionPresent: true,
    holidayHoursSet: false,
    hoursConfirmedDaysAgo: 30,
    photoCount: 4,
    unansweredReviews: 2,
  };
  const config = { maximumHoursAgeDays: 90, minimumPhotos: 10, maximumUnansweredReviews: 0 };
  it.each(['STAFF', 'MANAGER', 'PHARMACIST'])('denies nonowner %s', async (role) => {
    await expect(caller(role).profileHealth({ ...input, facts, config })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller(role).reviewReply({ ...input, rating: 5, tone: 'FRIENDLY' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.reviewReply).not.toHaveBeenCalled();
  });
  it('evaluates owner-entered facts against the configured thresholds', async () => {
    const result = await caller().profileHealth({ ...input, facts, config });
    expect(result).toMatchObject({ passed: 4, total: 8, config });
  });
  it('drafts with the current AI policy and exposes no posting procedure', async () => {
    mocks.settings.mockResolvedValue({ askFathomEnabled: false });
    mocks.reviewReply.mockResolvedValue({ body: 'x', source: 'TEMPLATE', posted: false });
    await caller().reviewReply({ ...input, rating: 2, tone: 'FORMAL', reviewerFirstName: 'Sara' });
    expect(mocks.reviewReply).toHaveBeenCalledWith(
      { rating: 2, tone: 'FORMAL', reviewerFirstName: 'Sara' },
      { organizationId: 'org-a', branchId: 'branch-a', aiEnabled: false }
    );
    expect(Object.keys(pharmacyMarketingRouter._def.procedures)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/post|publish/i)])
    );
  });
  it('rejects review text or a foreign branch before drafting', async () => {
    await expect(
      caller().reviewReply({ ...input, rating: 5, tone: 'FRIENDLY', text: 'private' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    mocks.branch.mockResolvedValue(null);
    await expect(
      caller().reviewReply({ ...input, rating: 5, tone: 'FRIENDLY' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.reviewReply).not.toHaveBeenCalled();
  });
});
