import 'server-only';

/**
 * PH-MIG / MIG-05 — the first-close rule.
 *
 * The switching offer promises the incumbent's totals reconcile before the first
 * DevFathom close is treated as final. So `firstCloseIsFinal` answers one
 * question — may THIS branch's next close be final? — and it is the ONLY thing
 * POS-B's daily close imports from PH-MIG. Keeping the integration to a single
 * exported helper is what stops the close growing a migration-shaped dependency
 * it would carry forever, long after the branch has switched.
 *
 * The rule has three states, and the middle one is the point of the exercise:
 *
 *   1. No parallel run was ever opened for this branch → the branch did not
 *      switch, so there is no legacy total to reconcile against. Final.
 *   2. A parallel run exists but its comparisons still carry a material,
 *      unexplained variance → NOT final. This is the state MIG-05 exists for.
 *   3. A parallel run exists and reconciles → final.
 *
 * Note what state 1 does NOT do: it does not treat "we haven't compared anything
 * yet" as reconciled. A branch with an open parallel run and no comparisons at
 * all is not final, because the absence of a comparison is not evidence that the
 * numbers agree.
 *
 * Materiality is the D05 threshold, resolved per branch and defaulting to zero
 * (see `materialityThreshold`), which means an unset contract threshold delays
 * finality rather than granting it. Each comparison already carries the
 * threshold it was judged against and the resulting `material` flag, so this
 * module reads the verdict rather than re-deciding it.
 *
 * DEPENDENCY DIRECTION. This module reads the comparison rows directly instead
 * of calling `parallelRunReconciliation`, because `parallel-run` imports the
 * settlement folds and `settlement` imports this helper — going through it would
 * close an import cycle. The query below is the same predicate, stated once.
 */
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type FirstCloseVerdict = {
  isFinal: boolean;
  reason:
    | 'NO_PARALLEL_RUN'
    | 'NO_COMPARISONS_YET'
    | 'UNEXPLAINED_VARIANCE'
    | 'RECONCILED'
    | 'ALREADY_FINAL';
  unexplainedCount: number;
};

/**
 * MIG-05 — whether this branch's next daily close may be final, with the reason.
 *
 * `firstCloseIsFinal` below is the boolean the daily close consults; this
 * function is the same decision with its justification attached, for the
 * migration console and for tests that need to distinguish "nothing to
 * reconcile" from "reconciled".
 */
export async function firstCloseVerdict(
  db: ScopedDb,
  organizationId: string,
  branchId: string
): Promise<FirstCloseVerdict> {
  const windowCount = await db.pharmacyParallelRunWindow.count({
    where: { organizationId, branchId },
  });

  // A branch that never ran in parallel never made the switching promise.
  if (windowCount === 0) {
    return { isFinal: true, reason: 'NO_PARALLEL_RUN', unexplainedCount: 0 };
  }

  // Once a final close exists the rule has already been satisfied for this
  // branch; it gates the FIRST close, not every close forever.
  const priorFinalClose = await db.pharmacyDailyClose.findFirst({
    where: { organizationId, branchId, isFinal: true },
  });
  if (priorFinalClose) {
    return { isFinal: true, reason: 'ALREADY_FINAL', unexplainedCount: 0 };
  }

  const [comparisonCount, unexplainedCount] = await Promise.all([
    db.pharmacyParallelRunComparison.count({ where: { organizationId, branchId } }),
    db.pharmacyParallelRunComparison.count({
      where: { organizationId, branchId, material: true, explained: false },
    }),
  ]);

  if (comparisonCount === 0) {
    return { isFinal: false, reason: 'NO_COMPARISONS_YET', unexplainedCount: 0 };
  }
  if (unexplainedCount > 0) {
    return { isFinal: false, reason: 'UNEXPLAINED_VARIANCE', unexplainedCount };
  }
  return { isFinal: true, reason: 'RECONCILED', unexplainedCount: 0 };
}

/**
 * MIG-05 — THE helper POS-B's daily close consults.
 *
 * False until the parallel-run comparison for the first close has zero
 * unexplained variance above the D05 threshold.
 */
export async function firstCloseIsFinal(
  db: ScopedDb,
  organizationId: string,
  branchId: string
): Promise<boolean> {
  return (await firstCloseVerdict(db, organizationId, branchId)).isFinal;
}
