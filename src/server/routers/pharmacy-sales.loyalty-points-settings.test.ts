import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/lib/abac', () => ({
  can: vi.fn(),
  subjectFromSession: (user: unknown) => user,
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { can } from '@/lib/abac';
import { annotateAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const input = {
  medicineEarnPoints: 1,
  nonDrugEarnPoints: 3,
  earnBlockMinor: 10_000,
  pointValueMinor: 100,
  minimumRedemptionPoints: 200,
  pointsExpiryMonths: 6,
  goldTierEnabled: false,
  goldTierThresholdMinor: 5_000_000,
  goldTierMultiplier: 2,
};

function fixture() {
  const tx = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ organizationId: 'org-a', medicineEarnPoints: 2 }])
      .mockResolvedValueOnce([{ organizationId: 'org-a', ...input }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  const db = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: [], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'owner-a', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org-a' },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: '127.0.0.1', userAgent: null },
    audit: { detail: {} },
  };
  return {
    db,
    tx,
    context,
    caller: app.createCaller(context as unknown as TRPCContext).pharmacySales,
  };
}

describe('pharmacy points policy authorization and audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('honors central can() denial before any policy or audit write', async () => {
    vi.mocked(can).mockResolvedValue(false);
    const { caller, db, context } = fixture();

    await expect(caller.updateLoyaltyPointsSettings(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(can).toHaveBeenCalledWith(
      context.session.user,
      'pharmacy:loyalty-manage',
      undefined,
      expect.objectContaining({ db: context.db, source: 'TRPC' })
    );
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(annotateAudit).not.toHaveBeenCalled();
  });

  it('records the tenant policy change and its application audit entry', async () => {
    vi.mocked(can).mockResolvedValue(true);
    const { caller, tx, context } = fixture();

    await expect(caller.updateLoyaltyPointsSettings(input)).resolves.toEqual(input);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(annotateAudit).toHaveBeenCalledWith(context, {
      action: 'pharmacy.loyalty.points-settings.update',
      targetId: 'org-a',
    });
  });
});
