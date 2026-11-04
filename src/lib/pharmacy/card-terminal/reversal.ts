import 'server-only';

import type { TerminalIntent } from './intent';
import { TERMINAL_UNRESOLVED_STATES } from './intent';

/**
 * DEV-743 — VOID / REFUND decision contract for an integrated terminal SALE.
 *
 * Pure: it only decides. It never falls back to cash on its own. Settlement's
 * existing `manualCashFallback` path stays an explicit, separately authorized choice.
 *
 *  - VOID: the full amount, nothing reversed yet, the provider batch still open, and
 *    the provider supports VOID. A void cancels the authorization before settlement.
 *  - REFUND: anything else within the uncaptured remainder, if the provider supports it.
 *  - BLOCKED: never guess. The counter shows the reason and a person decides.
 */

export type ReversalBlockReason =
  | 'NOT_A_SALE'
  | 'SALE_NOT_SETTLED'
  | 'MISSING_PROVIDER_REF'
  | 'PRIOR_REVERSAL_UNRESOLVED'
  | 'EXCEEDS_REMAINING'
  | 'INVALID_AMOUNT'
  | 'REVERSAL_UNSUPPORTED';

export type ReversalPlan =
  | { kind: 'VOID'; amountMinor: number; remainingAfterMinor: number }
  | { kind: 'REFUND'; amountMinor: number; remainingAfterMinor: number }
  | { kind: 'BLOCKED'; reason: ReversalBlockReason };

export function planTerminalReversal(input: {
  saleIntent: TerminalIntent;
  /** Every VOID/REFUND intent that reverses `saleIntent`. */
  reversals: readonly TerminalIntent[];
  requestedMinor: number;
  batchOpen: boolean;
  supportsVoid: boolean;
  supportsRefund: boolean;
}): ReversalPlan {
  const { saleIntent, reversals, requestedMinor } = input;
  if (saleIntent.kind !== 'SALE') return { kind: 'BLOCKED', reason: 'NOT_A_SALE' };
  // Only a charge recorded as a tender can be reversed through settlement. An
  // approved-unsettled charge is reconciled first (it may be an orphan charge).
  if (saleIntent.state !== 'SETTLED') return { kind: 'BLOCKED', reason: 'SALE_NOT_SETTLED' };
  if (!saleIntent.providerRef) return { kind: 'BLOCKED', reason: 'MISSING_PROVIDER_REF' };
  if (!Number.isSafeInteger(requestedMinor) || requestedMinor <= 0)
    return { kind: 'BLOCKED', reason: 'INVALID_AMOUNT' };

  const own = reversals.filter((row) => row.reversesIntentRef === saleIntent.intentRef);
  if (own.some((row) => TERMINAL_UNRESOLVED_STATES.has(row.state)))
    return { kind: 'BLOCKED', reason: 'PRIOR_REVERSAL_UNRESOLVED' };
  const reversedMinor = own
    .filter((row) => row.state === 'APPROVED' || row.state === 'SETTLED')
    .reduce((sum, row) => sum + row.amountMinor, 0);
  const remaining = saleIntent.amountMinor - reversedMinor;
  if (requestedMinor > remaining) return { kind: 'BLOCKED', reason: 'EXCEEDS_REMAINING' };

  const remainingAfterMinor = remaining - requestedMinor;
  if (
    input.supportsVoid &&
    input.batchOpen &&
    reversedMinor === 0 &&
    requestedMinor === saleIntent.amountMinor
  )
    return { kind: 'VOID', amountMinor: requestedMinor, remainingAfterMinor };
  if (input.supportsRefund)
    return { kind: 'REFUND', amountMinor: requestedMinor, remainingAfterMinor };
  return { kind: 'BLOCKED', reason: 'REVERSAL_UNSUPPORTED' };
}
