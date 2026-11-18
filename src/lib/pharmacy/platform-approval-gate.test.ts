import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

import { recordAudit } from '@/server/audit';
import {
  hasPlatformApproval,
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
 * it, on ordinary and regulated operations alike. A pharmacy that is not approved is
 * refused exactly as before. The per-sale rules (pharmacist grant, prescription and
 * signed review, controlled witness) are separate code: settlement.platform-approval.test.ts.
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

/** The gate an Rx, restricted or controlled line meets at add-line and at payment. */
const REGULATED: BranchOperationAction[] = [
  {
    name: 'pharmacy.sale.dispense_regulated',
    at,
    requiresQualifiedPerson: true,
    requiresPharmacistPresence: true,
  },
  {
    name: 'pharmacy.sale.tender_regulated',
    at,
    requiresQualifiedPerson: true,
    requiresPharmacistPresence: true,
  },
];

const EVERY = [...ORDINARY, ...REGULATED];

/** A profile whose presence hours exclude `at` (a Wednesday). */
const outsideHours = storedProfile({
  jurisdictionRuleSet: {
    ...ruleSet,
    pharmacistCoverageRule: {
      provisional: false,
      values: { presenceHours: { windows: [{ days: [1], start: '09:00', end: '10:00' }] } },
    },
  },
});

/** The regulated-only refusals, with the state and the operation that trip them. */
const REGULATED_ONLY: Array<
  [BranchOperationDenialReason, ReturnType<typeof storedProfile>, BranchOperationAction]
> = [
  ['PHARMACIST_NOT_PRESENT', outsideHours, REGULATED[0]!],
  [
    'SCHEDULE_NOT_PERMITTED',
    storedProfile(),
    { name: 'pharmacy.controlled', at, schedule: 'CONTROLLED' },
  ],
];

beforeEach(() => vi.clearAllMocks());

describe('a pharmacy that is not approved is refused exactly as before', () => {
  it.each(STANDING)(
    '%s still refuses every ordinary and regulated operation',
    async (reason, profile, status) => {
      for (const action of EVERY) {
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

  it.each(REGULATED_ONLY)(
    '%s still refuses its regulated operation',
    async (reason, profile, action) => {
      const db = storedDb(profile, { status: 'ACTIVE' });
      await expect(
        assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', action)
      ).rejects.toMatchObject({ reason });
    }
  );

  it('refuses a pharmacy the withdrawal returned to onboarding', async () => {
    const db = storedDb(null, { status: 'ONBOARDING', platformApprovedAt: null });
    await expect(
      assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', ORDINARY[0]!)
    ).rejects.toMatchObject({ reason: 'ORGANIZATION_NOT_ACTIVE' });
  });

  it('refuses an active pharmacy whose approval was withdrawn, at the branch gate', async () => {
    const db = storedDb(null, { status: 'ACTIVE', platformApprovedAt: null });
    for (const action of EVERY) {
      await expect(
        assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', action)
      ).rejects.toMatchObject({ reason: 'PROFILE_MISSING' });
    }
  });
});

describe('an approved pharmacy is not refused by the operating gates', () => {
  it.each(STANDING)(
    '%s no longer refuses an ordinary or regulated operation',
    async (_reason, profile, status) => {
      for (const action of EVERY) {
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

  it.each(REGULATED_ONLY)(
    "%s, a limit of the branch's own profile, no longer refuses",
    async (_reason, profile, action) => {
      const db = storedDb(profile, { status: 'ACTIVE', platformApprovedAt: APPROVED_AT });
      await expect(
        assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', action)
      ).resolves.toBeUndefined();
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
      for (const action of EVERY) {
        const db = storedDb(storedProfile(), { status, platformApprovedAt: APPROVED_AT });
        await expect(
          assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', action)
        ).rejects.toMatchObject({ reason: 'ORGANIZATION_NOT_ACTIVE' });
      }
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

describe('the counter in a pharmacy with no profile and no pharmacist', () => {
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

  function counterDb(
    medicine: { rx: boolean; restricted: boolean; controlled: boolean },
    approved: boolean
  ) {
    return {
      ...storedDb(null, {
        status: approved ? 'ONBOARDING' : 'ACTIVE',
        platformApprovedAt: approved ? APPROVED_AT : null,
      }),
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

  const KINDS = [
    ['an over-the-counter', { rx: false, restricted: false, controlled: false }],
    ['a prescription-only', { rx: true, restricted: false, controlled: false }],
    ['a restricted', { rx: false, restricted: true, controlled: false }],
    ['a controlled', { rx: false, restricted: false, controlled: true }],
  ] as const;

  it('opens a sale once approved, and is refused when not approved', async () => {
    const approved = counterDb(KINDS[0][1], true);
    await expect(createSale(approved as never, scope)).resolves.toMatchObject({ id: 'sale-a' });

    const refused = counterDb(KINDS[0][1], false);
    await expect(createSale(refused as never, scope)).rejects.toMatchObject({
      reason: 'PROFILE_MISSING',
    });
    expect(refused.pharmacySale.create).not.toHaveBeenCalled();
  });

  it.each(KINDS)(
    'lets %s line past the regulatory gates once approved',
    async (_kind, medicine) => {
      const db = counterDb(medicine, true);
      // Stock allocation is not mocked here; only the gate decisions before it matter.
      const error = await addSaleLine(db as never, scope, lineInput).catch((thrown) => thrown);
      expect(error).not.toBeInstanceOf(BranchOperationDeniedError);
      expect(db.medicine.findFirst).toHaveBeenCalled();
    }
  );

  it.each(KINDS)(
    'refuses %s line before reading the sale when not approved',
    async (_kind, medicine) => {
      const db = counterDb(medicine, false);
      await expect(addSaleLine(db as never, scope, lineInput)).rejects.toMatchObject({
        reason: 'PROFILE_MISSING',
      });
      expect(db.medicine.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacySaleLine.create).not.toHaveBeenCalled();
    }
  );
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
    for (const status of ['ONBOARDING', 'ACTIVE', 'GRACE']) {
      const organization = { status, vertical: 'PHARMACY', platformApprovedAt: APPROVED_AT };
      expect(platformApprovalInEffect(organization)).toBe(true);
      expect(platformApprovalWaivesBranchGate(organization)).toBe(true);
    }
    for (const status of ['SUSPENDED', 'TERMINATED', 'PURGING', 'PURGED', 'PROSPECT']) {
      const organization = { status, vertical: 'PHARMACY', platformApprovedAt: APPROVED_AT };
      expect(platformApprovalInEffect(organization)).toBe(false);
      expect(platformApprovalWaivesBranchGate(organization)).toBe(false);
    }
    expect(
      platformApprovalWaivesBranchGate({
        status: 'ACTIVE',
        vertical: 'PHARMACY',
        platformApprovedAt: null,
      })
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
