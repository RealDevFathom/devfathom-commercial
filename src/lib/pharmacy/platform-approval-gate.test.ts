import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

import { recordAudit } from '@/server/audit';
import {
  hasPlatformApproval,
  isPerSaleRegulatedAction,
  platformApprovalInEffect,
  platformApprovalWaivesBranchGate,
  readPlatformApprovalChecks,
} from './platform-approval';
import {
  assertStoredPharmacyMayOperate,
  BranchOperationDeniedError,
  storedPharmacyOperationDenial,
  type BranchOperationAction,
  type BranchOperationDenialReason,
} from './regulatory';
import { addSaleLine, createSale } from './sales';

/**
 * DEV-905 (owner decision, 18 Nov): once a super admin approves a pharmacy, the
 * organization- and branch-level gates that stop it operating at all no longer refuse
 * it. A pharmacy that is not approved is refused exactly as before, and per-sale
 * regulated acts (Rx, restricted, controlled) still meet the full branch check.
 */
const at = new Date('2026-09-02T12:00:00.000Z');
const APPROVED_AT = new Date('2026-09-01T09:00:00.000Z');

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
  organization: Record<string, unknown> | null
) {
  return {
    $queryRaw: vi.fn(async () => []),
    organization: {
      findUnique: vi.fn(async () =>
        organization
          ? {
              timezone: 'Asia/Karachi',
              vertical: 'PHARMACY',
              platformApprovedAt: null,
              ...organization,
            }
          : null
      ),
    },
    branchRegulatoryProfile: { findFirst: vi.fn(async () => profile) },
  };
}

const ruleSet = storedProfile().jurisdictionRuleSet;

/** Every standing gate an approval overrides, with the state that trips it. */
const STANDING: Array<
  [BranchOperationDenialReason, ReturnType<typeof storedProfile> | null, string]
> = [
  ['ORGANIZATION_NOT_ACTIVE', storedProfile(), 'ONBOARDING'],
  ['PROFILE_MISSING', null, 'ACTIVE'],
  [
    'BRANCH_INACTIVE',
    storedProfile({ branch: { ...storedProfile().branch, active: false } }),
    'ACTIVE',
  ],
  ['PROFILE_PREMISES_MISMATCH', storedProfile({ provinceCode: 'PK-SD' }), 'ACTIVE'],
  [
    'RULE_SET_UNCONFIRMED',
    storedProfile({
      jurisdictionRuleSet: {
        ...ruleSet,
        licenceCategories: { provisional: true, values: ['PHARMACY'] },
      },
    }),
    'ACTIVE',
  ],
  ['LICENCE_INVALID', storedProfile({ licenceEvidenceFileRef: '' }), 'ACTIVE'],
  [
    'QUALIFIED_PERSON_COVERAGE_MISSING',
    storedProfile({ qualifiedPersonCoverageRosterRef: '' }),
    'ACTIVE',
  ],
];

const ORDINARY: BranchOperationAction[] = [
  { name: 'pharmacy.sale.create', at },
  { name: 'pharmacy.sale.dispense', at },
  { name: 'pharmacy.sale.tender', at },
];

const REGULATED: BranchOperationAction = {
  name: 'pharmacy.sale.dispense_regulated',
  at,
  requiresQualifiedPerson: true,
  requiresPharmacistPresence: true,
};

beforeEach(() => vi.clearAllMocks());

describe('a pharmacy that is not approved is refused exactly as before', () => {
  it.each(STANDING)(
    '%s still refuses every ordinary operation',
    async (reason, profile, status) => {
      for (const action of ORDINARY) {
        const denial = storedDb(profile, { status });
        await expect(
          assertStoredPharmacyMayOperate(denial as never, 'org-a', 'branch-a', action)
        ).rejects.toMatchObject({ reason });
        expect(
          await storedPharmacyOperationDenial(denial as never, 'org-a', 'branch-a', action)
        ).toBe(reason);
      }
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: reason, outcome: 'FAILURE' })
      );
    }
  );

  it('refuses a pharmacy whose approval was withdrawn (the fact cleared)', async () => {
    const db = storedDb(null, { status: 'ONBOARDING', platformApprovedAt: null });
    await expect(
      assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', ORDINARY[0]!)
    ).rejects.toMatchObject({ reason: 'ORGANIZATION_NOT_ACTIVE' });
  });
});

describe('an approved pharmacy is not refused by the standing gates', () => {
  it.each(STANDING)(
    '%s no longer refuses an ordinary operation',
    async (_reason, profile, status) => {
      for (const action of ORDINARY) {
        const db = storedDb(profile, { status, platformApprovedAt: APPROVED_AT });
        await expect(
          assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', action)
        ).resolves.toBeUndefined();
        expect(
          await storedPharmacyOperationDenial(db as never, 'org-a', 'branch-a', action)
        ).toBeNull();
      }
      expect(recordAudit).not.toHaveBeenCalled();
    }
  );

  it('keeps the organization and profile row locks the operation takes', async () => {
    const db = storedDb(null, { status: 'ONBOARDING', platformApprovedAt: APPROVED_AT });
    await assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', ORDINARY[0]!);
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it.each(['SUSPENDED', 'TERMINATED', 'PURGING', 'PROSPECT'])(
    'does not override a later %s state',
    async (status) => {
      const db = storedDb(storedProfile(), { status, platformApprovedAt: APPROVED_AT });
      await expect(
        assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', ORDINARY[0]!)
      ).rejects.toMatchObject({ reason: 'ORGANIZATION_NOT_ACTIVE' });
    }
  );

  it('ignores an approval stamped on an organization that is not a pharmacy', async () => {
    const db = storedDb(null, {
      status: 'ONBOARDING',
      vertical: 'HOSPITALITY',
      platformApprovedAt: APPROVED_AT,
    });
    await expect(
      assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', ORDINARY[0]!)
    ).rejects.toMatchObject({ reason: 'ORGANIZATION_NOT_ACTIVE' });
  });
});

describe('per-sale regulated acts keep their usual checks in an approved pharmacy', () => {
  it('refuses an Rx, restricted or controlled dispense without a regulatory profile', async () => {
    const db = storedDb(null, { status: 'ONBOARDING', platformApprovedAt: APPROVED_AT });
    await expect(
      assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', REGULATED)
    ).rejects.toMatchObject({ reason: 'PROFILE_MISSING' });
    expect(await storedPharmacyOperationDenial(db as never, 'org-a', 'branch-a', REGULATED)).toBe(
      'PROFILE_MISSING'
    );
  });

  it('refuses a regulated dispense with no qualified person, or outside presence hours', async () => {
    let db = storedDb(storedProfile({ qualifiedPersonRegistration: '' }), {
      status: 'ACTIVE',
      platformApprovedAt: APPROVED_AT,
    });
    await expect(
      assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', REGULATED)
    ).rejects.toMatchObject({ reason: 'QUALIFIED_PERSON_COVERAGE_MISSING' });

    db = storedDb(
      storedProfile({
        jurisdictionRuleSet: {
          ...ruleSet,
          pharmacistCoverageRule: {
            provisional: false,
            values: { presenceHours: { windows: [{ days: [1], start: '09:00', end: '10:00' }] } },
          },
        },
      }),
      { status: 'ACTIVE', platformApprovedAt: APPROVED_AT }
    );
    await expect(
      assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', REGULATED)
    ).rejects.toMatchObject({ reason: 'PHARMACIST_NOT_PRESENT' });
  });

  it('refuses a schedule the branch is not permitted', async () => {
    const db = storedDb(storedProfile(), { status: 'ACTIVE', platformApprovedAt: APPROVED_AT });
    await expect(
      assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', {
        name: 'pharmacy.controlled.dispense',
        at,
        schedule: 'CONTROLLED',
      })
    ).rejects.toMatchObject({ reason: 'SCHEDULE_NOT_PERMITTED' });
  });

  it('passes a regulated dispense on a valid profile, as it always did', async () => {
    const db = storedDb(storedProfile(), { status: 'ACTIVE', platformApprovedAt: APPROVED_AT });
    await expect(
      assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', REGULATED)
    ).resolves.toBeUndefined();
  });
});

describe('an approved pharmacy with no profile and no pharmacist at the counter', () => {
  const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'actor-a' };
  const lineInput = {
    saleId: 'sale-a',
    medicineId: 'medicine-a',
    presentationId: 'presentation-a',
    lotId: 'lot-a',
    quantity: 1,
    saleUnit: 'UNIT',
    canonicalUnitsPerSaleUnit: 1,
  } as never;

  function counterDb(medicine: { rx: boolean; restricted: boolean; controlled: boolean }) {
    return {
      ...storedDb(null, { status: 'ONBOARDING', platformApprovedAt: APPROVED_AT }),
      pharmacySale: {
        create: vi.fn(async () => ({ id: 'sale-a', status: 'OPEN' })),
        findFirst: vi.fn(async () => ({ id: 'sale-a', status: 'OPEN', lines: [] })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      pharmacySaleEvent: { create: vi.fn() },
      pharmacySaleLine: { findFirst: vi.fn(async () => null), create: vi.fn() },
      medicine: { findFirst: vi.fn(async () => ({ id: 'medicine-a', ...medicine })) },
      pharmacyInventoryLot: { findMany: vi.fn() },
      pharmacySaleLineAllocation: { create: vi.fn() },
    };
  }

  it('opens an ordinary sale', async () => {
    const db = counterDb({ rx: false, restricted: false, controlled: false });
    await expect(createSale(db as never, scope)).resolves.toMatchObject({ id: 'sale-a' });
    expect(db.pharmacySale.create).toHaveBeenCalledOnce();
  });

  it('lets an OTC line past the regulatory gate', async () => {
    const db = counterDb({ rx: false, restricted: false, controlled: false });
    // Stock allocation is not mocked here; only the gate decisions before it matter.
    const error = await addSaleLine(db as never, scope, lineInput).catch((thrown) => thrown);
    expect(error).not.toBeInstanceOf(BranchOperationDeniedError);
    expect(db.medicine.findFirst).toHaveBeenCalled();
  });

  it.each([
    ['prescription-only', { rx: true, restricted: false, controlled: false }],
    ['restricted', { rx: false, restricted: true, controlled: false }],
    ['controlled', { rx: false, restricted: false, controlled: true }],
  ])('still refuses a %s line before allocating stock', async (_kind, medicine) => {
    const db = counterDb(medicine);
    await expect(addSaleLine(db as never, scope, lineInput)).rejects.toMatchObject({
      reason: 'PROFILE_MISSING',
    });
    expect(db.pharmacyInventoryLot.findMany).not.toHaveBeenCalled();
    expect(db.pharmacySaleLine.create).not.toHaveBeenCalled();
    expect(db.pharmacySaleLineAllocation.create).not.toHaveBeenCalled();
  });
});

describe('platform approval helpers', () => {
  it('reads the approval fact', () => {
    expect(hasPlatformApproval(null)).toBe(false);
    expect(hasPlatformApproval({ status: 'ONBOARDING', platformApprovedAt: null })).toBe(false);
    expect(
      hasPlatformApproval({
        status: 'ONBOARDING',
        vertical: 'PHARMACY',
        platformApprovedAt: APPROVED_AT,
      })
    ).toBe(true);
    expect(
      hasPlatformApproval({
        status: 'ONBOARDING',
        vertical: 'HOSPITALITY',
        platformApprovedAt: APPROVED_AT,
      })
    ).toBe(false);
  });

  it('puts the approval in effect only while onboarding, active or in grace', () => {
    for (const status of ['ONBOARDING', 'ACTIVE', 'GRACE'])
      expect(
        platformApprovalInEffect({ status, vertical: 'PHARMACY', platformApprovedAt: APPROVED_AT })
      ).toBe(true);
    for (const status of ['SUSPENDED', 'TERMINATED', 'PURGING', 'PURGED', 'PROSPECT'])
      expect(
        platformApprovalInEffect({ status, vertical: 'PHARMACY', platformApprovedAt: APPROVED_AT })
      ).toBe(false);
  });

  it('never waives a per-sale regulated act', () => {
    const approved = { status: 'ACTIVE', vertical: 'PHARMACY', platformApprovedAt: APPROVED_AT };
    expect(isPerSaleRegulatedAction(REGULATED)).toBe(true);
    expect(isPerSaleRegulatedAction({ name: 'x', schedule: 'RX' })).toBe(true);
    expect(isPerSaleRegulatedAction({ name: 'x', requiresQualifiedPerson: true })).toBe(false);
    expect(platformApprovalWaivesBranchGate(approved, REGULATED)).toBe(false);
    expect(platformApprovalWaivesBranchGate(approved, ORDINARY[0]!)).toBe(true);
    expect(
      platformApprovalWaivesBranchGate({ ...approved, platformApprovedAt: null }, ORDINARY[0]!)
    ).toBe(false);
  });

  it('reads the stored unmet checks back, dropping anything malformed', () => {
    expect(
      readPlatformApprovalChecks([
        { key: 'PREMISES_AND_LICENCES', label: 'Premises and licences' },
        { key: 1 },
        'junk',
        null,
      ])
    ).toEqual([{ key: 'PREMISES_AND_LICENCES', label: 'Premises and licences' }]);
    expect(readPlatformApprovalChecks(null)).toEqual([]);
  });
});
