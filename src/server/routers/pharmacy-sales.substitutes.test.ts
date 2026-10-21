import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/pharmacy/counter-branch-access', () => ({
  readCounterBranchAssignments: vi.fn(
    async (db: { pharmacyBranchAssignment: { findMany: () => Promise<unknown> } }) =>
      db.pharmacyBranchAssignment.findMany()
  ),
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
  options?: { role?: 'EMPLOYEE' | 'ADMIN'; assignedBranchIds?: string[]; denyDispense?: boolean }
) {
  const assignedBranchIds = options?.assignedBranchIds ?? (branch ? [branch.id] : []);
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: {
          permissions: [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }],
        },
        permissionOverrides: options?.denyDispense
          ? [{ capability: 'pharmacy:dispense', effect: 'DENY' }]
          : [],
      })),
    },
    pharmacyBranch: { findFirst: vi.fn(async () => branch) },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => assignedBranchIds.map((branchId) => ({ branchId }))),
    },
  };
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
