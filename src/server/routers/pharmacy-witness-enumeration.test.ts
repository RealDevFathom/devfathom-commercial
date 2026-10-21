import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
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
const app = router({ safety: pharmacySafetyRouter, purchasing: pharmacyPurchasingRouter });
function fixture(capability: string) {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: [{ capability, effect: 'ALLOW' }] },
        permissionOverrides: [],
      }),
    },
    pharmacyGoodsReceipt: { findFirst: vi.fn().mockResolvedValue({ branchId: 'draft-branch' }) },
    restaurantStaffProfile: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const ctx = {
    db,
    entitlements: { organizationId: 'org', modules: [] },
    session: {
      user: { id: 'actor', organizationId: 'session-org', role: 'EMPLOYEE', status: 'ACTIVE' },
    },
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
            controlledWitnesses: (input: { goodsReceiptId: string }) => Promise<unknown>;
          }
        ).controlledWitnesses({ goodsReceiptId: 'draft' });
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
          user: expect.objectContaining({ organizationId: 'org', status: 'ACTIVE' }),
          userId: { not: 'actor' },
        }),
      })
    );
  });
});

it.each(['pharmacy:procurement', 'pharmacy.procurement'])(
  'allows purchasing witness lookup with %s without opening safety enumeration',
  async (capability) => {
    const f = fixture(capability);
    await expect(
      (
        f.caller.purchasing as unknown as {
          controlledWitnesses: (input: { goodsReceiptId: string }) => Promise<unknown>;
        }
      ).controlledWitnesses({ goodsReceiptId: 'draft' })
    ).resolves.toEqual([]);
    await expect(f.caller.safety.controlledPharmacists()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.restaurantStaffProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org' }) })
    );
  }
);

it('scopes purchasing witnesses to the tenant draft branch', async () => {
  const f = fixture('pharmacy:procurement');
  await (
    f.caller.purchasing as unknown as {
      controlledWitnesses: (input: { goodsReceiptId: string }) => Promise<unknown>;
    }
  ).controlledWitnesses({ goodsReceiptId: 'draft' });
  expect(f.db.pharmacyGoodsReceipt.findFirst).toHaveBeenCalledWith({
    where: { id: 'draft', organizationId: 'org' },
    select: { branchId: true },
  });
  expect(f.db.restaurantStaffProfile.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        user: expect.objectContaining({
          pharmacyBranchAssignments: {
            some: { organizationId: 'org', branchId: 'draft-branch', active: true },
          },
        }),
      }),
    })
  );
});
it('does not enumerate witnesses for a missing or foreign draft', async () => {
  const f = fixture('pharmacy:procurement');
  f.db.pharmacyGoodsReceipt.findFirst.mockResolvedValueOnce(null as never);
  await expect(
    (
      f.caller.purchasing as unknown as {
        controlledWitnesses: (input: { goodsReceiptId: string }) => Promise<unknown>;
      }
    ).controlledWitnesses({ goodsReceiptId: 'foreign' })
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(f.db.restaurantStaffProfile.findMany).not.toHaveBeenCalled();
});
