import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));

vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn(async () => true),
}));
import type { TRPCContext } from '../trpc';

import { pharmacySafetyRouter } from './pharmacy-safety';

describe('pharmacy safety register procedures', () => {
  it('does not expose a direct recordControlledEntry mutation', () => {
    expect(Object.keys(pharmacySafetyRouter._def.procedures)).not.toContain(
      'recordControlledEntry'
    );
    expect(Object.keys(pharmacySafetyRouter._def.procedures)).toEqual(
      expect.arrayContaining(['controlledRegister', 'recordCorrection', 'branches', 'access'])
    );
  });
});

function fixture(provisional: boolean | undefined, profileExists = true) {
  const rules = {
    licenceCategories: { provisional: false },
    permittedSchedules: { provisional: false },
    pharmacistCoverageRule: { provisional },
  };
  const db = {
    pharmacyBranchAssignment: { findMany: vi.fn().mockResolvedValue([{ branchId: 'branch-1' }]) },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-1' }),
      findFirstOrThrow: vi
        .fn()
        .mockResolvedValue({
          provinceCode: 'PK-SD',
          regulatoryProfiles: profileExists
            ? [{ provinceCode: 'PK-SD', jurisdictionRuleSet: rules }]
            : [],
        }),
    },
    jurisdictionRuleSet: { findFirst: vi.fn().mockResolvedValue(rules) },
    pharmacyControlledRegisterEntry: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const ctx = {
    db,
    entitlements: { organizationId: 'org-1', modules: [] },
    session: { user: { id: 'user-1', role: 'EMPLOYEE', status: 'ACTIVE' } },
    requestMeta: { ip: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: pharmacySafetyRouter.createCaller(ctx) };
}

it.each([true, false, undefined])(
  'reports the bound profile rule state (%s) for an empty register',
  async (provisional) => {
    const { db, caller } = fixture(provisional);
    await expect(caller.controlledRegister({ branchId: 'branch-1' })).resolves.toEqual({
      entries: [],
      provinceName: 'Sindh',
      pendingLegalReview: provisional !== false,
    });
    expect(db.jurisdictionRuleSet.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyBranch.findFirstOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'branch-1', organizationId: 'org-1', active: true },
        select: expect.objectContaining({
          regulatoryProfiles: expect.objectContaining({
            where: {
              organizationId: 'org-1',
              effectiveFrom: { lte: expect.any(Date) },
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: expect.any(Date) } }],
            },
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
          }),
        }),
      })
    );
  }
);

it('reports published pending province rules before a profile exists', async () => {
  const { db, caller } = fixture(true, false);
  expect(await caller.controlledRegister({ branchId: 'branch-1' })).toMatchObject({
    pendingLegalReview: true,
  });
  expect(db.jurisdictionRuleSet.findFirst).toHaveBeenCalledWith({
    where: {
      code: 'PK-SD',
      isPlaceholder: false,
      effectiveFrom: { lte: expect.any(Date) },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: expect.any(Date) } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
});

it('refuses an unassigned branch before reading its regulatory status or register', async () => {
  const { db, caller } = fixture(true);
  await expect(caller.controlledRegister({ branchId: 'other-branch' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(db.pharmacyBranch.findFirstOrThrow).not.toHaveBeenCalled();
  expect(db.pharmacyControlledRegisterEntry.findMany).not.toHaveBeenCalled();
});
