/**
 * DEV-959B — the pharmacy sub-roles that carry extra weight when an owner ticks them for a
 * person: dispensing, prescriptions, controlled medicines, catalogue review, discounts, cash
 * and approvals, day close and purchase approvals. Ticking one needs the editor's fresh PIN
 * (the shared approval path), and the screen shows the one line here before it is given.
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
};

export function isWeightyPharmacySubRole(key: string): boolean {
  return Object.hasOwn(PHARMACY_WEIGHTY_SUB_ROLES, key);
}
