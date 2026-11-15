import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
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
import { hasModule } from '@/lib/entitlements';
afterEach(() => vi.mocked(hasModule).mockReturnValue(true));
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
      findMany: vi.fn().mockResolvedValue([]),
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
    session: { user: { id: 'actor', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org' } },
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

describe('purchasing reversal witness enumeration', () => {
  function query(f: ReturnType<typeof fixture>) {
    return (
      f.caller.purchasing as unknown as {
        controlledReversalWitnesses: (input: {
          branchId: string;
          goodsReceiptId: string;
        }) => Promise<unknown>;
      }
    ).controlledReversalWitnesses({ branchId: 'branch', goodsReceiptId: 'receipt' });
  }
  it.each(['pharmacy.counter', 'pharmacy:dispense'])(
    'denies %s without pharmacy:safety before enumerating PIN holders',
    async (capability) => {
      const f = fixture(capability);
      await expect(query(f)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.restaurantStaffProfile.findMany).not.toHaveBeenCalled();
    }
  );
  it('offers any other PIN-holding pharmacist, not only the original qualified person', async () => {
    const f = fixture('pharmacy:safety');
    f.db.pharmacyGoodsReceipt.findFirst.mockResolvedValueOnce({ id: 'receipt' });
    await expect(query(f)).resolves.toEqual([]);
    expect(f.db.pharmacyGoodsReceipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'receipt', organizationId: 'org', branchId: 'branch', status: 'POSTED' },
      })
    );
    expect(f.db.restaurantStaffProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org',
          user: { organizationId: 'org', status: 'ACTIVE' },
          userId: { not: 'actor' },
        }),
      })
    );
  });
  it('offers the sole pharmacist their own PIN profile, marked self', async () => {
    const f = fixture('pharmacy:safety');
    f.db.user.findUnique.mockResolvedValue({
      organizationRole: {
        permissions: [
          { capability: 'pharmacy:safety', effect: 'ALLOW' },
          { capability: 'pharmacy:dispense', effect: 'ALLOW' },
          { capability: 'pharmacy:procurement', effect: 'ALLOW' },
        ],
      },
      permissionOverrides: [],
    });
    f.db.pharmacyGoodsReceipt.findFirst.mockResolvedValueOnce({ id: 'receipt' });
    f.db.restaurantStaffProfile.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'own-profile',
        displayName: 'Owner',
        user: { id: 'actor', organizationId: 'org', status: 'ACTIVE' },
      },
    ]);
    await expect(query(f)).resolves.toEqual([{ id: 'own-profile', name: 'Owner', self: true }]);
    expect(f.db.restaurantStaffProfile.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'actor' }) })
    );
  });
  it('offers no self-witness while another pharmacist exists without a PIN', async () => {
    const f = fixture('pharmacy:safety');
    f.db.user.findUnique.mockResolvedValue({
      organizationRole: {
        permissions: [
          { capability: 'pharmacy:safety', effect: 'ALLOW' },
          { capability: 'pharmacy:dispense', effect: 'ALLOW' },
          { capability: 'pharmacy:procurement', effect: 'ALLOW' },
        ],
      },
      permissionOverrides: [],
    });
    f.db.user.findMany.mockResolvedValue([{ id: 'second-pharmacist', status: 'ACTIVE' }]);
    f.db.pharmacyGoodsReceipt.findFirst.mockResolvedValueOnce({ id: 'receipt' });
    await expect(query(f)).resolves.toEqual([]);
    expect(f.db.restaurantStaffProfile.findMany).toHaveBeenCalledTimes(1);
  });
  it('offers nobody when the receipt is not posted in this branch', async () => {
    const f = fixture('pharmacy:safety');
    f.db.pharmacyGoodsReceipt.findFirst.mockResolvedValueOnce(null);
    await expect(query(f)).resolves.toEqual([]);
    expect(f.db.restaurantStaffProfile.findMany).not.toHaveBeenCalled();
  });
});

function purchasingWitnesses(f: ReturnType<typeof fixture>) {
  return f.purchasing.controlledWitnesses({ branchId: 'branch', goodsReceiptId: 'receipt' });
}

it('requires clinical permission as well as procurement to select a controlled purchase witness', async () => {
  const f = fixture('pharmacy:procurement');
  await expect(purchasingWitnesses(f)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(f.db.restaurantStaffProfile.findMany).not.toHaveBeenCalled();
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
