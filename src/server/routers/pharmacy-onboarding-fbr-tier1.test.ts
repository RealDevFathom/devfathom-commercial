import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  findFirst: vi.fn(),
  transaction: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  recordAudit: mocks.recordAudit,
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacyOnboardingRouter } from './pharmacy-onboarding';

const namespaced = router({ pharmacyOnboarding: pharmacyOnboardingRouter });
const answers = {
  chainOutlet: 'NO',
  airConditionedMallOrPlaza: 'NO',
  electricityBillRupees12Months: 300_000,
  bulkImportWholesaleAndRetail: 'NO',
  bankCardPos: 'NO',
  otherNotifiedCategory: 'NO',
  annualTurnoverRupees: 20_000_000,
} as const;

function context(licensed: boolean): TRPCContext {
  return {
    db: { auditLog: { findFirst: mocks.findFirst }, $transaction: mocks.transaction },
    entitlements: {
      organizationId: 'pharmacy-org',
      enabledModules: licensed ? ['pharmacy-core'] : [],
      modules: [{ key: 'pharmacy-core', name: 'Pharmacy', enabled: licensed }],
    },
    session: {
      expires: 'later',
      user: {
        id: 'admin',
        organizationId: 'pharmacy-org',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    },
    organization: { id: 'pharmacy-org' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.findFirst.mockResolvedValue(null);
});

describe.each([
  ['standalone server caller', (ctx: TRPCContext) => pharmacyOnboardingRouter.createCaller(ctx)],
  ['namespaced API caller', (ctx: TRPCContext) => namespaced.createCaller(ctx).pharmacyOnboarding],
] as const)('FBR Tier-1 %s', (_label, caller) => {
  it('refuses an admin without pharmacy-core before reading saved answers', async () => {
    await expect(caller(context(false)).fbrTier1Status()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'The Pharmacy module is not enabled for this organization.',
    });
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it('refuses an admin without pharmacy-core before writing an assessment', async () => {
    await expect(caller(context(false)).recordFbrTier1Check(answers)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it('still requires admin access when the module is licensed', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller(context(true)).fbrTier1Status()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it('allows a licensed admin to read only this tenant’s saved assessment', async () => {
    await expect(caller(context(true)).fbrTier1Status()).resolves.toMatchObject({
      latest: null,
      recheckDue: true,
    });
    expect(mocks.findFirst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: {
          organizationId: 'pharmacy-org',
          action: 'pharmacy.fbrTier1Check',
          targetType: 'FbrTier1SelfCheck',
          outcome: 'SUCCESS',
        },
      })
    );
  });

  it('returns Unsure for legacy wholesale Yes without rewriting its audit history', async () => {
    const legacy: Record<string, unknown> = { ...answers, wholesaleAndRetail: 'YES' };
    delete legacy.bulkImportWholesaleAndRetail;
    mocks.findFirst.mockResolvedValue({
      id: 'assessment',
      createdAt: new Date('2026-11-01T00:00:00Z'),
      actorName: 'Admin',
      input: legacy,
    });
    await expect(caller(context(true)).fbrTier1Status()).resolves.toMatchObject({
      latest: {
        answers: { bulkImportWholesaleAndRetail: 'UNSURE' },
        evaluation: { result: 'UNSURE' },
      },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
    expect(legacy.wholesaleAndRetail).toBe('YES');
  });

  it('requires the complete bulk-import answer on new assessments', async () => {
    const incomplete: Record<string, unknown> = { ...answers, wholesaleAndRetail: 'YES' };
    delete incomplete.bulkImportWholesaleAndRetail;
    await expect(
      caller(context(true)).recordFbrTier1Check(incomplete as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
