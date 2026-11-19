/**
 * #708 hold — the Sindh Drugs Rules r.18 cash memo is built but not live.
 *
 * Live use waits for counsel to confirm the walk-in buyer, line items and
 * signature wording under rule 18. Until then every sale completes with the
 * ordinary receipt, even when the branch's regulatory profile names Sindh.
 *
 * This is deliberately a hard-coded constant: no setting, environment flag or
 * migration can turn the memo on. Lifting the hold is a reviewed code change.
 * Receipts already issued keep the identity they were frozen with.
 */
export const SINDH_CASH_MEMO_LIVE: boolean = false;
