import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const HOUR = 3_600_000;
/**
 * Scores are refreshed nightly; anything older than this means scoring has
 * stopped for the branch (deactivated, CRM lapsed, job failing) and the score
 * no longer describes the customer, so it is ignored (fail closed).
 */
export const CHURN_SCORE_MAX_AGE_MS = 48 * HOUR;

export type CurrentChurnScore = { churnScore: number; scoredAt: Date };

/** Current (non-stale) churn scores for the given customers of one branch. */
export async function readCustomerChurnScores(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  customerIds: string[],
  now: Date
): Promise<Map<string, CurrentChurnScore>> {
  if (customerIds.length === 0) return new Map();
  const rows = await db.pharmacyCustomerChurnScore.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: { in: customerIds },
      scoredAt: { gte: new Date(now.getTime() - CHURN_SCORE_MAX_AGE_MS) },
    },
    select: { customerId: true, churnScore: true, scoredAt: true },
  });
  return new Map(
    rows.map((row) => [row.customerId, { churnScore: row.churnScore, scoredAt: row.scoredAt }])
  );
}

/**
 * The churn score usable for segment matching, or undefined. A receipt
 * completed after the score was computed invalidates it: the customer has
 * just returned, so last night's churn risk no longer applies until rescored.
 */
export function usableChurnScore(
  score: CurrentChurnScore | undefined,
  lastCompletedAt: Date
): number | undefined {
  if (!score || lastCompletedAt > score.scoredAt) return undefined;
  return score.churnScore;
}
