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

  it('keeps a licence valid through 23:59:59 Asia/Karachi on its expiry date', () => {
    const state = validState();
    state.licenceValidTo = new Date('2026-09-02T00:00:00.000Z');

    expect(() =>
      assertBranchMayOperate(state, {
        name: 'COMPLETE_SALE',
        at: new Date('2026-09-02T18:59:59.999Z'),
        requiresQualifiedPerson: false,
      })
    ).not.toThrow();
  });

  it('fails closed at midnight Asia/Karachi after the expiry date', () => {
    const state = validState();
    state.licenceValidTo = new Date('2026-09-02T00:00:00.000Z');
    expect(() =>
      assertBranchMayOperate(state, {
        name: 'COMPLETE_SALE',
        at: new Date('2026-09-02T19:00:00.000Z'),
        requiresQualifiedPerson: false,
      })
    ).toThrowError(new BranchOperationDeniedError('LICENCE_INVALID'));
    expect(state.auditDenied).toHaveBeenCalledOnce();
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
