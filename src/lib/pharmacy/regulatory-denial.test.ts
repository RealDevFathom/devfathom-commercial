import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordAudit } from '@/server/audit';
import {
  assertStoredPharmacyMayOperate,
  BranchOperationDeniedError,
  storedPharmacyOperationDenial,
  type BranchOperationDenialReason,
} from './regulatory';

vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

/**
 * DEV-860: the counter's ready-to-sell check asks the regulatory gate why it would
 * refuse a sale, without the gate's locks or its denial audit. It must give the same
 * answer as `assertStoredPharmacyMayOperate` for every reason, so a branch is never
 * listed ready while a sale is refused (or the other way round).
 */
const at = new Date('2026-09-02T12:00:00.000Z');

function storedProfile(overrides: Record<string, unknown> = {}) {
  return {
    branchId: 'branch-a',
    licenceCategory: 'PHARMACY',
    licenceValidFrom: new Date('2026-01-01T00:00:00.000Z'),
    licenceValidTo: new Date('2027-01-01T00:00:00.000Z'),
    licenceEvidenceFileRef: '/api/files/licence-evidence.pdf',
    permittedSchedules: ['RX'],
    qualifiedPersonRegistration: 'QP-1',
    qualifiedPersonValidFrom: new Date('2026-01-01T00:00:00.000Z'),
    qualifiedPersonValidTo: new Date('2027-01-01T00:00:00.000Z'),
    qualifiedPersonCoverageRosterRef: 'roster-1',
    provinceCode: 'PK-PB',
    premises: { addressLine: '12 Mall Road', city: 'Lahore' },
    branch: { active: true, provinceCode: 'PB', addressLine: '12 Mall Road', city: 'Lahore' },
    jurisdictionRuleSet: {
      licenceCategories: { provisional: false, values: ['PHARMACY'] },
      permittedSchedules: { provisional: false, values: ['RX'] },
      pharmacistCoverageRule: { provisional: false, values: {} },
    },
    ...overrides,
  };
}

function storedDb(
  profile: ReturnType<typeof storedProfile> | null,
  status: string | null = 'ACTIVE'
) {
  return {
    $queryRaw: vi.fn(async () => []),
    organization: {
      findUnique: vi.fn(async () => (status ? { status, timezone: 'Asia/Karachi' } : null)),
    },
    branchRegulatoryProfile: { findFirst: vi.fn(async () => profile) },
  };
}

const ruleSet = storedProfile().jurisdictionRuleSet;
const cases: Array<
  [BranchOperationDenialReason, ReturnType<typeof storedProfile> | null, string?, object?]
> = [
  ['ORGANIZATION_NOT_ACTIVE', storedProfile(), 'SUSPENDED'],
  ['PROFILE_MISSING', null],
  ['BRANCH_INACTIVE', storedProfile({ branch: { ...storedProfile().branch, active: false } })],
  ['PROFILE_PREMISES_MISMATCH', storedProfile({ provinceCode: 'PK-SD' })],
  [
    'RULE_SET_UNCONFIRMED',
    storedProfile({
      jurisdictionRuleSet: {
        ...ruleSet,
        licenceCategories: { provisional: true, values: ['PHARMACY'] },
      },
    }),
  ],
  ['LICENCE_INVALID', storedProfile({ licenceEvidenceFileRef: '' })],
  ['QUALIFIED_PERSON_COVERAGE_MISSING', storedProfile({ qualifiedPersonCoverageRosterRef: '' })],
  ['SCHEDULE_NOT_PERMITTED', storedProfile(), 'ACTIVE', { schedule: 'CONTROLLED' }],
  [
    'PHARMACIST_NOT_PRESENT',
    storedProfile({
      jurisdictionRuleSet: {
        ...ruleSet,
        pharmacistCoverageRule: {
          provisional: false,
          // Wednesday 17:00 in Karachi is outside a 09:00–13:00 window.
          values: { presenceHours: { windows: [{ days: [3], start: '09:00', end: '13:00' }] } },
        },
      },
    }),
    'ACTIVE',
    { requiresPharmacistPresence: true },
  ],
];

beforeEach(() => vi.mocked(recordAudit).mockReset());

describe('storedPharmacyOperationDenial (DEV-860)', () => {
  it.each(cases)(
    'reports %s, the reason the asserting gate refuses with',
    async (reason, profile, status = 'ACTIVE', extra = {}) => {
      const action = { name: 'pharmacy.sale.create', at, ...extra };
      const read = storedDb(profile, status);
      await expect(
        storedPharmacyOperationDenial(read as never, 'org-a', 'branch-a', action)
      ).resolves.toBe(reason);

      const gate = storedDb(profile, status);
      await expect(
        assertStoredPharmacyMayOperate(gate as never, 'org-a', 'branch-a', action)
      ).rejects.toEqual(new BranchOperationDeniedError(reason));
    }
  );

  it('answers null for a branch the gate lets sell', async () => {
    const db = storedDb(storedProfile());
    await expect(
      storedPharmacyOperationDenial(db as never, 'org-a', 'branch-a', {
        name: 'pharmacy.sale.create',
        at,
      })
    ).resolves.toBeNull();
  });

  it('takes no lock and writes no denial audit: it authorizes nothing', async () => {
    const db = storedDb(null);
    await storedPharmacyOperationDenial(db as never, 'org-a', 'branch-a', {
      name: 'pharmacy.sale.create',
      at,
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('keeps the asserting gate auditing every denial', async () => {
    const db = storedDb(null);
    await expect(
      assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', {
        name: 'pharmacy.sale.create',
        at,
      })
    ).rejects.toBeInstanceOf(BranchOperationDeniedError);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'PROFILE_MISSING', outcome: 'FAILURE' })
    );
  });
});
