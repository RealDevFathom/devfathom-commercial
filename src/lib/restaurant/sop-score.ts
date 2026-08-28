import 'server-only';

import { isMissedAt } from '@/lib/restaurant/sop-late-missed';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * WHA-226 / §11.5 — SOP performance scoring.
 *
 * ## The formula is part of the contract
 *
 * A compliance score is used to judge people, so every term of it is published
 * alongside the number rather than buried in this file. `scoreOccurrences`
 * returns the window, the denominator, the exclusion counts and the per-outcome
 * tallies that produced the score, and `SCORE_FORMULA` states the arithmetic in
 * one line. A caller can always reconstruct the number from the breakdown.
 *
 *   score = (onTime * 1 + late * LATE_CREDIT) / denominator * 100
 *   denominator = onTime + late + missed + rejected
 *
 * A LATE occurrence earns partial credit (`LATE_CREDIT`): the work was done, but
 * not inside its window. MISSED and REJECTED earn none. The score is a
 * percentage in [0, 100], rounded to one decimal place at the edge only — the
 * raw ratio is returned too, so downstream aggregation never compounds rounding.
 *
 * ## Exclusions are counted, never silently dropped
 *
 * Two classes of occurrence are removed from the denominator:
 *
 *   WAIVED   — a manager excused it (sop-verification.ts). Excusing work must not
 *              also penalise the operator, so it leaves the denominator entirely.
 *   PENDING  — still inside its window, or submitted and awaiting a verifier.
 *              The outcome is not known yet; scoring it either way would be a
 *              guess that changes when someone gets around to verifying.
 *
 * Both are reported as counts on the breakdown, so a score of 100% over one
 * occurrence with nine waivers is visibly that, not an unqualified 100%.
 *
 * ## No data is not zero
 *
 * When the denominator is 0 the score is `null` with `reason: 'NO_DATA'` — never
 * 0. A person with no scored occurrences has not failed; reporting 0% would
 * defame them, and reporting 100% would reward absence. Callers must render the
 * null case explicitly.
 *
 * ## Determinism
 *
 * Classification never reads `status` alone for an unsubmitted occurrence. The
 * late/missed sweep (sop-late-missed.ts) is a scheduled job, so a SCHEDULED row
 * whose grace boundary has passed is MISSED in fact but still says SCHEDULED
 * until the sweep next runs. Scoring therefore re-derives that boundary with the
 * sweep's own `isMissedAt`, which makes a score a function of (data, asOf) alone
 * — identical whether or not the sweep has caught up. The two modules share one
 * definition of the boundary, so they can never disagree.
 *
 * ## Attribution
 *
 * An occurrence is credited to the person who did the work, which for a role-pool
 * task is the claiming/completing operator rather than the pool. The only
 * person-level signal on the schema at this base is
 * `RestaurantSopOccurrenceStep.completedByStaffProfileId`, so the occurrence is
 * attributed to its PRIMARY CONTRIBUTOR: the operator who completed the most
 * steps, ties broken by earliest completion instant and then by staff-profile id
 * so the result is stable across query orderings. An occurrence with no completed
 * steps has no contributor and is reported under `unattributed` — it still counts
 * at branch level, where the denominator is the branch's own work.
 */

/** Credit awarded for work that was done, but submitted after its window closed. */
export const LATE_CREDIT = 0.5;

/** One-line, user-facing statement of the arithmetic. Rendered next to the score. */
export const SCORE_FORMULA =
  '(on-time + 0.5 x late) / (on-time + late + missed + rejected) x 100; waived and pending are excluded';

/** The outcome a single occurrence contributes to a score. */
export type SopScoreOutcome = 'ON_TIME' | 'LATE' | 'MISSED' | 'REJECTED' | 'WAIVED' | 'PENDING';

/** The minimum an occurrence must carry to be classified and scored. */
export type ScorableOccurrence = {
  id: string;
  status: string;
  windowEndsAt: Date;
  submittedAt: Date | null;
  /** From the parent assignment — the grace added to the window before MISSED. */
  graceMinutes: number;
};

/**
 * Classify one occurrence at instant `asOf`.
 *
 * Resolved statuses win outright: once a verifier has acted (VERIFIED / REJECTED
 * / WAIVED) or the sweep has written MISSED, the record is settled. Everything
 * else is derived from the submission and the shared missed boundary, so an
 * un-swept row scores the same as a swept one.
 */
export function classifyOccurrence(occ: ScorableOccurrence, asOf: Date): SopScoreOutcome {
  switch (occ.status) {
    case 'WAIVED':
      return 'WAIVED';
    case 'REJECTED':
      return 'REJECTED';
    case 'MISSED':
      return 'MISSED';
    case 'VERIFIED':
    case 'SUBMITTED':
    case 'LATE': {
      // Punctuality is a property of the submission instant, not of the status:
      // `LATE` is stamped at submit time and VERIFIED overwrites it, so the
      // timestamp is the only durable record of whether the window was met.
      if (!occ.submittedAt) return 'PENDING';
      return occ.submittedAt.getTime() > occ.windowEndsAt.getTime() ? 'LATE' : 'ON_TIME';
    }
    default: {
      // SCHEDULED / IN_PROGRESS — unsubmitted. Missed in fact once the grace
      // boundary has strictly passed, whether or not the sweep has run yet.
      if (occ.submittedAt) {
        return occ.submittedAt.getTime() > occ.windowEndsAt.getTime() ? 'LATE' : 'ON_TIME';
      }
      return isMissedAt(asOf, occ.windowEndsAt, occ.graceMinutes) ? 'MISSED' : 'PENDING';
    }
  }
}

/** Per-outcome tallies. Every classified occurrence lands in exactly one bucket. */
export type SopScoreCounts = {
  onTime: number;
  late: number;
  missed: number;
  rejected: number;
  waived: number;
  pending: number;
};

export type SopScoreBreakdown = {
  /** Percentage in [0, 100], or null when there is nothing to score. */
  score: number | null;
  /** The unrounded ratio in [0, 1], or null. Aggregate on this, not on `score`. */
  ratio: number | null;
  /** Present only when `score` is null. */
  reason: 'NO_DATA' | null;
  /** onTime + late + missed + rejected. */
  denominator: number;
  /** Occurrences removed from the denominator, by reason. */
  excluded: { waived: number; pending: number };
  counts: SopScoreCounts;
  /** The published arithmetic, carried with the number it produced. */
  formula: string;
  lateCredit: number;
};

const EMPTY_COUNTS: SopScoreCounts = {
  onTime: 0,
  late: 0,
  missed: 0,
  rejected: 0,
  waived: 0,
  pending: 0,
};

/**
 * Score a set of already-classified outcomes. Pure — no clock, no database.
 */
export function scoreFromCounts(counts: SopScoreCounts): SopScoreBreakdown {
  const denominator = counts.onTime + counts.late + counts.missed + counts.rejected;
  const excluded = { waived: counts.waived, pending: counts.pending };

  if (denominator === 0) {
    // No scored work. Not a failure and not a success — see "No data is not zero".
    return {
      score: null,
      ratio: null,
      reason: 'NO_DATA',
      denominator: 0,
      excluded,
      counts,
      formula: SCORE_FORMULA,
      lateCredit: LATE_CREDIT,
    };
  }

  const ratio = (counts.onTime + counts.late * LATE_CREDIT) / denominator;
  return {
    score: Math.round(ratio * 1000) / 10,
    ratio,
    reason: null,
    denominator,
    excluded,
    counts,
    formula: SCORE_FORMULA,
    lateCredit: LATE_CREDIT,
  };
}

/** Classify and score a set of occurrences at `asOf`. Pure. */
export function scoreOccurrences(
  occurrences: readonly ScorableOccurrence[],
  asOf: Date
): SopScoreBreakdown {
  const counts: SopScoreCounts = { ...EMPTY_COUNTS };
  for (const occ of occurrences) {
    switch (classifyOccurrence(occ, asOf)) {
      case 'ON_TIME':
        counts.onTime += 1;
        break;
      case 'LATE':
        counts.late += 1;
        break;
      case 'MISSED':
        counts.missed += 1;
        break;
      case 'REJECTED':
        counts.rejected += 1;
        break;
      case 'WAIVED':
        counts.waived += 1;
        break;
      case 'PENDING':
        counts.pending += 1;
        break;
    }
  }
  return scoreFromCounts(counts);
}

// ── Attribution ───────────────────────────────────────────────────────────────

/** A completed step, reduced to what attribution needs. */
export type ContributorStep = {
  completedByStaffProfileId: string | null;
  completedAt: Date | null;
};

/**
 * The operator an occurrence is credited to: whoever completed the most of its
 * steps. Ties are broken by earliest completion, then by id, so the answer does
 * not depend on the order rows came back in. Returns null when nobody is
 * recorded against any step.
 */
export function primaryContributor(steps: readonly ContributorStep[]): string | null {
  const tally = new Map<string, { count: number; first: number }>();
  for (const step of steps) {
    const id = step.completedByStaffProfileId;
    if (!id) continue;
    const at = step.completedAt ? step.completedAt.getTime() : Number.POSITIVE_INFINITY;
    const entry = tally.get(id);
    if (entry) {
      entry.count += 1;
      if (at < entry.first) entry.first = at;
    } else {
      tally.set(id, { count: 1, first: at });
    }
  }
  if (tally.size === 0) return null;

  let bestId: string | null = null;
  let best = { count: -1, first: Number.POSITIVE_INFINITY };
  for (const [id, entry] of tally) {
    const wins =
      entry.count > best.count ||
      (entry.count === best.count &&
        (entry.first < best.first || (entry.first === best.first && id < bestId!)));
    if (wins) {
      bestId = id;
      best = entry;
    }
  }
  return bestId;
}

// ── Database-backed report ────────────────────────────────────────────────────

export type SopScoreWindow = {
  /** Inclusive first business date of the window. */
  fromBusinessDate: Date;
  /** Inclusive last business date of the window. */
  toBusinessDate: Date;
};

export type SopScoreQuery = SopScoreWindow & {
  branchId?: string | null;
  /** Clock override; defaults to now. Boundary derivation depends on it. */
  asOf?: Date;
};

export type SopStaffScore = {
  staffProfileId: string;
  staffName: string | null;
  breakdown: SopScoreBreakdown;
};

export type SopScoreReport = {
  window: SopScoreWindow;
  asOf: Date;
  branchId: string | null;
  /** Every scored occurrence in the window, regardless of attribution. */
  overall: SopScoreBreakdown;
  /** Per-operator scores, ordered by score descending then name. */
  staff: SopStaffScore[];
  /** Occurrences in the window with no recorded contributor. */
  unattributed: SopScoreBreakdown;
};

/**
 * Build a scoring report over a business-date window.
 *
 * `db` is already tenant-bound under forced RLS, so no organizationId predicate
 * appears here — the branch filter is the only scoping this adds (C1).
 */
export async function buildScoreReport(
  db: ScopedDb,
  query: SopScoreQuery
): Promise<SopScoreReport> {
  const asOf = query.asOf ?? new Date();
  const branchId = query.branchId ?? null;

  const rows = await db.restaurantSopOccurrence.findMany({
    where: {
      businessDate: { gte: query.fromBusinessDate, lte: query.toBusinessDate },
      ...(branchId ? { branchId } : {}),
    },
    select: {
      id: true,
      status: true,
      windowEndsAt: true,
      submittedAt: true,
      assignment: { select: { graceMinutes: true } },
      steps: {
        select: {
          completedByStaffProfileId: true,
          completedAt: true,
          completedBy: { select: { displayName: true } },
        },
      },
    },
  });

  const names = new Map<string, string | null>();
  const perStaff = new Map<string, SopScoreCounts>();
  const overallCounts: SopScoreCounts = { ...EMPTY_COUNTS };
  const unattributedCounts: SopScoreCounts = { ...EMPTY_COUNTS };

  const bump = (counts: SopScoreCounts, outcome: SopScoreOutcome) => {
    if (outcome === 'ON_TIME') counts.onTime += 1;
    else if (outcome === 'LATE') counts.late += 1;
    else if (outcome === 'MISSED') counts.missed += 1;
    else if (outcome === 'REJECTED') counts.rejected += 1;
    else if (outcome === 'WAIVED') counts.waived += 1;
    else counts.pending += 1;
  };

  for (const row of rows) {
    const outcome = classifyOccurrence(
      {
        id: row.id,
        status: row.status,
        windowEndsAt: row.windowEndsAt,
        submittedAt: row.submittedAt,
        graceMinutes: row.assignment?.graceMinutes ?? 0,
      },
      asOf
    );
    bump(overallCounts, outcome);

    const contributor = primaryContributor(row.steps);
    if (!contributor) {
      bump(unattributedCounts, outcome);
      continue;
    }
    if (!names.has(contributor)) {
      const step = row.steps.find((s) => s.completedByStaffProfileId === contributor);
      names.set(contributor, step?.completedBy?.displayName ?? null);
    }
    let counts = perStaff.get(contributor);
    if (!counts) {
      counts = { ...EMPTY_COUNTS };
      perStaff.set(contributor, counts);
    }
    bump(counts, outcome);
  }

  const staff: SopStaffScore[] = [...perStaff.entries()]
    .map(([staffProfileId, counts]) => ({
      staffProfileId,
      staffName: names.get(staffProfileId) ?? null,
      breakdown: scoreFromCounts(counts),
    }))
    // Unscored operators (NO_DATA) sort last; otherwise highest score first, then
    // name, then id — a total order, so the table never reshuffles between reads.
    .sort((a, b) => {
      const av = a.breakdown.ratio ?? -1;
      const bv = b.breakdown.ratio ?? -1;
      if (av !== bv) return bv - av;
      const an = a.staffName ?? '';
      const bn = b.staffName ?? '';
      if (an !== bn) return an.localeCompare(bn);
      return a.staffProfileId.localeCompare(b.staffProfileId);
    });

  return {
    window: { fromBusinessDate: query.fromBusinessDate, toBusinessDate: query.toBusinessDate },
    asOf,
    branchId,
    overall: scoreFromCounts(overallCounts),
    staff,
    unattributed: scoreFromCounts(unattributedCounts),
  };
}
