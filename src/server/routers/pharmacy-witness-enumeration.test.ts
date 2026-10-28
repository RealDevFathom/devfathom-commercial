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
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        organizationId: 'org_a',
        organizationRole: { permissions: [{ capability, effect: 'ALLOW' }] },
        permissionOverrides: [],
      }),
    },
    restaurantStaffProfile: { findMany: vi.fn().mockResolvedValue([]) },
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
          f.caller.purchasing as unknown as { controlledWitnesses: () => Promise<unknown> }
        ).controlledWitnesses();
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
          userId: { not: 'actor' },
        }),
      })
    );
  });
});

it('allows a procurement receiver to select a controlled purchase witness', async () => {
  const f = fixture('pharmacy:procurement');
  await expect(f.purchasing.controlledWitnesses()).resolves.toEqual([]);
});
it('rejects an inactive database actor before witness enumeration', async () => {
  const f = fixture('pharmacy:safety');
  f.db.user.findUnique.mockResolvedValue(null);
  await expect(f.purchasing.controlledWitnesses()).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(f.db.restaurantStaffProfile.findMany).not.toHaveBeenCalled();
});
