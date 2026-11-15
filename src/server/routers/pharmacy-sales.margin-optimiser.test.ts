import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(),
  withTenantDb: vi.fn(async (_organizationId, work) => work({ auditLog: { create: vi.fn() } })),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/lib/pharmacy/substitute-finder', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pharmacy/substitute-finder')>(
    '@/lib/pharmacy/substitute-finder'
  );
  return {
    ...actual,
    rankSameSaltBrandsByMargin: vi.fn(async () => []),
    suggestHigherMarginBrandMix: vi.fn(async () => []),
  };
});

import {
  rankSameSaltBrandsByMargin,
  suggestHigherMarginBrandMix,
} from '@/lib/pharmacy/substitute-finder';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

function caller(rules: { capability: string; effect: 'ALLOW' | 'DENY' }[]) {
  const db = {
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn(async () => ({ id: 'branch-1' })),
    },
    pharmacyBranchAssignment: { findMany: vi.fn(async () => [{ branchId: 'branch-1' }]) },
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: { permissions: rules },
        permissionOverrides: [],
      })),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return app.createCaller(context).pharmacySales;
}

const rankInput = {
  branchId: 'branch-1',
  medicineId: 'med-1',
  presentationId: 'pres-1',
  quantityCanonicalUnits: 10,
};

describe('#745 brand margin optimiser access', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses the cashier: margins and costs are never shown at the till', async () => {
    const cashier = caller([
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
      { capability: 'pharmacy:orders', effect: 'ALLOW' },
    ]);
    await expect(cashier.sameSaltMarginRanking(rankInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(cashier.higherMarginBrandMix({ branchId: 'branch-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(rankSameSaltBrandsByMargin).not.toHaveBeenCalled();
    expect(suggestHigherMarginBrandMix).not.toHaveBeenCalled();
  });

  it('serves the pharmacist the same-salt ranking for the scoped branch', async () => {
    await caller([{ capability: 'pharmacy:dispense', effect: 'ALLOW' }]).sameSaltMarginRanking(
      rankInput
    );
    expect(rankSameSaltBrandsByMargin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: 'org-1', branchId: 'branch-1' }),
      rankInput
    );
  });

  it('serves a solo owner (pharmacy:*) both views without a second person', async () => {
    const owner = caller([{ capability: 'pharmacy:*', effect: 'ALLOW' }]);
    await owner.sameSaltMarginRanking(rankInput);
    await owner.higherMarginBrandMix({ branchId: 'branch-1', minUnitMarginGainMinor: 5 });
    expect(rankSameSaltBrandsByMargin).toHaveBeenCalledTimes(1);
    expect(suggestHigherMarginBrandMix).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: 'org-1', branchId: 'branch-1' }),
      { minUnitMarginGainMinor: 5 }
    );
  });

  it('serves the buyer the purchasing brand-mix view but not the counter ranking', async () => {
    const buyer = caller([{ capability: 'pharmacy:procurement', effect: 'ALLOW' }]);
    await buyer.higherMarginBrandMix({ branchId: 'branch-1' });
    expect(suggestHigherMarginBrandMix).toHaveBeenCalledTimes(1);
    await expect(buyer.sameSaltMarginRanking(rankInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
