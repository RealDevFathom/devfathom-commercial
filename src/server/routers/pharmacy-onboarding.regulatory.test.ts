import { describe, expect, it, vi } from 'vitest';

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
import { pharmacyOnboardingRouter } from './pharmacy-onboarding';

const confirmedRules = {
  licenceCategories: { values: ['RETAIL'], provisional: false },
  permittedSchedules: { values: ['RX'], provisional: false },
  pharmacistCoverageRule: { values: {}, provisional: false },
};

function fixture(pinnedRules: typeof confirmedRules, publishedRules = confirmedRules) {
  const db = {
    pharmacyBranch: {
      findMany: vi.fn(async () => [{ id: 'branch-1', provinceCode: 'SD' }]),
    },
    jurisdictionRuleSet: {
      findMany: vi.fn(async () => [{ id: 'rules-latest', code: 'PK-SD', ...publishedRules }]),
    },
    branchRegulatoryProfile: {
      findMany: vi.fn(async () => [
        {
          id: 'profile-1',
          branchId: 'branch-1',
          provinceCode: 'PK-SD',
          effectiveFrom: new Date('2020-01-01'),
          effectiveTo: null,
          licenceCategory: 'RETAIL',
          licenceEvidenceFileRef: '/api/files/licence.pdf',
          licenceValidFrom: new Date('2020-01-01'),
          licenceValidTo: new Date('2099-01-01'),
          permittedSchedules: ['RX'],
          qualifiedPersonRegistration: 'PC-1',
          qualifiedPersonCoverageRosterRef: '/api/files/roster.pdf',
          qualifiedPersonValidFrom: new Date('2020-01-01'),
          qualifiedPersonValidTo: new Date('2099-01-01'),
          jurisdictionRuleSet: pinnedRules,
        },
      ]),
    },
  };
  return pharmacyOnboardingRouter.createCaller({
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
}

describe('regulatory profile legal review status', () => {
  it.each(['licenceCategories', 'permittedSchedules', 'pharmacistCoverageRule'] as const)(
    'reports a pinned provisional %s even when the latest rules are confirmed',
    async (field) => {
      const caller = fixture({
        ...confirmedRules,
        [field]: { ...confirmedRules[field], provisional: true },
      });

      const result = await caller.regulatory({ branchId: 'branch-1' });

      expect(result.jurisdictions[0].provisional).toBe(false);
      expect(result.versions[0]).toMatchObject({
        effective: true,
        inForce: false,
        pendingLegalReview: true,
        provinceName: 'Sindh',
      });
    }
  );

  it('keeps a confirmed pinned profile in force when the latest rules are provisional', async () => {
    const caller = fixture(confirmedRules, {
      ...confirmedRules,
      licenceCategories: { values: ['RETAIL'], provisional: true },
    });

    const result = await caller.regulatory({ branchId: 'branch-1' });

    expect(result.jurisdictions[0].provisional).toBe(true);
    expect(result.versions[0]).toMatchObject({
      effective: true,
      inForce: true,
      pendingLegalReview: false,
    });
  });
});
