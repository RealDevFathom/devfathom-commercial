import { describe, expect, it, vi } from 'vitest';
import {
  assertBranchMayOperate,
  BranchOperationDeniedError,
  pendingLegalReviewAllowed,
  type BranchRegulatoryState,
} from './regulatory';

const at = new Date('2026-09-02T12:00:00.000Z');

function validState(): BranchRegulatoryState {
  return {
    branchId: 'branch-a',
    licenceCategory: 'PHARMACY',
    licenceValidFrom: new Date('2026-01-01T00:00:00.000Z'),
    licenceValidTo: new Date('2027-01-01T00:00:00.000Z'),
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

describe('pending legal review rule sets (#162)', () => {
  const pending = () => {
    const state = validState();
    state.ruleSet.licenceCategories = {
      provisional: false,
      pendingLegalReview: true,
      values: ['PHARMACY'],
    };
    return state;
  };
  const operate = (state: BranchRegulatoryState) =>
    assertBranchMayOperate(state, {
      name: 'DISPENSE',
      at,
      schedule: 'RX',
      requiresQualifiedPerson: true,
    });

  it('allows them outside production, and in staging and pilots', () => {
    expect(pendingLegalReviewAllowed({ NODE_ENV: 'test' })).toBe(true);
    expect(pendingLegalReviewAllowed({ NODE_ENV: 'production', APP_ENV: 'staging' })).toBe(true);
    expect(pendingLegalReviewAllowed({ NODE_ENV: 'production', APP_ENV: 'pilot' })).toBe(true);
    expect(() => operate(pending())).not.toThrow();
  });

  it('refuses them under production enforcement (fail closed when APP_ENV is unset)', () => {
    expect(pendingLegalReviewAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(pendingLegalReviewAllowed({ NODE_ENV: 'production', APP_ENV: 'production' })).toBe(
      false
    );
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ENV', '');
    try {
      expectDenied(pending(), 'RULE_SET_PENDING_LEGAL_REVIEW');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
