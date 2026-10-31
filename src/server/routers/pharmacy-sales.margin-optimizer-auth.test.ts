import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn((view: { enabledModules: string[] }, key: string) =>
    view.enabledModules.includes(key)
  ),
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

function fixture(
  capabilities: string[],
  branches = ['branch-a'],
  enabledModules = ['pharmacy-counter', 'pharmacy-procurement']
) {
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
        strengths: [{ ingredientId: 'ingredient-a', value: '500', unit: 'mg' }],
        presentations: [{ id: 'presentation-a', dosageForm: 'Tablet', route: 'Oral' }],
      })),
    },
    pharmacyInventoryLot: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => [{ branch: '' }]),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(db)),
  };
  const caller = app.createCaller({
    db,
    entitlements: { organizationId: 'org-a', enabledModules, modules: [] },
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

  it.each(['pharmacy:procurement', 'pharmacy:*'])(
    'rejects a Counter-only licence even with %s permission',
    async (capability) => {
      const { caller, db } = fixture([capability], ['branch-a'], ['pharmacy-counter']);
      await expect(caller.marginOptimizedBrandProposals(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'The pharmacy-procurement module is not enabled for this organization.',
      });
      expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
      expect(db.medicine.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacyInventoryLot.findMany).not.toHaveBeenCalled();
    }
  );

  it('rejects a foreign branch before reading any lot cost', async () => {
    const { caller, db } = fixture(['pharmacy:procurement'], []);
    await expect(caller.marginOptimizedBrandProposals(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(db.medicine.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyInventoryLot.findMany).not.toHaveBeenCalled();
  });

  it.each(['pharmacy:procurement', 'pharmacy:*'])(
    'allows the licensed read-only optimizer with %s permission, including the solo owner',
    async (capability) => {
      const { caller, db } = fixture([capability]);
      await expect(caller.marginOptimizedBrandProposals(input)).resolves.toEqual([]);
      expect(db.pharmacyInventoryLot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organizationId: 'org-a', branchId: 'branch-a' }),
        })
      );
    }
  );
});
