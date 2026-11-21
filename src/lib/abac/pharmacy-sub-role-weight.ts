/**
 * DEV-959B — the pharmacy sub-roles that carry extra weight: dispensing, prescriptions,
 * controlled medicines, catalogue review, discounts, cash and approvals, day close, purchase
 * approvals, purchasing and receiving, stock control and financial reports. Only the owner
 * ticks or unticks one, with the owner's own fresh approval through the shared verifier, and
 * the screen shows the one line here before the change.
 * Every exact-grant-only (sensitive) sub-role is weighty; `pharmacy-sub-role-weight.test.ts`
 * holds that, and each line to the sub-role's own description.
 */
export const PHARMACY_WEIGHTY_SUB_ROLES: Readonly<Record<string, string>> = {
  'give-discounts':
    "Gives counter discounts without a manager's PIN, within your maximum discount and minimum margin.",
  'dispense-prescriptions':
    'Sells prescription-only and restricted medicines and signs prescription lines off at their branch.',
  'record-prescriptions':
    'Opens patient records and prescription photos, and records prescriptions and consents.',
  'review-catalogue':
    "Approves other people's medicine catalogue changes, including prices, which applies them.",
  'controlled-medicines':
    'Works the controlled medicines register and manages recalls for the whole pharmacy.',
  'run-branches': 'Runs the cash drawers, refunds and approvals at their branches.',
  'close-the-day': 'Closes the day for every branch, with or without a branch assignment.',
  'approve-purchase-orders':
    'Approves purchase orders someone else raised and sends approved orders to suppliers.',
  'receive-stock':
    'Adds suppliers, raises and submits purchase orders, and receives, posts and reverses deliveries at their branches.',
  'manage-stock':
    'Runs stock at their branches, including write-offs, releasing quarantine, transfers and receiving without a purchase order.',
  'manage-finance-accounts':
    'Changes supplier payments and reversals, journal entries, bank reconciliation, accounting periods and tax profiles.',
  'read-finance-accounts':
    'Sees supplier balances, payments, reversals, bank records and the general journal.',
  'financial-reports':
    'Sees sales, margin, cash, refund, payables, receivables and khata figures, and stock value at risk.',
};

export function isWeightyPharmacySubRole(key: string): boolean {
  return Object.hasOwn(PHARMACY_WEIGHTY_SUB_ROLES, key);
}
