import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordTrpcAudit: vi.fn(),
}));

import { pharmacyPurchasingRouter } from './pharmacy-purchasing';
import { router, type TRPCContext } from '../trpc';

const app = router({ pharmacyPurchasing: pharmacyPurchasingRouter });
type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const allow = (capability: string): Rule => ({ capability, effect: 'ALLOW' });
const deny = (capability: string): Rule => ({ capability, effect: 'DENY' });

function fixture(permissions: Rule[], overrides: Rule[] = [], licensed = true) {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions },
        permissionOverrides: overrides,
      }),
    },
    pharmacySupplier: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'supplier' }),
    },
  };
  const caller = app.createCaller({
    db,
    entitlements: {
      organizationId: 'org',
      enabledModules: licensed ? ['pharmacy-procurement'] : [],
      modules: [],
    },
    session: {
      user: { id: 'operator', organizationId: 'org', role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacyPurchasing as ReturnType<
    typeof pharmacyPurchasingRouter.createCaller
  >;
  return { caller, db };
}

// These reads serve clinical witnesses and financial reports with their own existing guards.
const separatelyAuthorized = new Set(['controlledWitnesses', 'purchaseReturns', 'supplierCredits']);
const procurementEndpoints = Object.keys(pharmacyPurchasingRouter._def.procedures).filter(
  (name) => !separatelyAuthorized.has(name)
);

describe('Purchasing server authorization', () => {
  it.each(procurementEndpoints)('denies a cashier calling %s directly', async (endpoint) => {
    const { caller, db } = fixture([allow('pharmacy:counter'), allow('pharmacy:orders')]);
    const invoke = caller[endpoint as keyof typeof caller] as (input?: unknown) => Promise<unknown>;
    // Authorization must run before input parsing or any business-data access.
    await expect(invoke()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacySupplier.findMany).not.toHaveBeenCalled();
    expect(db.pharmacySupplier.create).not.toHaveBeenCalled();
  });

  it.each(['pharmacy:procurement', 'pharmacy:*'])(
    'preserves supplier reads and writes with %s',
    async (capability) => {
      const { caller, db } = fixture([allow(capability)]);
      await expect(caller.suppliers()).resolves.toEqual([]);
      await expect(caller.createSupplier({ name: 'Supplier' })).resolves.toEqual({
        id: 'supplier',
      });
      expect(db.pharmacySupplier.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: 'org', active: true } })
      );
      expect(db.pharmacySupplier.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'Supplier' }) })
      );
    }
  );

  it.each([
    { permissions: [allow('pharmacy:*')], overrides: [deny('pharmacy:procurement')] },
    { permissions: [deny('pharmacy:procurement')], overrides: [allow('pharmacy:procurement')] },
  ])('honors procurement DENY precedence: %j', async ({ permissions, overrides }) => {
    const { caller, db } = fixture(permissions, overrides);
    await expect(caller.suppliers()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.createSupplier({ name: 'Supplier' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacySupplier.findMany).not.toHaveBeenCalled();
    expect(db.pharmacySupplier.create).not.toHaveBeenCalled();
  });

  it('keeps the procurement module license required for an authorized operator', async () => {
    const { caller, db } = fixture([allow('pharmacy:procurement')], [], false);
    await expect(caller.suppliers()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacySupplier.findMany).not.toHaveBeenCalled();
  });
});
