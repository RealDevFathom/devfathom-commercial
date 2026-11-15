/**
 * #977 — a branch's regulatory profile is saved on the branch's own province.
 * A Sindh branch on a database that only publishes Punjab rules is refused on
 * the province field with "Sindh rules are not published yet", and a Punjab
 * profile for that Sindh branch is refused as a mismatch — neither writes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  branchFindFirst: vi.fn(),
  profileFindFirst: vi.fn(),
  ruleSetFindMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  recordAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { pharmacyOnboardingRouter } from './pharmacy-onboarding';

function context(): TRPCContext {
  return {
    db: {
      pharmacyBranch: { findFirst: mocks.branchFindFirst },
      branchRegulatoryProfile: { findFirst: mocks.profileFindFirst },
      jurisdictionRuleSet: { findMany: mocks.ruleSetFindMany },
      $transaction: mocks.transaction,
    },
    entitlements: {
      organizationId: 'pharmacy-org',
      enabledModules: ['pharmacy-core'],
      modules: [{ key: 'pharmacy-core', name: 'Pharmacy', enabled: true }],
    },
    session: {
      expires: 'later',
      user: { id: 'admin', organizationId: 'pharmacy-org', role: 'ADMIN', status: 'ACTIVE' },
    },
    organization: { id: 'pharmacy-org' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

const punjabProvisional = {
  id: 'pk_pb_provisional_v1',
  code: 'PK-PB',
  version: 1,
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
  effectiveTo: null,
  licenceCategories: { values: [], provisional: true },
  permittedSchedules: { values: [], provisional: true },
  pharmacistCoverageRule: { values: {}, provisional: true },
};

const profile = {
  branchId: 'branch-sd',
  effectiveFrom: '2026-11-02',
  provinceCode: 'PK-SD',
  premisesAddressLine: '4 Clifton Road',
  premisesCity: 'Karachi',
  premisesStorageDescription: 'Cold chain fridge and a locked controlled-drug cabinet.',
  licenceCategory: 'PROVISIONAL',
  licenceNumber: 'LIC-4471',
  licenceValidFrom: '2026-01-01',
  licenceValidTo: '2027-01-01',
  licenceEvidenceFileRef: '/api/files/licence.pdf',
  permittedSchedules: [],
  qualifiedPersonRegistration: 'PC-9981',
  qualifiedPersonValidFrom: '2026-01-01',
  qualifiedPersonValidTo: '2027-01-01',
  qualifiedPersonCoverageRosterRef: '/api/files/roster.pdf',
  fiscalStatus: 'UNCONFIRMED' as const,
  retentionPrescriptionYears: 5,
  retentionInvoiceYears: 6,
  retentionControlledRegisterYears: 10,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.branchFindFirst.mockResolvedValue({
    id: 'branch-sd',
    provinceCode: 'SD',
    addressLine: '4 Clifton Road',
    city: 'Karachi',
  });
  mocks.profileFindFirst.mockResolvedValue(null);
  mocks.ruleSetFindMany.mockResolvedValue([punjabProvisional]);
});

describe('saveRegulatoryProfile province binding (#977)', () => {
  it("refuses a Sindh branch on the province field when only Punjab's rules are published", async () => {
    const error = await pharmacyOnboardingRouter
      .createCaller(context())
      .saveRegulatoryProfile(profile)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/^Sindh rules are not published yet\./),
    });
    expect((error as Error).message).not.toContain('Pick a province');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('refuses a Punjab profile for a Sindh branch on the province field', async () => {
    await expect(
      pharmacyOnboardingRouter
        .createCaller(context())
        .saveRegulatoryProfile({ ...profile, provinceCode: 'PK-PB' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('The regulatory province must match the selected branch.'),
    });
    expect(mocks.ruleSetFindMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('records a Sindh branch on published Sindh rules even when the branch stores the bare code', async () => {
    mocks.ruleSetFindMany.mockResolvedValue([
      punjabProvisional,
      { ...punjabProvisional, id: 'pk_sd_v1', code: 'PK-SD' },
    ]);
    mocks.transaction.mockResolvedValue(undefined);
    const create = vi.fn();
    mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<void>) =>
      run({ branchRegulatoryProfile: { create, update: vi.fn() } })
    );
    // readOverview after the save is outside this test's concern.
    await pharmacyOnboardingRouter
      .createCaller(context())
      .saveRegulatoryProfile(profile)
      .catch(() => undefined);
    expect(create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({ provinceCode: 'PK-SD', jurisdictionRuleSetId: 'pk_sd_v1' }),
    });
  });
});
