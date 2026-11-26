import 'server-only';

import { clearRateLimit, rateLimit } from '@/lib/rate-limit';
import { LOCKOUT_DURATION_MS, MAX_FAILED_ATTEMPTS } from '@/lib/restaurant/operator-credentials';

/**
 * DEV-1055: a per-approver budget for back-office approvals that verify a manager's
 * PIN or badge inside the request's own transaction (device revoke, device rotate,
 * camera gateway revoke).
 *
 * Those requests answer a wrong credential with an error, and an error rolls the
 * request transaction back, taking the durable strike on the credential row with
 * it. Without a counter outside that transaction, a signed-in caller could guess
 * a manager's PIN without limit. This budget lives in the rate-limit store, which
 * does not belong to the request transaction: the same five attempts per lockout
 * window as the credential itself, per approver, shared by all three approvals.
 * A correct credential restores it, as a correct PIN clears the strikes.
 */
function budgetKey(organizationId: string, approvingStaffProfileId: string) {
  return `restaurant-approver-credential:${organizationId}:${approvingStaffProfileId}`;
}

/** Spends one attempt. `ok: false` once the approver's budget for this window is gone. */
export function spendRestaurantApproverAttempt(
  organizationId: string,
  approvingStaffProfileId: string
) {
  return rateLimit(
    budgetKey(organizationId, approvingStaffProfileId),
    MAX_FAILED_ATTEMPTS,
    LOCKOUT_DURATION_MS
  );
}

/** A verified credential restores the approver's budget. */
export function clearRestaurantApproverAttempts(
  organizationId: string,
  approvingStaffProfileId: string
) {
  return clearRateLimit(budgetKey(organizationId, approvingStaffProfileId));
}

type ApproverAuthResult =
  | { ok: true }
  | { ok: false; reason: 'LOCKED'; retryAfterMs: number }
  | { ok: false; reason: string };

/**
 * Verify an approver's credential inside their budget. An exhausted budget
 * answers `LOCKED` WITHOUT running `authenticate`, so no credential is compared;
 * a verified credential restores the budget.
 */
export async function authenticateApproverWithinBudget<T extends ApproverAuthResult>(
  organizationId: string,
  approvingStaffProfileId: string,
  authenticate: () => Promise<T>
): Promise<T | { ok: false; reason: 'LOCKED'; retryAfterMs: number }> {
  const budget = await spendRestaurantApproverAttempt(organizationId, approvingStaffProfileId);
  if (!budget.ok) return { ok: false, reason: 'LOCKED', retryAfterMs: budget.retryAfter * 1000 };
  const auth = await authenticate();
  if (auth.ok) await clearRestaurantApproverAttempts(organizationId, approvingStaffProfileId);
  return auth;
}
