import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const input = {
  branchId: 'branch-a',
  medicineId: 'medicine-a',
  presentationId: 'presentation-a',
  quantityCanonicalUnits: 10,
};

function fixture(capabilities: string[], branches = ['branch-a']) {
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        organizationRole: {
          permissions: capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
        },
        permissionOverrides: [],
      })),
    },
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => branches.includes(id)).map((id) => ({ id }))
      ),
    },
    medicine: {
      findFirst: vi.fn(async () => ({
        id: 'medicine-a',
        strengths: [],
        presentations: [{ id: 'presentation-a', dosageForm: 'Tablet', route: 'Oral' }],
      })),
    },
    pharmacyInventoryLot: { findMany: vi.fn(async () => []) },
  };
  const caller = app.createCaller({
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user-a', role: 'MEMBER', status: 'ACTIVE', organizationId: 'org-a' },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySales;
  return { caller, db };
}

describe('#745 margin optimizer commercial-data boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a dispenser who lacks pharmacy:procurement before reading costs', async () => {
    const { caller, db } = fixture(['pharmacy:dispense']);
    await expect(caller.marginOptimizedBrandProposals(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
    expect(db.medicine.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyInventoryLot.findMany).not.toHaveBeenCalled();
  });

  it('rejects a foreign branch before reading any lot cost', async () => {
    const { caller, db } = fixture(['pharmacy:procurement'], []);
    await expect(caller.marginOptimizedBrandProposals(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(db.medicine.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyInventoryLot.findMany).not.toHaveBeenCalled();
  });

  it('keeps the solo-owner pharmacy wildcard able to use the read-only optimizer', async () => {
    const { caller, db } = fixture(['pharmacy:*']);
    await expect(caller.marginOptimizedBrandProposals(input)).resolves.toEqual([]);
    expect(db.pharmacyInventoryLot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-a', branchId: 'branch-a' }),
      })
    );
  });
});
