import { describe, expect, it, vi } from 'vitest';
import {
  assertBranchMayOperate,
  assertStoredBranchMayOperate,
  BranchOperationDeniedError,
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

describe('assertStoredBranchMayOperate branch binding', () => {
  function storedProfile(overrides: Record<string, unknown> = {}) {
    return {
      ...validState(),
      provinceCode: 'PK-PB',
      premises: { addressLine: '12 Mall Road', city: 'Lahore' },
      branch: {
        active: true,
        provinceCode: 'PK-PB',
        addressLine: '12 Mall Road',
        city: 'Lahore',
      },
      jurisdictionRuleSet: validState().ruleSet,
      ...overrides,
    };
  }

  it.each([
    [{ branch: { ...storedProfile().branch, active: false } }, 'BRANCH_INACTIVE'],
    [{ provinceCode: 'PK-SD' }, 'PROFILE_BRANCH_MISMATCH'],
    [{ premises: { addressLine: '99 Unrelated Road', city: 'Lahore' } }, 'PROFILE_BRANCH_MISMATCH'],
  ] as const)('rejects a profile not bound to its active premises', async (overrides, reason) => {
    const db = {
      branchRegulatoryProfile: { findFirst: vi.fn(async () => storedProfile(overrides)) },
    };
    await expect(
      assertStoredBranchMayOperate(db as never, 'org-a', 'branch-a', { name: 'ACTIVATE', at })
    ).rejects.toThrowError(new BranchOperationDeniedError(reason));
    expect(db.branchRegulatoryProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-a', branchId: 'branch-a' }),
        include: { jurisdictionRuleSet: true, branch: true },
      })
    );
  });

  async function operate(
    profile: ReturnType<typeof storedProfile>,
    action = { name: 'ACTIVATE', at }
  ) {
    const db = {
      branchRegulatoryProfile: { findFirst: vi.fn(async () => profile) },
    };
    return assertStoredBranchMayOperate(db as never, 'org-a', 'branch-a', action);
  }

  function legacyPlaceholder(overrides: Record<string, unknown> = {}) {
    const label = 'PLACEHOLDER – not a real licence';
    return storedProfile({
      isPlaceholder: true,
      jurisdictionRuleSetId: 'pk_pb_placeholder_v1',
      jurisdictionRuleSet: { ...validState().ruleSet, isPlaceholder: true },
      licenceNumber: label,
      licenceEvidenceFileRef: label,
      premises: { label },
      ...overrides,
    });
  }

  it('permits a fully bound ordinary profile', async () => {
    await expect(operate(storedProfile())).resolves.toBeUndefined();
  });

  it('preserves the exact existing MFA-protected platform placeholder shape', async () => {
    await expect(operate(legacyPlaceholder())).resolves.toBeUndefined();
  });

  it('accepts structured placeholder profiles with explicit matching premises', async () => {
    const profile = legacyPlaceholder({
      premises: {
        label: 'PLACEHOLDER – not a real licence',
        addressLine: '12 Mall Road',
        city: 'Lahore',
      },
    });
    await expect(operate(profile)).resolves.toBeUndefined();
  });

  it.each([
    { isPlaceholder: false },
    { jurisdictionRuleSetId: 'ordinary-rule' },
    { jurisdictionRuleSet: { ...validState().ruleSet, isPlaceholder: false } },
    { licenceNumber: 'real-licence' },
    { licenceEvidenceFileRef: 'real-evidence.pdf' },
    { premises: { label: 'some missing premises' } },
    { premises: { label: 'PLACEHOLDER – not a real licence', extra: true } },
    {
      premises: {
        label: 'PLACEHOLDER – not a real licence',
        addressLine: 'Another address',
        city: 'Lahore',
      },
    },
    {
      premises: {
        label: 'PLACEHOLDER – not a real licence',
        addressLine: '12 Mall Road',
        city: 'Karachi',
      },
    },
  ])('never widens the legacy placeholder exception: %j', async (overrides) => {
    await expect(operate(legacyPlaceholder(overrides))).rejects.toThrowError(
      new BranchOperationDeniedError('PROFILE_BRANCH_MISMATCH')
    );
  });

  it.each([null, [], 'missing', {}, { addressLine: '12 Mall Road' }])(
    'fails closed for malformed ordinary premises: %j',
    async (premises) => {
      await expect(operate(storedProfile({ premises }))).rejects.toThrowError(
        new BranchOperationDeniedError('PROFILE_BRANCH_MISMATCH')
      );
    }
  );

  it('denies an absent branch rather than throwing an unaudited TypeError', async () => {
    await expect(operate(storedProfile({ branch: null }))).rejects.toThrowError(
      new BranchOperationDeniedError('BRANCH_INACTIVE')
    );
  });

  it('never exempts a legacy placeholder from the active branch check', async () => {
    await expect(
      operate(legacyPlaceholder({ branch: { ...storedProfile().branch, active: false } }))
    ).rejects.toThrowError(new BranchOperationDeniedError('BRANCH_INACTIVE'));
  });

  it('never exempts a legacy placeholder from province binding', async () => {
    await expect(operate(legacyPlaceholder({ provinceCode: 'PK-SD' }))).rejects.toThrowError(
      new BranchOperationDeniedError('PROFILE_BRANCH_MISMATCH')
    );
  });

  it('still checks licence validity for a legacy placeholder', async () => {
    await expect(operate(legacyPlaceholder({ licenceValidTo: at }))).rejects.toThrowError(
      new BranchOperationDeniedError('LICENCE_INVALID')
    );
  });

  it('still checks qualified-person coverage for a legacy placeholder', async () => {
    const profile = legacyPlaceholder({ qualifiedPersonCoverageRosterRef: '' });
    await expect(
      operate(profile, { name: 'DISPENSE', at, requiresQualifiedPerson: true } as never)
    ).rejects.toThrowError(new BranchOperationDeniedError('QUALIFIED_PERSON_COVERAGE_MISSING'));
  });

  it('still checks controlled schedules for a legacy placeholder', async () => {
    const profile = legacyPlaceholder({ permittedSchedules: ['RX'] });
    await expect(
      operate(profile, { name: 'DISPENSE', at, schedule: 'CONTROLLED' } as never)
    ).rejects.toThrowError(new BranchOperationDeniedError('SCHEDULE_NOT_PERMITTED'));
  });
});
