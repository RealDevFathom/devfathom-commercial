import { describe, expect, it, vi } from 'vitest';
import {
  assertBranchMayOperate,
  BranchOperationDeniedError,
  type BranchRegulatoryState,
} from './regulatory';

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

  it('starts date-only validity at midnight in the workspace while preserving expiry instants', () => {
    const state = validState();
    state.licenceValidFrom = new Date('2026-10-21T00:00:00.000Z');
    state.qualifiedPersonValidFrom = new Date('2026-10-21T00:00:00.000Z');
    state.licenceValidTo = new Date('2026-10-22T00:00:00.000Z');

    expect(() =>
      assertBranchMayOperate(
        state,
        {
          name: 'DISPENSE',
          at: new Date('2026-10-20T19:00:00.000Z'),
          schedule: 'RX',
          requiresQualifiedPerson: true,
        },
        'Asia/Karachi'
      )
    ).not.toThrow();
    expect(() =>
      assertBranchMayOperate(
        state,
        {
          name: 'DISPENSE',
          at: new Date('2026-10-20T23:59:59.999Z'),
          schedule: 'RX',
          requiresQualifiedPerson: true,
        },
        'Asia/Karachi'
      )
    ).not.toThrow();

    expect(() =>
      assertBranchMayOperate(
        state,
        { name: 'DISPENSE', at: state.licenceValidTo, requiresQualifiedPerson: false },
        'Asia/Karachi'
      )
    ).toThrowError(new BranchOperationDeniedError('LICENCE_INVALID'));
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
