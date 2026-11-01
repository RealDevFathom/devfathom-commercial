import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordTrpcAudit: vi.fn(),
}));
import { pharmacySafetyRouter } from './pharmacy-safety';
import { pharmacyPurchasingRouter } from './pharmacy-purchasing';
import { router, type TRPCContext } from '../trpc';
const app = router({ safety: pharmacySafetyRouter, purchasing: pharmacyPurchasingRouter });
function fixture(capability: string) {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: {
          // PR J: the purchasing lookup sits behind the Goods-in procurement
          // permission and the branch assignment; the witness rule is unchanged.
          permissions: [
            { capability, effect: 'ALLOW' },
            { capability: 'pharmacy:procurement', effect: 'ALLOW' },
          ],
        },
        permissionOverrides: [],
      }),
    },
    restaurantStaffProfile: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch' }) },
    pharmacyBranchAssignment: { findFirst: vi.fn().mockResolvedValue({ id: 'assignment' }) },
    pharmacyGoodsReceipt: {
      findFirst: vi.fn().mockResolvedValue({ qualifiedPersonUserId: 'qualified-person' }),
    },
  };
  const ctx = {
    db,
    entitlements: { organizationId: 'org', modules: [] },
    session: { user: { id: 'actor', role: 'EMPLOYEE', status: 'ACTIVE' } },
    requestMeta: { ip: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: app.createCaller(ctx) };
}
describe.each(['safety', 'purchasing'] as const)('%s witness enumeration', (surface) => {
  function query(f: ReturnType<typeof fixture>) {
    return surface === 'safety'
      ? f.caller.safety.controlledPharmacists()
      : (
          f.caller.purchasing as unknown as {
            controlledWitnesses: (input: {
              branchId: string;
              goodsReceiptId: string;
            }) => Promise<unknown>;
          }
        ).controlledWitnesses({ branchId: 'branch', goodsReceiptId: 'receipt' });
  }
  it('denies a cashier before enumerating PIN holders', async () => {
    const f = fixture('pharmacy.counter');
    await expect(query(f)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.restaurantStaffProfile.findMany).not.toHaveBeenCalled();
  });
  it.each(['pharmacy:safety', 'pharmacy:dispense'])('allows %s', async (capability) => {
    const f = fixture(capability);
    await expect(query(f)).resolves.toEqual([]);
    expect(f.db.restaurantStaffProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org',
          user: { organizationId: 'org', status: 'ACTIVE' },
          userId: surface === 'purchasing' ? 'qualified-person' : { not: 'actor' },
        }),
      })
    );
  });

  if (surface === 'purchasing') {
    it('offers nobody when the receipt has no different named qualified person', async () => {
      const f = fixture('pharmacy:dispense');
      f.db.pharmacyGoodsReceipt.findFirst.mockResolvedValueOnce({ qualifiedPersonUserId: 'actor' });

      await expect(query(f)).resolves.toEqual([]);
      expect(f.db.restaurantStaffProfile.findMany).not.toHaveBeenCalled();
    });
  }
});
