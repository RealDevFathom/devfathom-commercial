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
    organizationTimezone: 'Asia/Karachi',
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

  it.each(['2026-10-20T19:00:00.000Z', '2026-10-20T23:59:59.999Z'])(
    'permits a licence throughout its first calendar day in the workspace timezone at %s',
    (instant) => {
      const state = validState();
      state.licenceValidFrom = new Date('2026-10-21T00:00:00.000Z');

      expect(() =>
        assertBranchMayOperate(state, {
          name: 'DISPENSE',
          at: new Date(instant),
          schedule: 'RX',
          requiresQualifiedPerson: true,
        })
      ).not.toThrow();
      expect(state.auditDenied).not.toHaveBeenCalled();
    }
  );

  it('refuses a licence before its first calendar day in the workspace timezone', () => {
    const state = validState();
    state.licenceValidFrom = new Date('2026-10-21T00:00:00.000Z');
    expect(() =>
      assertBranchMayOperate(state, {
        name: 'DISPENSE',
        at: new Date('2026-10-20T18:59:59.999Z'),
        schedule: 'RX',
        requiresQualifiedPerson: true,
      })
    ).toThrowError(new BranchOperationDeniedError('LICENCE_INVALID'));
  });

  it.each([
    {
      timezone: 'Asia/Karachi',
      beforeLocalMidnight: '2026-10-20T18:59:59.999Z',
      atLocalMidnight: '2026-10-20T19:00:00.000Z',
    },
    {
      timezone: 'America/New_York',
      beforeLocalMidnight: '2026-10-21T03:59:59.999Z',
      atLocalMidnight: '2026-10-21T04:00:00.000Z',
    },
  ])(
    'applies exclusive licence and qualified-person ends at local midnight in $timezone',
    ({ timezone, beforeLocalMidnight, atLocalMidnight }) => {
      const licenceBefore = validState();
      licenceBefore.organizationTimezone = timezone;
      licenceBefore.licenceValidTo = new Date('2026-10-21T00:00:00.000Z');
      expect(() =>
        assertBranchMayOperate(licenceBefore, {
          name: 'DISPENSE',
          at: new Date(beforeLocalMidnight),
          schedule: 'RX',
          requiresQualifiedPerson: true,
        })
      ).not.toThrow();

      const licenceAtEnd = validState();
      licenceAtEnd.organizationTimezone = timezone;
      licenceAtEnd.licenceValidTo = new Date('2026-10-21T00:00:00.000Z');
      expect(() =>
        assertBranchMayOperate(licenceAtEnd, {
          name: 'DISPENSE',
          at: new Date(atLocalMidnight),
          schedule: 'RX',
          requiresQualifiedPerson: true,
        })
      ).toThrowError(new BranchOperationDeniedError('LICENCE_INVALID'));

      const personBefore = validState();
      personBefore.organizationTimezone = timezone;
      personBefore.qualifiedPersonValidTo = new Date('2026-10-21T00:00:00.000Z');
      expect(() =>
        assertBranchMayOperate(personBefore, {
          name: 'DISPENSE',
          at: new Date(beforeLocalMidnight),
          schedule: 'RX',
          requiresQualifiedPerson: true,
        })
      ).not.toThrow();

      const personAtEnd = validState();
      personAtEnd.organizationTimezone = timezone;
      personAtEnd.qualifiedPersonValidTo = new Date('2026-10-21T00:00:00.000Z');
      expect(() =>
        assertBranchMayOperate(personAtEnd, {
          name: 'DISPENSE',
          at: new Date(atLocalMidnight),
          schedule: 'RX',
          requiresQualifiedPerson: true,
        })
      ).toThrowError(new BranchOperationDeniedError('QUALIFIED_PERSON_COVERAGE_MISSING'));
    }
  );

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
