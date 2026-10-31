import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', () => ({
  can: vi.fn(async () => true),
  subjectFromSession: vi.fn((user) => user),
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { pharmacySafetyRouter } from './pharmacy-safety';

const confirmedRules = {
  licenceCategories: { values: ['RETAIL'], provisional: false },
  permittedSchedules: { values: ['RX'], provisional: false },
  pharmacistCoverageRule: { values: {}, provisional: false },
};

function fixture() {
  const db = {
    pharmacyBranchAssignment: { findMany: vi.fn(async () => [{ branchId: 'branch-1' }]) },
    pharmacyBranch: { findFirst: vi.fn(async () => ({ id: 'branch-1', provinceCode: 'PB' })) },
    pharmacyControlledRegisterEntry: { findMany: vi.fn(async () => []) },
    branchRegulatoryProfile: { findFirst: vi.fn() },
    jurisdictionRuleSet: { findFirst: vi.fn() },
  };
  const caller = pharmacySafetyRouter.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-core'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user-1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
  return { db, caller };
}

beforeEach(() => vi.clearAllMocks());

describe('pharmacy safety register procedures', () => {
  it('does not expose a direct recordControlledEntry mutation', () => {
    expect(Object.keys(pharmacySafetyRouter._def.procedures)).not.toContain(
      'recordControlledEntry'
    );
    expect(Object.keys(pharmacySafetyRouter._def.procedures)).toEqual(
      expect.arrayContaining(['controlledRegister', 'recordCorrection', 'branches', 'access'])
    );
  });

  it.each(['licenceCategories', 'permittedSchedules', 'pharmacistCoverageRule'] as const)(
    'shows pending review when the effective profile has provisional %s, despite newer confirmed rules',
    async (field) => {
      const { db, caller } = fixture();
      db.branchRegulatoryProfile.findFirst.mockResolvedValue({
        provinceCode: 'PK-SD',
        jurisdictionRuleSet: { ...confirmedRules, [field]: { provisional: true } },
      });
      db.jurisdictionRuleSet.findFirst.mockResolvedValue(confirmedRules);

      await expect(caller.controlledRegister({ branchId: 'branch-1' })).resolves.toMatchObject({
        pendingLegalReview: true,
        provinceName: 'Sindh',
        entries: [],
      });
      expect(db.jurisdictionRuleSet.findFirst).not.toHaveBeenCalled();
      expect(db.branchRegulatoryProfile.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org-1',
            branchId: 'branch-1',
            effectiveFrom: { lte: expect.any(Date) },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: expect.any(Date) } }],
          },
          orderBy: { effectiveFrom: 'desc' },
        })
      );
    }
  );

  it('does not mark a confirmed pinned rule set pending because a different rule set is provisional', async () => {
    const { db, caller } = fixture();
    db.branchRegulatoryProfile.findFirst.mockResolvedValue({
      provinceCode: 'PK-SD',
      jurisdictionRuleSet: confirmedRules,
    });
    db.jurisdictionRuleSet.findFirst.mockResolvedValue({
      ...confirmedRules,
      licenceCategories: { provisional: true },
    });
    await expect(caller.controlledRegister({ branchId: 'branch-1' })).resolves.toMatchObject({
      pendingLegalReview: false,
      provinceName: 'Sindh',
    });
    expect(db.jurisdictionRuleSet.findFirst).not.toHaveBeenCalled();
  });

  it('uses published rules and a canonical province code before a profile is recorded', async () => {
    const { db, caller } = fixture();
    db.branchRegulatoryProfile.findFirst.mockResolvedValue(null);
    db.jurisdictionRuleSet.findFirst.mockResolvedValue({
      ...confirmedRules,
      pharmacistCoverageRule: {},
    });
    await expect(caller.controlledRegister({ branchId: 'branch-1' })).resolves.toMatchObject({
      pendingLegalReview: true,
      provinceName: 'Punjab',
    });
    expect(db.jurisdictionRuleSet.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ code: 'PK-PB', isPlaceholder: false }),
      })
    );
  });

  it('does not invent a legal review when there are no published rules', async () => {
    const { db, caller } = fixture();
    db.branchRegulatoryProfile.findFirst.mockResolvedValue(null);
    db.jurisdictionRuleSet.findFirst.mockResolvedValue(null);
    await expect(caller.controlledRegister({ branchId: 'branch-1' })).resolves.toMatchObject({
      pendingLegalReview: false,
    });
  });

  it('refuses an unassigned branch before reading its register or regulatory state', async () => {
    const { db, caller } = fixture();
    await expect(caller.controlledRegister({ branchId: 'other-branch' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyControlledRegisterEntry.findMany).not.toHaveBeenCalled();
    expect(db.branchRegulatoryProfile.findFirst).not.toHaveBeenCalled();
    expect(db.jurisdictionRuleSet.findFirst).not.toHaveBeenCalled();
  });
});
