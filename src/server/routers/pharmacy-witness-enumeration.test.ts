import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordTrpcAudit: vi.fn(),
}));
import { pharmacySafetyRouter } from './pharmacy-safety';
import { pharmacyPurchasingRouter } from './pharmacy-purchasing';
import { router, type TRPCContext } from '../trpc';
import { hasModule } from '@/lib/entitlements';
afterEach(() => vi.mocked(hasModule).mockReturnValue(true));
const app = router({ safety: pharmacySafetyRouter, purchasing: pharmacyPurchasingRouter });
function fixture(capability: string) {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: [{ capability, effect: 'ALLOW' }] },
        permissionOverrides: [],
      }),
    },
    restaurantStaffProfile: { findMany: vi.fn().mockResolvedValue([]) },
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
  return {
    db,
    caller: app.createCaller(ctx),
    purchasing: pharmacyPurchasingRouter.createCaller(ctx),
  };
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

function purchasingWitnesses(f: ReturnType<typeof fixture>) {
  return f.purchasing.controlledWitnesses({ branchId: 'branch', goodsReceiptId: 'receipt' });
}

it('allows a procurement receiver to select a controlled purchase witness', async () => {
  const f = fixture('pharmacy:procurement');
  await expect(purchasingWitnesses(f)).resolves.toEqual([]);
});
it('rejects an inactive database actor before witness enumeration', async () => {
  const f = fixture('pharmacy:safety');
  f.db.user.findUnique.mockResolvedValue(null);
  await expect(purchasingWitnesses(f)).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(f.db.restaurantStaffProfile.findMany).not.toHaveBeenCalled();
});

it('does not enumerate purchasing witnesses without the procurement module', async () => {
  const f = fixture('pharmacy:safety');
  vi.mocked(hasModule).mockReturnValue(false);
  await expect(purchasingWitnesses(f)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(f.db.restaurantStaffProfile.findMany).not.toHaveBeenCalled();
});
