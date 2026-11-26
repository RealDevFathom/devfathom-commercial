import 'server-only';

import {
  clearRateLimit,
  rateLimitHasCapacity,
  rateLimit,
  refundRateLimit,
  type RateLimitResult,
} from '@/lib/rate-limit';
import { LOCKOUT_DURATION_MS, MAX_FAILED_ATTEMPTS } from '@/lib/restaurant/operator-credentials';

/**
 * One budget per approver for approval PINs typed by someone else, shared by every approval
 * that does not strike the approver's own credential for such a guess (purchase approval and
 * the cash-shift over or short, DEV-958B).
 *
 * The approval PIN is the approver's shared operator credential. A guess typed by somebody
 * else must not lock the approver out of their own refunds and approvals, so it does not
 * strike that credential; it spends this budget instead: the same five attempts per lockout
 * window, counted across all those features together, never per feature. A wrong PIN the
 * approver types themselves still strikes their credential.
 */
function budgetKey(organizationId: string, approverId: string) {
  return `approver-pin-typed-by-another:${organizationId}:${approverId}`;
}

export function approverGuessBudgetAvailable(organizationId: string, approverId: string) {
  return rateLimitHasCapacity(budgetKey(organizationId, approverId), MAX_FAILED_ATTEMPTS);
}

/** Spends one guess. `ok: false` once the approver's budget for this window is gone. */
export function spendApproverPinGuessTypedByAnother(organizationId: string, approverId: string) {
  return rateLimit(budgetKey(organizationId, approverId), MAX_FAILED_ATTEMPTS, LOCKOUT_DURATION_MS);
}

/** A correct PIN restores the approver's budget, as a correct PIN clears their strikes. */
export function clearApproverPinGuessesTypedByAnother(organizationId: string, approverId: string) {
  return clearRateLimit(budgetKey(organizationId, approverId));
}

/** Release only the reservation whose multi-person comparison did not need to spend it. */
export function refundApproverPinGuessTypedByAnother(
  organizationId: string,
  approverId: string,
  reservation: RateLimitResult
) {
  return refundRateLimit(budgetKey(organizationId, approverId), LOCKOUT_DURATION_MS, reservation);
}
