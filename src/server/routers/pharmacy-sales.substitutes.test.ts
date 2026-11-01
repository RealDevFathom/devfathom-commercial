import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/pharmacy/sales', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/sales')>()),
  addSaleLine: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/substitute-finder', () => ({
  findSubstituteProposals: vi.fn(async () => []),
  declineSubstitute: vi.fn(),
  PharmacySubstituteError: class PharmacySubstituteError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

import { addSaleLine } from '@/lib/pharmacy/sales';
import { findSubstituteProposals } from '@/lib/pharmacy/substitute-finder';
import type { TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const input = {
  branchId: 'branch-1',
  medicineId: 'medicine-1',
  presentationId: 'presentation-1',
  quantityCanonicalUnits: 10,
};

function caller(
  branch: { id: string } | null,
  options?: {
    role?: 'EMPLOYEE' | 'ADMIN';
    assignedBranchIds?: string[];
    capability?: string;
    denyDispense?: boolean;
  }
) {
  const assignedBranchIds = options?.assignedBranchIds ?? (branch ? [branch.id] : []);
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: {
          permissions: [{ capability: options?.capability ?? 'pharmacy:dispense', effect: 'ALLOW' }],
        },
        permissionOverrides: options?.denyDispense
          ? [{ capability: 'pharmacy:dispense', effect: 'DENY' }]
          : [],
      })),
    },
    pharmacyBranch: {
      findFirst: vi.fn(async () => branch),
      findMany: vi.fn(async () => [{ id: 'branch-1' }]),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => assignedBranchIds.map((branchId) => ({ branchId }))),
    },
  };
  Object.assign(db, {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
    medicine: { findFirst: vi.fn(async () => ({ controlled: false })) },
    auditLog: { create: vi.fn() },
  });
  return pharmacySalesRouter.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'actor-1',
        role: options?.role ?? 'EMPLOYEE',
        status: 'ACTIVE',
        organizationId: 'org-1',
      },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('substitute proposals', () => {
  it('enforces substitute authorization at addLine even after listing an override', async () => {
    vi.mocked(findSubstituteProposals).mockResolvedValue([]);
    vi.mocked(addSaleLine).mockResolvedValue({
      line: {
        id: 'line-1',
        saleId: 'sale-1',
        medicineId: 'alternate',
        presentationId: 'alternate-p',
        packLevelId: 'pack-1',
        canonicalUnits: 1,
        quantity: 1,
        unitPriceMinor: 200,
      },
      allocation: { allocations: [{ inventoryLotId: 'lot-1' }] },
    } as never);
    await expect(
      caller({ id: 'branch-1' }).addLine({
        branchId: 'branch-1',
        saleId: 'sale-1',
        medicineId: 'alternate',
        presentationId: 'alternate-p',
        packLevelId: 'pack-1',
        saleUnit: 'UNIT',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        idempotencyKey: 'attempt-1',
        substitution: {
          requestedMedicineId: 'medicine-1',
          requestedPresentationId: 'presentation-1',
          inventoryLotId: 'lot-1',
        },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  beforeEach(() => {
    vi.mocked(findSubstituteProposals).mockClear();
  });

  it('refuses an inactive branch before looking for equivalents', async () => {
    await expect(caller(null).substituteProposals(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    expect(findSubstituteProposals).not.toHaveBeenCalled();
  });

  it('derives the price rule on the server for an active branch', async () => {
    await caller({ id: 'branch-1' }).substituteProposals(input);
    expect(findSubstituteProposals).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' },
      {
        medicineId: 'medicine-1',
        presentationId: 'presentation-1',
        quantityCanonicalUnits: 10,
      }
    );
  });

  it('does not forward a client reference price', async () => {
    await caller({ id: 'branch-1' }).substituteProposals({
      ...input,
      referencePriceMinor: 10_000,
    });
    expect(findSubstituteProposals).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ referencePriceMinor: expect.anything() })
    );
  });

  it('refuses a cashier assigned to a different branch', async () => {
    await expect(
      caller({ id: 'branch-1' }, { assignedBranchIds: ['branch-2'] }).substituteProposals(input)
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    expect(findSubstituteProposals).not.toHaveBeenCalled();
  });

  it('refuses a DENY override even with a branch assignment', async () => {
    await expect(
      caller({ id: 'branch-1' }, { denyDispense: true }).substituteProposals(input)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(findSubstituteProposals).not.toHaveBeenCalled();
  });

  it('allows an exact counter grant and rejects a pharmacy wildcard', async () => {
    await expect(
      caller({ id: 'branch-1' }, { capability: 'pharmacy.counter' }).substituteProposals(input)
    ).resolves.toEqual([]);
    vi.mocked(findSubstituteProposals).mockClear();
    await expect(
      caller({ id: 'branch-1' }, { capability: 'pharmacy:*' }).substituteProposals(input)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(findSubstituteProposals).not.toHaveBeenCalled();
  });

  it('lets a same-organization admin without a counter grant list proposals unless denied', async () => {
    await expect(
      caller({ id: 'branch-1' }, { role: 'ADMIN', capability: 'pharmacy:orders' }).substituteProposals(
        input
      )
    ).resolves.toEqual([]);
    vi.mocked(findSubstituteProposals).mockClear();
    await expect(
      caller({ id: 'branch-1' }, { role: 'ADMIN', denyDispense: true }).substituteProposals(input)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(findSubstituteProposals).not.toHaveBeenCalled();
  });

  it('rejects a price override without a reason', async () => {
    await expect(
      caller({ id: 'branch-1' }).overrideSubstitutePrice({ ...input, reason: '  ' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(findSubstituteProposals).not.toHaveBeenCalled();
  });

  it('forwards an explicit pharmacist reason after authorization', async () => {
    await caller({ id: 'branch-1' }).overrideSubstitutePrice({
      ...input,
      reason: 'Patient requested available brand',
    });
    expect(findSubstituteProposals).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorId: 'actor-1', organizationId: 'org-1' }),
      expect.objectContaining({
        pharmacistOverride: { reason: 'Patient requested available brand' },
      })
    );
  });

  it('rejects a client requireLowerPrice flag', async () => {
    await expect(
      caller({ id: 'branch-1' }).substituteProposals({
        ...input,
        requireLowerPrice: false,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(findSubstituteProposals).not.toHaveBeenCalled();
  });
});
