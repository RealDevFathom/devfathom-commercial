import { describe, expect, it, vi } from 'vitest';
import { recordAudit } from '@/server/audit';
import {
  assertBranchMayOperate,
  assertStoredBranchMayOperate,
  BranchOperationDeniedError,
  evaluateBranchRegulatoryStatus,
  isLegacyPlaceholderProfile,
  regulatoryProfileBindingDenial,
  type BranchRegulatoryState,
} from './regulatory';

vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

const at = new Date('2026-09-02T12:00:00.000Z');

function validState(): BranchRegulatoryState {
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
    ruleSet: {
      licenceCategories: { provisional: false, values: ['PHARMACY'] },
      permittedSchedules: { provisional: false, values: ['RX'] },
      pharmacistCoverageRule: { provisional: false, values: {} },
    },
    auditDenied: vi.fn(),
  };
}

function expectDenied(state: BranchRegulatoryState, reason: BranchOperationDeniedError['reason']) {
  expect(() =>
    assertBranchMayOperate(state, {
      name: 'DISPENSE',
      at,
      schedule: 'RX',
      requiresQualifiedPerson: true,
    })
  ).toThrowError(new BranchOperationDeniedError(reason));
  expect(state.auditDenied).toHaveBeenCalledOnce();
  expect(state.auditDenied).toHaveBeenCalledWith(
    reason,
    expect.objectContaining({ name: 'DISPENSE' })
  );
}

describe('assertBranchMayOperate', () => {
  it('permits a confirmed, valid licence, coverage and schedule', () => {
    const state = validState();
    expect(() =>
      assertBranchMayOperate(state, {
        name: 'DISPENSE',
        at,
        schedule: 'RX',
        requiresQualifiedPerson: true,
      })
    ).not.toThrow();
    expect(state.auditDenied).not.toHaveBeenCalled();
  });

  it('accepts real licence evidence through the same activation primitive', () => {
    const state = validState();
    state.licenceEvidenceFileRef = '/api/files/licence-evidence.pdf';

    expect(() =>
      assertBranchMayOperate(state, {
        name: 'ACTIVATE',
        at,
        requiresQualifiedPerson: true,
      })
    ).not.toThrow();
  });

  it('does not bypass the controlled schedule or qualified-person Rx gate', () => {
    const controlled = validState();
    controlled.permittedSchedules = [];
    expectDenied(controlled, 'SCHEDULE_NOT_PERMITTED');

    const rx = validState();
    rx.qualifiedPersonCoverageRosterRef = '';
    expectDenied(rx, 'QUALIFIED_PERSON_COVERAGE_MISSING');
  });

  it.each(['OTC', 'RX', 'CONTROLLED'])(
    'permits %s through the placeholder wildcards',
    (schedule) => {
      const state = validState();
      state.licenceCategory = '*';
      state.permittedSchedules = ['OTC', 'RX', 'CONTROLLED'];
      state.ruleSet.licenceCategories = { provisional: false, values: ['*'] };
      state.ruleSet.permittedSchedules = { provisional: false, values: ['*'] };

      expect(() =>
        assertBranchMayOperate(state, {
          name: 'DISPENSE',
          at,
          schedule,
          requiresQualifiedPerson: true,
        })
      ).not.toThrow();
    }
  );

  it('fails closed and audits an expired licence', () => {
    const state = validState();
    state.licenceValidTo = at;
    expectDenied(state, 'LICENCE_INVALID');
  });

  it('fails closed and audits missing qualified-person coverage', () => {
    const state = validState();
    state.qualifiedPersonCoverageRosterRef = '';
    expectDenied(state, 'QUALIFIED_PERSON_COVERAGE_MISSING');
  });

  it('fails closed and audits a schedule absent from the branch licence', () => {
    const state = validState();
    state.permittedSchedules = [];
    expectDenied(state, 'SCHEDULE_NOT_PERMITTED');
  });

  it('never treats a provisional jurisdiction rule as a warning', () => {
    const state = validState();
    state.ruleSet.licenceCategories = { provisional: true, values: ['PHARMACY'] };
    expectDenied(state, 'RULE_SET_UNCONFIRMED');
  });
});

describe('assertStoredBranchMayOperate', () => {
  function storedProfile(overrides: Record<string, unknown> = {}) {
    return {
      ...validState(),
      provinceCode: 'PK-PB',
      premises: { addressLine: '12 Mall Road', city: 'Lahore' },
      branch: {
        active: true,
        provinceCode: 'PB',
        addressLine: '12 Mall Road',
        city: 'Lahore',
      },
      jurisdictionRuleSet: validState().ruleSet,
      ...overrides,
    };
  }

  function storedDb(profile: ReturnType<typeof storedProfile>) {
    return {
      branchRegulatoryProfile: { findFirst: vi.fn(async () => profile) },
    } as never;
  }

  it('permits a matching profile and scopes the lookup to the requested tenant and branch', async () => {
    const findFirst = vi.fn(async () => storedProfile());
    const db = { branchRegulatoryProfile: { findFirst } } as never;
    await expect(
      assertStoredBranchMayOperate(db, 'org-a', 'branch-a', { name: 'ACTIVATE', at })
    ).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({
      where: {
        organizationId: 'org-a',
        branchId: 'branch-a',
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      include: { jurisdictionRuleSet: true, branch: true },
      orderBy: { effectiveFrom: 'desc' },
    });
  });

  it('accepts equivalent province codes, casing and whitespace in premises', async () => {
    const profile = storedProfile({
      provinceCode: ' pk-pb ',
      premises: { addressLine: ' 12  MALL Road ', city: ' LAHORE ' },
    });
    await expect(
      assertStoredBranchMayOperate(storedDb(profile), 'org-a', 'branch-a', {
        name: 'ACTIVATE',
        at,
      })
    ).resolves.toBeUndefined();
  });

  it('refuses an otherwise valid profile when its branch is inactive', async () => {
    const profile = storedProfile({
      branch: { ...storedProfile().branch, active: false },
    });
    await expect(
      assertStoredBranchMayOperate(storedDb(profile), 'org-a', 'branch-a', {
        name: 'ACTIVATE',
        at,
      })
    ).rejects.toThrowError(new BranchOperationDeniedError('BRANCH_INACTIVE'));
  });

  it.each([
    ['province', { provinceCode: 'PK-SD' }],
    ['address', { premises: { addressLine: '99 Other Road', city: 'Lahore' } }],
    ['city', { premises: { addressLine: '12 Mall Road', city: 'Karachi' } }],
    ['missing premises', { premises: null }],
    ['malformed premises', { premises: { addressLine: 12, city: 'Lahore' } }],
  ])('refuses a profile whose %s is not bound to the branch', async (_field, mismatch) => {
    await expect(
      assertStoredBranchMayOperate(storedDb(storedProfile(mismatch)), 'org-a', 'branch-a', {
        name: 'ACTIVATE',
        at,
      })
    ).rejects.toThrowError(new BranchOperationDeniedError('PROFILE_PREMISES_MISMATCH'));
    expect(recordAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        targetId: 'branch-a',
        errorCode: 'PROFILE_PREMISES_MISMATCH',
        outcome: 'FAILURE',
      })
    );
  });
});

describe('grandfathered pk_pb_placeholder_v1 profiles', () => {
  const legacyPlaceholder = (overrides: Record<string, unknown> = {}) => ({
    ...validState(),
    isPlaceholder: true,
    jurisdictionRuleSetId: 'pk_pb_placeholder_v1',
    provinceCode: 'PB',
    premises: { label: 'PLACEHOLDER – not a real licence' },
    branch: { active: true, provinceCode: 'PB', addressLine: '12 Mall Road', city: 'Lahore' },
    jurisdictionRuleSet: validState().ruleSet,
    ...overrides,
  });
  const dbFor = (profile: unknown) =>
    ({ branchRegulatoryProfile: { findFirst: vi.fn(async () => profile) } }) as never;
  const activate = { name: 'ACTIVATE', at };

  it('keeps a pre-binding placeholder ready to activate', async () => {
    await expect(
      assertStoredBranchMayOperate(dbFor(legacyPlaceholder()), 'org-a', 'branch-a', activate)
    ).resolves.toBeUndefined();
    expect(isLegacyPlaceholderProfile(legacyPlaceholder())).toBe(true);
  });

  it('still refuses a grandfathered placeholder off-branch or off-province', async () => {
    await expect(
      assertStoredBranchMayOperate(
        dbFor(legacyPlaceholder({ branch: { ...legacyPlaceholder().branch, active: false } })),
        'org-a',
        'branch-a',
        activate
      )
    ).rejects.toThrowError(new BranchOperationDeniedError('BRANCH_INACTIVE'));
    await expect(
      assertStoredBranchMayOperate(
        dbFor(legacyPlaceholder({ provinceCode: 'SD' })),
        'org-a',
        'branch-a',
        activate
      )
    ).rejects.toThrowError(new BranchOperationDeniedError('PROFILE_PREMISES_MISMATCH'));
  });

  it.each([
    ['a tenant-recorded profile', { isPlaceholder: false }],
    ['another rule set', { jurisdictionRuleSetId: 'pk_pb_v2' }],
    ['a placeholder that already records an address', { premises: { addressLine: '9 Elsewhere' } }],
  ])('does not grandfather %s with incomplete premises', async (_case, overrides) => {
    const profile = legacyPlaceholder(overrides);
    expect(isLegacyPlaceholderProfile(profile)).toBe(false);
    await expect(
      assertStoredBranchMayOperate(dbFor(profile), 'org-a', 'branch-a', activate)
    ).rejects.toThrowError(new BranchOperationDeniedError('PROFILE_PREMISES_MISMATCH'));
  });
});

describe('regulatoryProfileBindingDenial', () => {
  const site = { active: true, provinceCode: 'PB', addressLine: '12 Mall Road', city: 'Lahore' };

  it('is shared by guard and status: bound, inactive, and mismatched profiles', () => {
    const bound = {
      provinceCode: 'PK-PB',
      premises: { addressLine: '12 mall road', city: 'Lahore' },
    };
    expect(regulatoryProfileBindingDenial(bound, site)).toBeNull();
    expect(regulatoryProfileBindingDenial(bound, { ...site, active: false })).toBe(
      'BRANCH_INACTIVE'
    );
    expect(
      regulatoryProfileBindingDenial({ ...bound, premises: { addressLine: '', city: '' } }, {
        ...site,
        addressLine: '',
        city: '',
      })
    ).toBe('PROFILE_PREMISES_MISMATCH');
  });
});

describe('evaluateBranchRegulatoryStatus', () => {
  it('stops reporting in force at the exact licence-expiry instant', () => {
    const state = validState();
    state.licenceValidTo = new Date('2026-10-21T00:00:00.000Z');
    const { auditDenied: _auditDenied, ...profile } = state;

    expect(
      evaluateBranchRegulatoryStatus(profile, true, new Date('2026-10-20T23:59:59.999Z'))
    ).toMatchObject({ effective: true, inForce: true, licenceExpired: false });
    expect(
      evaluateBranchRegulatoryStatus(profile, true, new Date('2026-10-21T00:00:00.000Z'))
    ).toMatchObject({ effective: true, inForce: false, licenceExpired: true });
  });

  it('agrees with the stored guard on province and premises binding', () => {
    const { auditDenied: _auditDenied, ...profile } = validState();
    const site = { active: true, provinceCode: 'PB', addressLine: '12 Mall Road', city: 'Lahore' };
    const bound = {
      provinceCode: 'PK-PB',
      premises: { addressLine: '12 Mall Road', city: 'Lahore' },
    };

    expect(
      evaluateBranchRegulatoryStatus(profile, true, at, { profile: bound, site })
    ).toMatchObject({ effective: true, inForce: true });
    for (const mismatched of [
      { ...bound, provinceCode: 'PK-SD' },
      { ...bound, premises: { addressLine: '99 Other Road', city: 'Lahore' } },
      { ...bound, premises: { addressLine: '12 Mall Road', city: 'Karachi' } },
      { ...bound, premises: { label: 'missing premises' } },
    ]) {
      expect(
        evaluateBranchRegulatoryStatus(profile, true, at, { profile: mismatched, site })
      ).toMatchObject({ effective: true, inForce: false });
    }
    expect(
      evaluateBranchRegulatoryStatus(profile, true, at, {
        profile: bound,
        site: { ...site, active: false },
      })
    ).toMatchObject({ inForce: false });
  });

  it('does not call a historical, ineffective version in force', () => {
    const { auditDenied: _auditDenied, ...profile } = validState();

    expect(evaluateBranchRegulatoryStatus(profile, false, at)).toMatchObject({
      effective: false,
      inForce: false,
      licenceExpired: false,
      qualifiedPersonCoverageExpired: false,
    });
  });
});
