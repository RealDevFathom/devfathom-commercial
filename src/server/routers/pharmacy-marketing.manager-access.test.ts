import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from '../trpc';

// Generating, reviewing and approving campaigns is a manager-or-owner action,
// enforced on the server for every call. A cashier is refused before any domain
// work runs; a manager and an owner reach the domain.
const mocks = vi.hoisted(() => ({
  permissions: vi.fn(),
  actor: vi.fn(),
  organization: vi.fn(),
  branch: vi.fn(),
  transaction: vi.fn(),
  generateBaskets: vi.fn(),
  reviewBasket: vi.fn(),
  growthBuild: vi.fn(),
  growthGenerate: vi.fn(),
  growthSave: vi.fn(),
  growthReview: vi.fn(),
  approveTemplate: vi.fn(),
  approveCampaign: vi.fn(),
  capture: vi.fn(),
  attribute: vi.fn(),
  sandbox: vi.fn(),
  sandboxDue: vi.fn(),
  tenantDb: { current: null as unknown },
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(),
  withTenantDb: (_org: string, run: (db: unknown) => unknown) => run(mocks.tenantDb.current),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: async () => ({
    organizationId: 'org-a',
    enabledModules: ['pharmacy-crm'],
  }),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/ai/ask-fathom-settings', () => ({
  readAskFathomSettings: async () => ({ askFathomEnabled: true }),
}));
vi.mock('@/lib/pharmacy/basket-workflow', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/basket-workflow')>(
    '@/lib/pharmacy/basket-workflow'
  )),
  generateBasketInsights: mocks.generateBaskets,
  reviewBasketInsight: mocks.reviewBasket,
}));
vi.mock('@/lib/pharmacy/growth-insights', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/growth-insights')>(
    '@/lib/pharmacy/growth-insights'
  )),
  buildPharmacyGrowthInput: mocks.growthBuild,
  saveGrowthInsight: mocks.growthSave,
  reviewGrowthInsight: mocks.growthReview,
}));
vi.mock('@/lib/ai/growth-recommendations', async () => ({
  ...(await vi.importActual<typeof import('@/lib/ai/growth-recommendations')>(
    '@/lib/ai/growth-recommendations'
  )),
  generateGrowthRecommendations: mocks.growthGenerate,
}));
vi.mock('@/lib/pharmacy/marketing-service', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/marketing-service')>(
    '@/lib/pharmacy/marketing-service'
  )),
  approveMarketingTemplate: mocks.approveTemplate,
  approveMarketingCampaign: mocks.approveCampaign,
  captureMarketingCampaign: mocks.capture,
}));
vi.mock('@/lib/pharmacy/marketing-attribution', () => ({
  generateMarketingAttribution: mocks.attribute,
}));
vi.mock('@/lib/pharmacy/marketing-delivery', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/marketing-delivery')>(
    '@/lib/pharmacy/marketing-delivery'
  )),
  dispatchSandboxCampaign: mocks.sandbox,
  dispatchDueSandboxCampaigns: mocks.sandboxDue,
}));

import { pharmacyMarketingRouter } from './pharmacy-marketing';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
type Persona = {
  role: 'ADMIN' | 'EMPLOYEE';
  organizationRole: { permissions: Rule[] } | null;
  overrides?: Rule[];
};
const allow = (...capabilities: string[]): Rule[] =>
  capabilities.map((capability) => ({ capability, effect: 'ALLOW' }));

// The seeded pharmacy templates (src/lib/vertical-catalog.ts).
const cashier: Persona = {
  role: 'EMPLOYEE',
  organizationRole: { permissions: allow('pharmacy:counter', 'pharmacy:orders') },
};
const cashierAdmin: Persona = { ...cashier, role: 'ADMIN' };
// Growth and basket snapshots also carry Finance evidence, so they keep their
// report gates; this manager has been given report access as well.
const manager: Persona = {
  role: 'EMPLOYEE',
  organizationRole: {
    permissions: allow('pharmacy:manage', 'pharmacy:orders', 'pharmacy:procurement'),
  },
  overrides: allow('reports:operational', 'reports:financial'),
};
const owner: Persona = {
  role: 'ADMIN',
  organizationRole: {
    permissions: allow('pharmacy:*', 'reports:operational', 'reports:financial'),
  },
};
/** A solo owner: tenant ADMIN with no organization role assigned. */
const soloOwner: Persona = { role: 'ADMIN', organizationRole: null };

function caller(persona: Persona) {
  mocks.permissions.mockResolvedValue({
    organizationRole: persona.organizationRole,
    permissionOverrides: persona.overrides ?? [],
  });
  mocks.actor.mockResolvedValue({ id: 'user-a', role: persona.role });
  const transactionDb = {
    user: { findFirst: mocks.actor, findUnique: mocks.permissions },
    $queryRaw: vi.fn().mockResolvedValue([{ allowed: true }]),
    organization: { findUnique: mocks.organization },
    pharmacyBranch: { findFirst: mocks.branch },
  };
  mocks.tenantDb.current = transactionDb;
  const db = { ...transactionDb, $transaction: mocks.transaction };
  mocks.transaction.mockImplementation((fn) => fn(transactionDb));
  return pharmacyMarketingRouter.createCaller({
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-crm'], modules: [] },
    organization: { id: 'org-a' },
    session: {
      expires: 'later',
      user: { id: 'user-a', role: persona.role, status: 'ACTIVE', organizationId: 'org-a' },
    },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const branchId = 'branch-a';
const insightId = '00000000-0000-4000-8000-000000000001';
const period = { branchId, from: new Date('2026-09-01'), cutoff: new Date('2026-10-01') };
type Caller = ReturnType<typeof caller>;
const calls: Array<[string, (c: Caller) => Promise<unknown>, () => ReturnType<typeof vi.fn>]> = [
  [
    'generateBaskets',
    (c) =>
      c.generateBaskets({
        ...period,
        config: {
          minimumPairCount: 2,
          minimumSupport: 0.3,
          minimumConfidence: 0.5,
          minimumLift: 1,
          maximumProposals: 3,
        },
      }),
    () => mocks.generateBaskets,
  ],
  [
    'reviewBasket',
    (c) => c.reviewBasket({ branchId, insightId, recommendation: 0, decision: 'REJECT' }),
    () => mocks.reviewBasket,
  ],
  ['generateGrowth', (c) => c.generateGrowth(period), () => mocks.growthSave],
  [
    'reviewGrowth',
    (c) => c.reviewGrowth({ branchId, insightId, recommendation: 0, decision: 'REJECT' }),
    () => mocks.growthReview,
  ],
  [
    'approveTemplate',
    (c) =>
      c.approveTemplate({
        branchId,
        name: 'Welcome',
        body: 'Welcome to our pharmacy. Reply STOP to opt out.',
        reviewed: true,
      }),
    () => mocks.approveTemplate,
  ],
  [
    'approve',
    (c) => c.approve({ branchId, campaignId: 'campaign-a' }),
    () => mocks.approveCampaign,
  ],
  ['capture', (c) => c.capture({ branchId, campaignId: 'campaign-a' }), () => mocks.capture],
  ['attributeReceipts', (c) => c.attributeReceipts(period), () => mocks.attribute],
  [
    'sandbox',
    (c) => c.sandbox({ branchId, campaignId: 'campaign-a', requestKey: 'req-1' }),
    () => mocks.sandbox,
  ],
  [
    'sandboxDue',
    (c) => c.sandboxDue({ branchId, requestKey: 'req-1', campaignIds: ['campaign-a'] }),
    () => mocks.sandboxDue,
  ],
];
// Calls without the Finance report gates, which a role-less solo owner reaches directly.
const nonReportCalls = calls.filter(
  ([name]) => !['generateBaskets', 'reviewBasket', 'generateGrowth', 'reviewGrowth'].includes(name)
);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.organization.mockResolvedValue({
    id: 'org-a',
    status: 'ACTIVE',
    vertical: 'PHARMACY',
    timezone: 'Asia/Karachi',
  });
  mocks.branch.mockResolvedValue({ id: branchId });
  mocks.generateBaskets.mockResolvedValue({ id: insightId });
  mocks.reviewBasket.mockResolvedValue({ campaignId: null, replay: false });
  mocks.growthBuild.mockResolvedValue({ facts: [] });
  mocks.growthGenerate.mockResolvedValue({ status: 'UNAVAILABLE' });
  mocks.growthSave.mockResolvedValue({ id: insightId });
  mocks.growthReview.mockResolvedValue({ ok: true });
  mocks.approveTemplate.mockResolvedValue({ id: 'template-a' });
  mocks.approveCampaign.mockResolvedValue({ id: 'campaign-a' });
  mocks.capture.mockResolvedValue({ prepared: 1 });
  mocks.attribute.mockResolvedValue({ attributed: 0 });
  // The dispatchers run their work through the router's transaction, which
  // re-resolves the actor and the manager-or-owner grant.
  mocks.sandbox.mockImplementation((transaction) => transaction(async () => ({ sent: 1 })));
  mocks.sandboxDue.mockImplementation((transaction) => transaction(async () => ({ sent: 1 })));
});

describe('pharmacy marketing: manager-or-owner gate', () => {
  it.each(calls)('%s refuses a cashier before any domain work', async (_name, run, domain) => {
    await expect(run(caller(cashier))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(domain()).not.toHaveBeenCalled();
    expect(mocks.organization).not.toHaveBeenCalled();
  });

  it.each(calls)(
    '%s refuses a tenant ADMIN assigned the cashier role',
    async (_name, run, domain) => {
      await expect(run(caller(cashierAdmin))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(domain()).not.toHaveBeenCalled();
    }
  );

  it.each(calls)(
    '%s refuses a manager whose pharmacy:manage is DENIED',
    async (_name, run, domain) => {
      await expect(
        run(
          caller({
            ...manager,
            overrides: [
              ...(manager.overrides ?? []),
              { capability: 'pharmacy:manage', effect: 'DENY' },
            ],
          })
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(domain()).not.toHaveBeenCalled();
    }
  );

  it.each(calls)('%s lets a manager through', async (_name, run, domain) => {
    await expect(run(caller(manager))).resolves.toBeDefined();
    expect(domain()).toHaveBeenCalledTimes(1);
  });

  it.each(calls)('%s lets an owner through', async (_name, run, domain) => {
    await expect(run(caller(owner))).resolves.toBeDefined();
    expect(domain()).toHaveBeenCalledTimes(1);
  });

  it.each(nonReportCalls)(
    '%s lets a solo owner with no role through',
    async (_name, run, domain) => {
      await expect(run(caller(soloOwner))).resolves.toBeDefined();
      expect(domain()).toHaveBeenCalledTimes(1);
    }
  );

  it('refuses a demotion to cashier during model latency before saving', async () => {
    const c = caller(manager);
    mocks.growthGenerate.mockImplementation(async () => {
      mocks.permissions.mockResolvedValue({
        organizationRole: cashier.organizationRole,
        permissionOverrides: [],
      });
      return { status: 'UNAVAILABLE' };
    });
    await expect(c.generateGrowth(period)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.growthSave).not.toHaveBeenCalled();
  });
});
