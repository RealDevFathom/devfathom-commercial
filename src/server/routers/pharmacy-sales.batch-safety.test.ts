import { beforeEach, describe, expect, it, vi } from 'vitest';

// #633: a batch recalled, quarantined or expired after add-to-cart refuses the tender in a
// transaction that rolls back. The router must say so as a typed FORBIDDEN carrying the
// reason (the counter's sentence key), never a 500 the counter would read as an unknown
// payment outcome.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
const loyalty = vi.hoisted(() => ({ redeemSalePoints: vi.fn() }));
vi.mock('@/lib/pharmacy/customer-loyalty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/customer-loyalty')>()),
  redeemSalePoints: loyalty.redeemSalePoints,
}));

import { PharmacySaleBatchError } from '@/lib/pharmacy/sale-batch-safety';
import { PharmacyLoyaltyError } from '@/lib/pharmacy/customer-loyalty';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const BRANCH = 'branch-1';

function caller(granted = true) {
  const db = {
    $transaction: vi.fn(
      async (callback: (tx: unknown) => unknown): Promise<unknown> => callback(db)
    ),
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    user: {
      findUnique: vi.fn(async () => ({
        organizationRole: {
          permissions: [{ capability: 'pharmacy:dispense', effect: granted ? 'ALLOW' : 'DENY' }],
        },
        permissionOverrides: [],
      })),
    },
  };
  return app.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'cashier-1', role: 'MEMBER', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySales;
}

beforeEach(() => loyalty.redeemSalePoints.mockReset());

describe('#633 batch refusal at tender', () => {
  it('keeps missing loyalty consent as a forbidden redemption', async () => {
    loyalty.redeemSalePoints.mockRejectedValueOnce(
      new PharmacyLoyaltyError('LOYALTY_CONSENT_REQUIRED')
    );

    await expect(
      caller().redeemPoints({
        branchId: BRANCH,
        saleId: 'sale-1',
        points: 200,
        deviceId: 'device-1',
        businessDate: new Date('2026-10-22T00:00:00.000Z'),
        idempotencyKey: 'redeem-without-consent',
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'LOYALTY_CONSENT_REQUIRED',
    });
  });

  it('forbids loyalty redemption when an active branch user is denied dispense', async () => {
    await expect(
      caller(false).redeemPoints({
        branchId: BRANCH,
        saleId: 'sale-1',
        points: 200,
        deviceId: 'device-1',
        businessDate: new Date('2026-10-22T00:00:00.000Z'),
        idempotencyKey: 'redeem-denied',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(loyalty.redeemSalePoints).not.toHaveBeenCalled();
  });

  it.each([
    ['SALE_BATCH_RECALLED', 'RECALLED'],
    ['SALE_BATCH_QUARANTINED', 'QUARANTINED'],
    ['SALE_BATCH_EXPIRED', 'EXPIRED'],
  ] as const)('answers %s as a typed FORBIDDEN', async (reason, blockReason) => {
    loyalty.redeemSalePoints.mockRejectedValueOnce(
      new PharmacySaleBatchError(reason, blockReason, 'line-1', 'lot-1')
    );
    await expect(
      caller().redeemPoints({
        branchId: BRANCH,
        saleId: 'sale-1',
        points: 200,
        deviceId: 'device-1',
        businessDate: new Date('2026-10-22T00:00:00.000Z'),
        idempotencyKey: 'redeem-1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: reason });
  });
});
