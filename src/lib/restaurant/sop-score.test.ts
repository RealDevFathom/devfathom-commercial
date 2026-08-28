/**
 * WHA-226 — SOP performance scoring unit tests.
 *
 * Covers: outcome classification including the shared missed boundary (a score
 * must not depend on whether the sweep job has run), the published formula and
 * its denominator, exclusion of waived and pending work, the no-data case that
 * must never be 0, and deterministic primary-contributor attribution.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  LATE_CREDIT,
  SCORE_FORMULA,
  classifyOccurrence,
  primaryContributor,
  scoreFromCounts,
  scoreOccurrences,
  type ScorableOccurrence,
} from './sop-score';
import { isMissedAt } from './sop-late-missed';

const WINDOW_ENDS = new Date('2026-08-20T12:00:00.000Z');

function occ(over: Partial<ScorableOccurrence> = {}): ScorableOccurrence {
  return {
    id: 'occ_1',
    status: 'SCHEDULED',
    windowEndsAt: WINDOW_ENDS,
    submittedAt: null,
    graceMinutes: 0,
    ...over,
  };
}

const counts = (over: Partial<Record<string, number>> = {}) => ({
  onTime: 0,
  late: 0,
  missed: 0,
  rejected: 0,
  waived: 0,
  pending: 0,
  ...over,
});

describe('classifyOccurrence', () => {
  it('treats a submission at exactly windowEndsAt as on time', () => {
    // The boundary is strict everywhere else in the engine (submitOccurrence uses
    // `now > windowEndsAt`); scoring must claim the same instant the same way.
    expect(
      classifyOccurrence(occ({ status: 'SUBMITTED', submittedAt: WINDOW_ENDS }), WINDOW_ENDS)
    ).toBe('ON_TIME');
    expect(
      classifyOccurrence(
        occ({ status: 'SUBMITTED', submittedAt: new Date(WINDOW_ENDS.getTime() + 1) }),
        WINDOW_ENDS
      )
    ).toBe('LATE');
  });

  it('reads punctuality from the submission instant, not the status', () => {
    // VERIFIED overwrites LATE, so the status alone loses the fact that the
    // window was missed. The timestamp is the durable record.
    const verifiedLate = occ({
      status: 'VERIFIED',
      submittedAt: new Date(WINDOW_ENDS.getTime() + 60_000),
    });
    expect(classifyOccurrence(verifiedLate, new Date('2026-08-21T00:00:00.000Z'))).toBe('LATE');

    const lateStatusOnTimeStamp = occ({ status: 'LATE', submittedAt: WINDOW_ENDS });
    expect(classifyOccurrence(lateStatusOnTimeStamp, WINDOW_ENDS)).toBe('ON_TIME');
  });

  it('derives MISSED from the shared boundary before the sweep has run', () => {
    const graceMinutes = 30;
    const past = new Date(WINDOW_ENDS.getTime() + 31 * 60_000);
    const stillScheduled = occ({ status: 'SCHEDULED', graceMinutes });

    // The row still says SCHEDULED because the sweep is a scheduled job, yet the
    // boundary has passed — scoring agrees with sop-late-missed, not with status.
    expect(isMissedAt(past, WINDOW_ENDS, graceMinutes)).toBe(true);
    expect(classifyOccurrence(stillScheduled, past)).toBe('MISSED');

    // A swept row classifies identically, so the score is unchanged by the sweep.
    expect(classifyOccurrence(occ({ status: 'MISSED', graceMinutes }), past)).toBe('MISSED');
  });

  it('is PENDING at exactly the missed boundary and inside the window', () => {
    const graceMinutes = 30;
    const boundary = new Date(WINDOW_ENDS.getTime() + graceMinutes * 60_000);
    expect(classifyOccurrence(occ({ graceMinutes }), boundary)).toBe('PENDING');
    expect(classifyOccurrence(occ({ graceMinutes }), WINDOW_ENDS)).toBe('PENDING');
  });

  it('honours resolved statuses outright', () => {
    const later = new Date('2026-08-30T00:00:00.000Z');
    expect(classifyOccurrence(occ({ status: 'WAIVED' }), later)).toBe('WAIVED');
    expect(classifyOccurrence(occ({ status: 'REJECTED' }), later)).toBe('REJECTED');
  });

  it('classifies a submitted-but-unverified occurrence, never as missed', () => {
    // Submitted work awaiting a verifier is PENDING only when the instant is
    // absent; with a timestamp it is already scoreable.
    const submitted = occ({ status: 'SUBMITTED', submittedAt: WINDOW_ENDS, graceMinutes: 0 });
    const wellPast = new Date(WINDOW_ENDS.getTime() + 10 * 86_400_000);
    expect(classifyOccurrence(submitted, wellPast)).toBe('ON_TIME');
  });
});

describe('scoreFromCounts', () => {
  it('publishes the formula, the denominator and the late credit alongside the score', () => {
    const result = scoreFromCounts(counts({ onTime: 3, late: 1 }));
    expect(result.denominator).toBe(4);
    expect(result.ratio).toBeCloseTo((3 + LATE_CREDIT) / 4, 12);
    expect(result.score).toBe(87.5);
    expect(result.formula).toBe(SCORE_FORMULA);
    expect(result.lateCredit).toBe(LATE_CREDIT);
  });

  it('returns null with NO_DATA rather than 0 when nothing is scoreable', () => {
    // A person with no scored work has not failed. 0 would defame them.
    const result = scoreFromCounts(counts({ waived: 4, pending: 2 }));
    expect(result.score).toBeNull();
    expect(result.ratio).toBeNull();
    expect(result.reason).toBe('NO_DATA');
    expect(result.denominator).toBe(0);
    expect(result.excluded).toEqual({ waived: 4, pending: 2 });
  });

  it('excludes waived and pending from the denominator but still reports them', () => {
    const result = scoreFromCounts(counts({ onTime: 1, waived: 9, pending: 5 }));
    expect(result.denominator).toBe(1);
    expect(result.score).toBe(100);
    // The exclusions are visible, so a 100% built on one occurrence and nine
    // waivers cannot be read as an unqualified 100%.
    expect(result.excluded).toEqual({ waived: 9, pending: 5 });
  });

  it('scores missed and rejected as zero credit inside the denominator', () => {
    const result = scoreFromCounts(counts({ onTime: 1, missed: 1, rejected: 2 }));
    expect(result.denominator).toBe(4);
    expect(result.score).toBe(25);
  });

  it('bounds the score to [0, 100]', () => {
    expect(scoreFromCounts(counts({ missed: 3 })).score).toBe(0);
    expect(scoreFromCounts(counts({ onTime: 3 })).score).toBe(100);
  });
});

describe('scoreOccurrences', () => {
  it('classifies and tallies a mixed set at one instant', () => {
    const asOf = new Date(WINDOW_ENDS.getTime() + 2 * 3_600_000);
    const result = scoreOccurrences(
      [
        occ({ id: 'a', status: 'VERIFIED', submittedAt: WINDOW_ENDS }),
        occ({ id: 'b', status: 'VERIFIED', submittedAt: new Date(WINDOW_ENDS.getTime() + 60_000) }),
        occ({ id: 'c', status: 'SCHEDULED', graceMinutes: 0 }), // boundary passed -> MISSED
        occ({ id: 'd', status: 'WAIVED' }),
        occ({ id: 'e', status: 'SCHEDULED', graceMinutes: 24 * 60 }), // still open
      ],
      asOf
    );
    expect(result.counts).toEqual(counts({ onTime: 1, late: 1, missed: 1, waived: 1, pending: 1 }));
    expect(result.denominator).toBe(3);
    expect(result.ratio).toBeCloseTo((1 + LATE_CREDIT) / 3, 12);
  });

  it('is a pure function of (data, asOf)', () => {
    const set = [occ({ id: 'a', status: 'SCHEDULED', graceMinutes: 15 })];
    const asOf = new Date(WINDOW_ENDS.getTime() + 16 * 60_000);
    expect(scoreOccurrences(set, asOf)).toEqual(scoreOccurrences(set, asOf));
  });

  it('scores an empty set as NO_DATA', () => {
    expect(scoreOccurrences([], WINDOW_ENDS).reason).toBe('NO_DATA');
  });
});

describe('primaryContributor', () => {
  const at = (iso: string) => new Date(iso);

  it('credits the operator who completed the most steps', () => {
    expect(
      primaryContributor([
        { completedByStaffProfileId: 'staff_a', completedAt: at('2026-08-20T09:00:00.000Z') },
        { completedByStaffProfileId: 'staff_b', completedAt: at('2026-08-20T09:01:00.000Z') },
        { completedByStaffProfileId: 'staff_a', completedAt: at('2026-08-20T09:02:00.000Z') },
      ])
    ).toBe('staff_a');
  });

  it('breaks an equal-count tie by earliest completion', () => {
    expect(
      primaryContributor([
        { completedByStaffProfileId: 'staff_z', completedAt: at('2026-08-20T09:00:00.000Z') },
        { completedByStaffProfileId: 'staff_a', completedAt: at('2026-08-20T09:05:00.000Z') },
      ])
    ).toBe('staff_z');
  });

  it('breaks a full tie by id, so row order cannot change the answer', () => {
    const same = at('2026-08-20T09:00:00.000Z');
    const rows = [
      { completedByStaffProfileId: 'staff_b', completedAt: same },
      { completedByStaffProfileId: 'staff_a', completedAt: same },
    ];
    expect(primaryContributor(rows)).toBe('staff_a');
    expect(primaryContributor([...rows].reverse())).toBe('staff_a');
  });

  it('ignores unattributed steps and returns null when nobody is recorded', () => {
    expect(
      primaryContributor([
        { completedByStaffProfileId: null, completedAt: at('2026-08-20T09:00:00.000Z') },
        { completedByStaffProfileId: 'staff_a', completedAt: null },
      ])
    ).toBe('staff_a');
    expect(primaryContributor([{ completedByStaffProfileId: null, completedAt: null }])).toBeNull();
    expect(primaryContributor([])).toBeNull();
  });
});
