/**
 * DEV-959A — the pharmacy sub-role catalogue.
 *
 * A sub-role is a named group of ABAC actions, in plain words, that an owner can read
 * (and, in a later phase, tick) on the team screen. Every pharmacy action belongs to
 * exactly one sub-role, and each sub-role sits under the ready-made role it normally
 * comes with. Sub-roles are display data only: they never grant anything. Which ones a
 * ready-made role has is derived from its real template in `vertical-catalog.ts` with the
 * same rule evaluator the ABAC engine uses (`decideFromRules`), never hand-copied.
 *
 * What a sub-role allows is a list of plain lines, each tied to the places in the code
 * that check its action (`sites`: file and number of uses). `pharmacy-sub-role-sites.test.ts`
 * finds every use of every action and fails until each one is explained here, or listed
 * in `PHARMACY_ACTION_NON_GRANTING_SITES` with a reason, so a description cannot quietly
 * fall behind the code.
 */
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { EXACT_GRANT_ONLY_ACTIONS, decideFromRules } from './capabilities';
import type { Action } from './policies';

/** One thing a sub-role allows, and the uses in the code that back it. */
export type PharmacySubRoleAllowance = {
  /** Stable within its sub-role; procedures refer to a line as `subRoleKey/id`. */
  id: string;
  text: string;
  /** Which of the sub-role's actions this line is about; required when it holds several. */
  action?: Action;
  /** Repository path to the number of uses of the action in that file this line explains. */
  sites: Readonly<Record<string, number>>;
};

export type PharmacySubRoleDefinition = {
  key: string;
  label: string;
  /** Key of the ready-made role (template) this sub-role normally comes with. */
  homeRole: string;
  actions: readonly Action[];
  allows: readonly PharmacySubRoleAllowance[];
};

export type PharmacySubRole = PharmacySubRoleDefinition & {
  /** Carries extra weight: contains an action no wildcard grant ever reaches. */
  sensitive: boolean;
};

/** A use of an action's name that grants nothing (a comment, a label, a menu entry). */
export type NonGrantingSite = { count: number; reason: string };

// Generated from an audit of every use site; keep in step with pharmacy-sub-role-sites.test.ts.
const DEFINITIONS: readonly PharmacySubRoleDefinition[] = [
  {
    key: 'take-payment',
    label: 'Take payment',
    homeRole: 'cashier',
    actions: ['pharmacy:counter'],
    allows: [
      {
        id: 'search-patients-open-patients',
        text: "Search patients and open a patient's masked prescription panel from the counter, at every branch",
        sites: { 'src/server/routers/pharmacy-prescriptions.ts': 1 },
      },
      {
        id: 'view-khata-accounts-statements',
        text: "View khata accounts and statements, sign customers up for khata, record repayments and charge sales to khata at their branches (going over the limit needs a manager's authenticator code (or PIN, if the owner turned the authenticator off))",
        sites: { 'src/server/routers/pharmacy-sales.ts': 1 },
      },
      {
        id: 'take-payment-branches-by',
        text: 'Take payment at their branches by cash, card, wallet or manual methods, open the cash drawer, and record requests for out-of-stock items',
        sites: { 'src/server/routers/pharmacy-sales.ts': 1 },
      },
      {
        id: 'open-close-own-cash-shift',
        text: "At a branch that runs cash shifts, open their own shift on a counter's drawer with the cash they count, close it with a count, and see their own shift report (an over or short above the owner's limit needs the PIN of another manager or owner)",
        sites: {},
      },
      {
        id: 'see-customerapp-request-queue',
        text: 'See the customer-app request queue and confirm or reject payments customers report against their khata',
        sites: { 'src/server/routers/pharmacy-ordering.ts': 3 },
      },
      {
        id: 'open-hold-resume-void',
        text: 'Open, hold, resume and void their counter bills, search medicines, use vouchers, link customers and loyalty cards, and reprint or send receipts (refunds and returns need Manage their branches; prescription-only lines need Dispense prescriptions)',
        sites: { 'src/lib/pharmacy/counter-capability.ts': 2 },
      },
      {
        id: 'whole-bill-discount',
        text: "Where the owner turned it on, put one whole-bill discount (an amount or a percentage) on an open, unpaid bill at their branches. It needs their own Give discounts or a manager's authenticator code (or PIN, if the owner turned the authenticator off), is shared across the lines within the owner's maximum discount, cost and minimum margin, never touches prescription-only, restricted or controlled items, and is refused if the bill cannot take it in full",
        sites: {},
      },
      {
        id: 'handle-customer-orders-run',
        text: 'With Handle customer orders, run an offline counter; be named as the cashier of a till someone else opens',
        sites: { 'src/lib/pharmacy/counter-capability.ts': 1 },
      },
      {
        id: 'ring-up-medicines',
        text: 'Ring up medicines on their counter bills at their branches, by search or pack scan with live promotions applied, and acknowledge duplicate-ingredient warnings',
        sites: {},
      },
      {
        id: 'see-till-approvers',
        text: 'See who can approve discounts, out-of-order packs, over-limit khata charges and discarded payments at their till',
        sites: {},
      },
      {
        id: 'discard-unknown-card-payment',
        text: "Discard a payment whose result is unknown, with a manager's authenticator code (or PIN, if the owner turned the authenticator off)",
        sites: {},
      },
      {
        id: 'see-returns-refund-value',
        text: "See a receipt's past returns and what a proposed return would refund, at their branches",
        sites: {},
      },
      {
        id: 'follow-up-outofstock-requests',
        text: 'Follow up out-of-stock requests at their branches: set the outcome, sign customers up to be told when it is back or opt them out, and link a request to the sale that recovered it',
        sites: {},
      },
      {
        id: 'settle-card-reviews',
        text: 'With Manage their branches, settle card-machine payments under review with their authenticator code (or PIN, if the owner turned the authenticator off). Recording a refund also requires Read finance accounts, Manage finance accounts and accounts administration access.',
        sites: {},
      },
    ],
  },
  {
    key: 'customer-orders',
    label: 'Handle customer orders',
    homeRole: 'cashier',
    actions: ['pharmacy:orders'],
    allows: [
      {
        id: 'work-customer-order-queue',
        text: 'Work the customer order queue at their branches: accept, pack, dispatch, cancel and complete orders, assign delivery runners, record delivery cash, and send customers a sign-in link',
        sites: { 'src/server/routers/pharmacy-ordering.ts': 2 },
      },
      {
        id: 'create-pause-cancel-repeatrefill',
        text: 'Create, pause, resume and cancel repeat-refill subscriptions and check out refill cycles',
        sites: { 'src/server/routers/pharmacy-ordering.ts': 1 },
      },
      {
        id: 'place-orders-customer-see',
        text: 'Place orders for a customer and see the customer-app request queue',
        sites: { 'src/server/routers/pharmacy-ordering.ts': 1 },
      },
      {
        id: 'take-payment-use-offline',
        text: "With Take payment, use an offline counter: start it, download its signed price list and receipt numbers, check prices on it while offline, upload offline sales, renew its receipt numbers and renew its own device credential before it expires. Taking cash sales on it while offline also needs the owner's offline cash selling switch, which stays off until sending offline sales is ready",
        sites: { 'src/server/routers/pharmacy-offline.ts': 2 },
      },
      {
        id: 'run-refill-cycles',
        text: "Open due refill cycles (holding their stock), release them, and get them approved with a pharmacist's authenticator code (or PIN, if the owner turned the authenticator off), seeing which pharmacists can approve, at their branches",
        sites: {},
      },
      {
        id: 'dispense-see-refill-prescriptions',
        text: 'With Dispense prescriptions, see the prescriptions that could cover a refill',
        sites: {},
      },
      {
        id: 'record-failed-returned-deliveries',
        text: 'Record refused, failed and returned deliveries, putting returned stock into quarantine (refunding a return needs Manage their branches and their authenticator code, or PIN if the owner turned the authenticator off)',
        sites: {},
      },
    ],
  },
  {
    key: 'give-discounts',
    label: 'Give discounts',
    homeRole: 'cashier',
    actions: ['pharmacy:discount'],
    allows: [
      {
        id: 'give-counter-discounts-without',
        text: "Give counter discounts without a manager's approval, on a line or, where the owner turned it on, on the whole bill, within the owner's maximum discount and minimum margin, never on prescription-only, restricted or controlled items",
        sites: { 'src/lib/pharmacy/counter-line-approval.ts': 3 },
      },
    ],
  },
  {
    key: 'do-procedures',
    label: 'Do procedure checklists',
    homeRole: 'cashier',
    actions: ['sop:complete'],
    allows: [
      {
        id: 'start-claim-tick-off',
        text: 'Start, claim, tick off, attach proof to and submit their own procedure checklists at their branches',
        sites: { 'src/server/routers/pharmacy-sop.ts': 1 },
      },
      {
        id: 'see-procedures-board-open',
        text: 'See their procedures board and open procedures they own or can claim',
        sites: { 'src/server/routers/pharmacy-sop.ts': 2 },
      },
      {
        id: 'see-which-branches-use',
        text: 'See which of their branches use procedures and set up their own procedures profile',
        sites: { 'src/server/routers/pharmacy-sop.ts': 2 },
      },
      {
        id: 'open-proof-photos-procedures',
        text: 'Open proof photos on procedures they own, claimed or uploaded',
        sites: { 'src/lib/pharmacy/sop-evidence.ts': 1 },
      },
      {
        id: 'start-on-demand-procedures',
        text: 'Start an on-demand procedure checklist for a procedure role they hold at their branch',
        sites: {},
      },
      {
        id: 'link-records-to-procedures',
        text: 'Link branch records, such as temperature readings, to their own procedure checklists',
        sites: {},
      },
      {
        id: 'add-rework-notes',
        text: 'Add a note saying what they changed when one of their procedures is sent back',
        sites: {},
      },
    ],
  },
  {
    key: 'dispense-prescriptions',
    label: 'Dispense prescriptions',
    homeRole: 'pharmacist',
    actions: ['pharmacy:dispense'],
    allows: [
      {
        id: 'check-query-refuse-sign',
        text: 'Check, query, refuse and sign prescription lines in the pharmacist queue at their branch, and record substitution evidence',
        sites: {
          'src/server/routers/pharmacy-dispensing.ts': 1,
          'src/lib/pharmacy/rx-review-self-sign.ts': 1,
        },
      },
      {
        id: 'open-substitution-workspace',
        text: 'Open the substitution workspace',
        sites: { 'src/server/routers/pharmacy-dispensing.ts': 1 },
      },
      {
        id: 'record-fills-noncontrolled-prescriptions',
        text: 'Record fills of non-controlled prescriptions and log refill reminders',
        sites: { 'src/server/routers/pharmacy-prescriptions.ts': 2 },
      },
      {
        id: 'search-counter-patients-open',
        text: 'Search counter patients and open their masked patient panel, at every branch',
        sites: { 'src/server/routers/pharmacy-prescriptions.ts': 1 },
      },
      {
        id: 'use-counter-without-counter',
        text: 'Use the counter without counter permission: open, hold, void and print bills, search stock and link customers (taking payment still needs Take payment)',
        sites: { 'src/lib/pharmacy/counter-capability.ts': 3 },
      },
      {
        id: 'whole-bill-discount',
        text: 'Where the owner turned it on, put a whole-bill discount on an open, unpaid counter bill at their branch, even without Take payment, with the same approval and limits as for Take payment',
        sites: {},
      },
      {
        id: 'sell-prescriptiononly-restricted-medicines',
        text: 'Sell prescription-only and restricted medicines',
        sites: { 'src/lib/pharmacy/rx-sale-gate.ts': 1 },
      },
      {
        id: 'ring-up-sale-line',
        text: "Ring up a sale line against a patient's prescription for a pharmacist's sign-off",
        sites: { 'src/server/routers/pharmacy-sales.ts': 1 },
      },
      {
        id: 'sell-controlled-medicines-counter',
        text: "Sell controlled medicines at the counter, with a different pharmacist's authenticator code (or PIN, if the owner turned the authenticator off)",
        sites: { 'src/server/routers/pharmacy-sales.ts': 1 },
      },
      {
        id: 'witness-colleagues-controlledmedicine-sale',
        text: "Witness a colleague's controlled-medicine sale with their authenticator code (or PIN, if the owner turned the authenticator off)",
        sites: { 'src/server/routers/pharmacy-sales.ts': 1 },
      },
      {
        id: 'witness-controlledregister-corrections-controlled',
        text: 'Witness controlled-register corrections and controlled purchases with their authenticator code (or PIN, if the owner turned the authenticator off)',
        sites: {
          'src/server/routers/pharmacy-safety.ts': 1,
          'src/lib/pharmacy/controlled-register.ts': 1,
        },
      },
      {
        id: 'witness-controlled-stock-going',
        text: 'Witness controlled stock going back into stock with their authenticator code (or PIN, if the owner turned the authenticator off), alone with a fresh authenticator code (or PIN, if the owner turned the authenticator off) when they are the only pharmacist',
        sites: { 'src/lib/pharmacy/controlled-restoration-authorization.ts': 1 },
      },
      {
        id: 'void-return-controlledmedicine-sale',
        text: "Void or return a controlled-medicine sale line, with a different pharmacist's authenticator code (or PIN, if the owner turned the authenticator off)",
        sites: { 'src/lib/pharmacy/controlled-restoration-authorization.ts': 1 },
      },
      {
        id: 'dispatch-controlled-supplier-return',
        text: "With purchasing access, send controlled stock back to its supplier with a different pharmacist's authenticator code (or PIN, if the owner turned the authenticator off)",
        sites: {
          'src/app/(app)/pharmacy/purchasing/returns/page.tsx': 1,
          'src/lib/pharmacy/supplier-returns-operations.ts': 1,
        },
      },
      {
        id: 'see-which-pharmacists-can',
        text: 'See which pharmacists can witness controlled-medicine entries',
        sites: { 'src/server/routers/pharmacy-safety.ts': 1 },
      },
      {
        id: 'order-receive-stock-see',
        text: 'With Order and receive stock, see who can witness a controlled delivery',
        sites: { 'src/server/routers/pharmacy-purchasing.ts': 1 },
      },
      {
        id: 'sign-controlledmedicine-delivery-pin',
        text: 'Sign for a controlled-medicine delivery with their authenticator code (or PIN, if the owner turned the authenticator off)',
        sites: {
          'src/lib/pharmacy/goods-receipt.ts': 1,
          'src/lib/pharmacy/purchasing-console.ts': 1,
        },
      },
      {
        id: 'witness-own-stock-writeoff',
        text: 'Witness their own stock write-off with a fresh authenticator code (or PIN, if the owner turned the authenticator off) when they are the only pharmacist',
        sites: { 'src/lib/pharmacy/write-off-witness.ts': 1 },
      },
      {
        id: 'approve-refillsubscription-cycles-pin',
        text: 'Approve refill-subscription cycles with their authenticator code (or PIN, if the owner turned the authenticator off)',
        sites: { 'src/lib/pharmacy/refill-subscriptions.ts': 1 },
      },
      {
        id: 'see-online-customer-requests',
        text: 'See online customer requests and verify or reject refill and prescription-photo orders',
        sites: { 'src/server/routers/pharmacy-ordering.ts': 2 },
      },
      {
        id: 'handle-customer-orders-see',
        text: 'With Handle customer orders, see the prescriptions that could cover a refill',
        sites: { 'src/server/routers/pharmacy-ordering.ts': 1 },
      },
      {
        id: 'approve-selling-from-batch',
        text: 'Approve selling from a batch that is not the earliest to expire',
        sites: { 'src/lib/pharmacy/counter-line-approval.ts': 1 },
      },
      {
        id: 'see-brand-margins-branch',
        text: 'See brand margins at their branch: discount suggestions and higher-margin brand ranking',
        sites: { 'src/server/routers/pharmacy-sales.ts': 3 },
      },
      {
        id: 'redeem-customers-loyalty-points',
        text: "Redeem a customer's loyalty points to settle a sale",
        sites: { 'src/server/routers/pharmacy-sales.ts': 1 },
      },
      {
        id: 'file-adversereaction-medicationerror-reports',
        text: 'File adverse-reaction, medication-error and product-quality reports',
        sites: { 'src/server/routers/pharmacy-reports.ts': 1 },
      },
      {
        id: 'check-procedure-tasks-others',
        text: 'Check procedure tasks others did, as the qualified person',
        sites: { 'src/lib/pharmacy/sop-adapter.ts': 2 },
      },
      {
        id: 'ring-up-medicines-without-counter',
        text: 'Ring up medicines on counter bills at their branch and acknowledge duplicate-ingredient warnings, even without Take payment',
        sites: {},
      },
      {
        id: 'see-till-approvers',
        text: 'See who can approve discounts and out-of-order packs at the counter',
        sites: {},
      },
      {
        id: 'see-returns-refund-value',
        text: "See a receipt's past returns and what a proposed return would refund, at their branch",
        sites: {},
      },
      {
        id: 'witness-controlled-delivery-reversal',
        text: 'Witness the reversal of a controlled-medicine delivery with their authenticator code (or PIN, if the owner turned the authenticator off), alone with a fresh authenticator code (or PIN, if the owner turned the authenticator off) when they are the only pharmacist',
        sites: {},
      },
      {
        id: 'everything-record-prescriptions',
        text: 'Do everything Record prescriptions allows: the prescription workspace, prescription photos, patient records, consents and exports',
        sites: {},
      },
      {
        id: 'see-returns-awaiting-verification',
        text: 'See returned items waiting in quarantine for verification at their branch',
        sites: {},
      },
      {
        id: 'sign-own-line-alone',
        text: "See which lines on a bill still wait for a pharmacist's signature, and sign a non-controlled line they rang up themselves with a fresh authenticator code (or PIN, if the owner turned the authenticator off) when no other pharmacist at the branch can, or, where the owner turned on One pharmacist per shift, when they declare they are the only pharmacist on duty",
        sites: {},
      },
    ],
  },
  {
    key: 'record-prescriptions',
    label: 'Record prescriptions',
    homeRole: 'pharmacist',
    actions: ['pharmacy:prescriptions'],
    allows: [
      {
        id: 'open-prescription-workspace-register',
        text: 'Open the prescription workspace: register patients and prescribers, upload and view prescription photos, and capture prescriptions',
        sites: { 'src/server/routers/pharmacy-prescriptions.ts': 1 },
      },
      {
        id: 'record-patients-consent-dispensing',
        text: "Record a patient's consent for dispensing, reminders, loyalty or marketing",
        sites: { 'src/server/routers/pharmacy-prescriptions.ts': 1 },
      },
      {
        id: 'view-patients-masked-record',
        text: "View a patient's masked record",
        sites: { 'src/server/routers/pharmacy-prescriptions.ts': 1 },
      },
      {
        id: 'export-patients-record-consents',
        text: "Export a patient's record with consents, prescriptions and fills",
        sites: { 'src/server/routers/pharmacy-prescriptions.ts': 1 },
      },
      {
        id: 'see-patient-names-substitution',
        text: 'See patient names in the substitution workspace',
        sites: { 'src/server/routers/pharmacy-dispensing.ts': 1 },
      },
      {
        id: 'controlled-medicines-safety-see',
        text: "With Controlled medicines and safety, see patients' full phone numbers in recall contact lists",
        sites: { 'src/server/routers/pharmacy-inventory.ts': 1 },
      },
      {
        id: 'read-prescription-photo-draft-bill',
        text: 'Read a prescription photo automatically to suggest medicines and doses, and draft a counter bill from it for a pharmacist to confirm (when prescription reading is switched on)',
        sites: {},
      },
    ],
  },
  {
    key: 'review-catalogue',
    label: 'Approve medicine catalogue changes',
    homeRole: 'pharmacist',
    actions: ['pharmacy:catalogue-review'],
    allows: [
      {
        id: 'approve-reject-others-catalogue',
        text: "Approve or reject others' catalogue edits, which applies them (prices, packs, printed MRP, barcodes, ingredients), and publish or withdraw reviewed medicines",
        sites: { 'src/server/routers/pharmacy-medicine.ts': 1 },
      },
      {
        id: 'confirm-reject-imported-referencedata',
        text: 'Confirm or reject imported reference-data proposals they did not import',
        sites: { 'src/server/routers/pharmacy-medicine.ts': 2 },
      },
      {
        id: 'review-medicine-details',
        text: 'Accept, correct, reject or defer imported and drafted medicine details that someone else entered',
        sites: {},
      },
      {
        id: 'create-approved-imported-medicines',
        text: 'Create the medicines from an imported file once its request is approved, and see how far it has got',
        sites: {},
      },
    ],
  },
  {
    key: 'close-the-day',
    label: 'Close the day for every branch',
    homeRole: 'pharmacist',
    actions: ['pharmacy:close'],
    allows: [
      {
        id: 'review-reconciliation-close-day',
        text: 'Review the reconciliation and close the day at every branch, with or without a branch assignment',
        sites: { 'src/server/routers/pharmacy-sales.ts': 3 },
      },
    ],
  },
  {
    key: 'run-branches',
    label: 'Manage their branches (cash, refunds and approvals)',
    homeRole: 'manager',
    actions: ['pharmacy:manage'],
    allows: [
      {
        id: 'run-cash-drawers-branches',
        text: "Run the cash drawers at their branches: open a till with a float, pay cash in or out, close a drawer with a count and hand a till to another cashier; adjust loyalty points with their authenticator code (or PIN, if the owner turned the authenticator off) within the owner's limit, enrol customers and issue or revoke loyalty cards",
        sites: {
          'src/server/routers/pharmacy-sales.ts': 5,
          'src/lib/pharmacy/counter-capability.ts': 4,
        },
      },
      {
        id: 'close-day-branches-unless',
        text: 'Close the day at their branches, unless day close is denied to them',
        sites: {
          'src/server/routers/pharmacy-sales.ts': 2,
          'src/server/pharmacy-manager-branches.ts': 1,
        },
      },
      {
        id: 'run-cash-shifts-branches',
        text: "At their branches that run cash shifts, open a shift for another cashier, close anyone's shift before the day close, see every shift report, and approve another person's shift's over or short above the owner's limit with their PIN. A shift they are the cashier of, or are closing and counting themselves, they approve only when no other manager or owner with an approval PIN works at the branch",
        sites: { 'src/lib/pharmacy/cash-shifts.ts': 1 },
      },
      {
        id: 'set-when-business-day',
        text: "Set when the business day ends at their branches, from midnight to 6:00 AM. A change starts with tomorrow's business day, so today and earlier days, their closes and their reports never move",
        sites: {},
      },
      {
        id: 'reopen-closed-day-branches',
        text: 'Reopen a closed day at their branches with a reason and their authenticator code (or PIN, if the owner turned the authenticator off)',
        sites: { 'src/server/routers/pharmacy-sales.ts': 2 },
      },
      {
        id: 'see-demand-lostsales-restockrecovery',
        text: 'See demand, lost-sales and restock-recovery reports, and change the lost-sales settings, at their branches',
        sites: { 'src/server/routers/pharmacy-sales.ts': 1 },
      },
      {
        id: 'read-reports-centre-replenishment',
        text: 'Read the Reports centre, replenishment report, daily work pack and supplier list for their branches',
        sites: {
          'src/server/routers/pharmacy-reports.ts': 1,
          'src/server/pharmacy-manager-branches.ts': 1,
        },
      },
      {
        id: 'see-discount-policy-log',
        text: 'See the discount policy, log competitor prices and see discount suggestions at their branches',
        sites: { 'src/server/routers/pharmacy-sales.ts': 3 },
      },
      {
        id: 'see-brand-margins-highermargin',
        text: 'See brand margins and higher-margin brand suggestions at their branches',
        sites: { 'src/server/routers/pharmacy-sales.ts': 3 },
      },
      {
        id: 'create-view-switch-off',
        text: 'Create, view and switch off promotions at their branches',
        sites: { 'src/server/routers/pharmacy-sales.ts': 4, 'src/lib/pharmacy/promotions.ts': 2 },
      },
      {
        id: 'approve-someone-elses-counter',
        text: "Approve someone else's counter discount, on a line or the whole bill, with their authenticator code (or PIN, if the owner turned the authenticator off), within the owner's limits",
        sites: { 'src/lib/pharmacy/counter-line-approval.ts': 2 },
      },
      {
        id: 'be-second-approver-highvalue',
        text: 'Be the second approver for a high-value voucher with their authenticator code (or PIN, if the owner turned the authenticator off)',
        sites: { 'src/lib/pharmacy/voucher-controls.ts': 1 },
      },
      {
        id: 'approve-charging-customers-khata',
        text: "Approve charging a customer's khata past its limit with their authenticator code (or PIN, if the owner turned the authenticator off)",
        sites: {
          'src/server/routers/pharmacy-sales.ts': 2,
          'src/lib/pharmacy/counter-line-approval.ts': 2,
        },
      },
      {
        id: 'approve-selling-pack-that',
        text: 'Approve selling a pack that is not from the batch that expires first, with their authenticator code (or PIN, if the owner turned the authenticator off)',
        sites: { 'src/lib/pharmacy/counter-line-approval.ts': 2 },
      },
      {
        id: 'approve-discarding-card-payment',
        text: 'Approve discarding a card payment whose result is unknown, with their authenticator code (or PIN, if the owner turned the authenticator off)',
        sites: { 'src/lib/pharmacy/counter-line-approval.ts': 2 },
      },
      {
        id: 'refund-sales-take-returns',
        text: "With Take payment or Dispense prescriptions, refund sales and take returns with their own authenticator code each time (or PIN, if the owner turned the authenticator off), and void another cashier's bill",
        sites: { 'src/lib/pharmacy/refund-authorization.ts': 2 },
      },
      {
        id: 'settle-cardmachine-payments-under',
        text: 'With Take payment, settle card-machine payments under review with their authenticator code (or PIN, if the owner turned the authenticator off). Recording a refund also requires Read finance accounts, Manage finance accounts and accounts administration access.',
        sites: { 'src/lib/pharmacy/card-terminal/review-approvers.ts': 2 },
      },
      {
        id: 'workspace-administrator-finance-access',
        text: 'As a workspace administrator with finance access through a grant or as the workspace owner: approve supplier credit set-offs and reverse supplier invoices and payments with their authenticator code (or PIN, if the owner turned the authenticator off)',
        sites: { 'src/server/routers/pharmacy-ap-invoices.ts': 1 },
      },
      {
        id: 'see-purchase-price-paid',
        text: 'See the purchase price paid for a medicine',
        sites: { 'src/server/routers/pharmacy-medicine.ts': 2 },
      },
      {
        id: 'owner-workspace-administrator-turn',
        text: 'As the owner or a workspace administrator: turn supplier compliance checks on or off',
        sites: { 'src/lib/pharmacy/supplier-compliance-policy.ts': 2 },
      },
      {
        id: 'supplier-compliance-history',
        text: 'As the owner or a workspace administrator: see who turned supplier compliance checks on or off, and what went through while they were off',
        sites: {},
      },
      {
        id: 'reject-undo-credit-set-offs',
        text: 'As a workspace administrator with finance access through a grant or as the workspace owner: reject a supplier credit set-off, or undo an approved one with their authenticator code (or PIN, if the owner turned the authenticator off)',
        sites: {},
      },
      {
        id: 'save-reports-dashboard-layout',
        text: 'Save their Reports centre dashboard layout',
        sites: {},
      },
    ],
  },
  {
    key: 'approve-purchase-orders',
    label: 'Approve purchase orders',
    homeRole: 'manager',
    actions: ['pharmacy:procurement-approve'],
    allows: [
      {
        id: 'approve-reject-purchase-orders',
        text: 'Approve or reject purchase orders someone else raised, send approved orders and set reorder thresholds at their branches, even without Order and receive stock',
        sites: { 'src/server/routers/pharmacy-purchasing.ts': 1 },
      },
      {
        id: 'order-receive-stock-authorize',
        text: 'With Order and receive stock, authorize or withdraw a supplier and set their purchase-approval PIN',
        sites: { 'src/server/routers/pharmacy-purchasing.ts': 1 },
      },
      {
        id: 'order-receive-stock-approve',
        text: "With Order and receive stock, approve a colleague's direct purchase with their authenticator code (or PIN, if the owner turned the authenticator off); a solo owner also approves their own orders, counts and transfers with an authenticator code (or PIN, if the owner turned the authenticator off)",
        sites: { 'src/lib/pharmacy/procurement-access.ts': 1 },
      },
    ],
  },
  {
    key: 'set-up-procedures',
    label: 'Set up procedures',
    homeRole: 'manager',
    actions: ['sop:manage'],
    allows: [
      {
        id: 'branches-view-change-procedure',
        text: 'At their branches, view and change procedure set-up: turn procedures on, create, pause and resume schedules, give and remove staff procedure roles, create due work and set alerts; install the procedure library for the whole pharmacy',
        sites: { 'src/server/routers/pharmacy-sop.ts': 1 },
      },
      {
        id: 'view-procedures-compliance-report',
        text: "View the procedures compliance report for a branch, which names each person's work",
        sites: { 'src/server/routers/pharmacy-sop.ts': 1 },
      },
      {
        id: 'do-check-procedure-checklists',
        text: 'With Do or Check procedure checklists, open any procedure at their branches',
        sites: { 'src/server/routers/pharmacy-sop.ts': 1 },
      },
      {
        id: 'see-which-branches-use',
        text: 'See which of their branches use procedures and set up their own procedures profile',
        sites: { 'src/server/routers/pharmacy-sop.ts': 2 },
      },
      {
        id: 'open-proof-photos-any',
        text: 'Open proof photos for any procedure at their branches',
        sites: { 'src/lib/pharmacy/sop-evidence.ts': 1 },
      },
    ],
  },
  {
    key: 'check-procedures',
    label: 'Check procedure checklists',
    homeRole: 'manager',
    actions: ['sop:verify'],
    allows: [
      {
        id: 'approve-send-back-submitted',
        text: 'Approve or send back submitted procedures, with a checking role at the branch and never for work they took part in',
        sites: { 'src/server/routers/pharmacy-sop.ts': 1 },
      },
      {
        id: 'see-review-queue-open',
        text: 'See the review queue and open submitted procedures their checking role covers',
        sites: { 'src/server/routers/pharmacy-sop.ts': 4 },
      },
      {
        id: 'view-procedures-compliance-report',
        text: "View the procedures compliance report for a branch, which names each person's work",
        sites: { 'src/server/routers/pharmacy-sop.ts': 1 },
      },
      {
        id: 'see-which-branches-use',
        text: 'See which of their branches use procedures and set up their own procedures profile',
        sites: { 'src/server/routers/pharmacy-sop.ts': 2 },
      },
      {
        id: 'open-proof-photos-procedures',
        text: 'Open proof photos on procedures they own, claimed, uploaded or check',
        sites: { 'src/lib/pharmacy/sop-evidence.ts': 1 },
      },
    ],
  },
  {
    key: 'receive-stock',
    label: 'Order and receive stock',
    homeRole: 'procurement',
    actions: ['pharmacy:procurement'],
    allows: [
      {
        id: 'link-suppliers-branch-issue',
        text: 'Link suppliers to a branch, issue supplier response links, record supplier replies, and accept or reject supplier proposals at their branches',
        sites: { 'src/server/routers/pharmacy-supplier-links.ts': 1 },
      },
      {
        id: 'see-highermargin-brand-suggestions',
        text: 'See higher-margin brand suggestions, with cost and margin, for their branches',
        sites: { 'src/server/routers/pharmacy-sales.ts': 1 },
      },
      {
        id: 'import-supplier-price-lists',
        text: 'Import supplier price lists and review price alerts for the whole pharmacy',
        sites: { 'src/server/routers/pharmacy-supplier-price-lists.ts': 1 },
      },
      {
        id: 'run-purchasing-branches-add',
        text: 'Run purchasing at their branches: add suppliers and their licences, raise requisitions, compare quotes, create and submit purchase orders, receive, post and reverse deliveries, authenticate packs and request transfers',
        sites: { 'src/server/routers/pharmacy-purchasing.ts': 1 },
      },
      {
        id: 'approve-purchase-orders-authorize',
        text: 'With Approve purchase orders, authorize or withdraw a supplier and set their purchase-approval PIN',
        sites: { 'src/server/routers/pharmacy-purchasing.ts': 1 },
      },
      {
        id: 'use-financial-reports-return',
        text: 'With Use financial reports, return stock to suppliers, issue debit notes and record supplier credit',
        sites: { 'src/server/routers/pharmacy-purchasing.ts': 1 },
      },
      {
        id: 'open-purchasing-screens-read',
        text: 'Open the purchasing screens and read supplier invoices from photos into a delivery',
        sites: { 'src/lib/pharmacy/procurement-access.ts': 2 },
      },
      {
        id: 'manage-stock-turn-stock',
        text: 'With Manage stock, turn a stock alert into a draft purchase request or supplier claim',
        sites: { 'src/lib/pharmacy/stock-signals-operations.ts': 1 },
      },
      {
        id: 'verify-supplier-licence',
        text: 'Verify a supplier licence someone else filed; a solo owner may verify their own',
        sites: {},
      },
      {
        id: 'receiving-exceptions',
        text: 'See and resolve the receiving exceptions queue at their branches, with a note',
        sites: {},
      },
      {
        id: 'proposed-debit-notes',
        text: 'See debit notes proposed when a delivery does not match its order or invoice at their branches; with Use financial reports, confirm or discard them',
        sites: {},
      },
      {
        id: 'controlled-witnesses',
        text: 'With Dispense prescriptions or Controlled medicines and safety, see who can witness a controlled delivery; with Controlled medicines and safety, also who can witness reversing one',
        sites: {},
      },
      {
        id: 'official-price-alerts',
        text: 'With Controlled medicines and safety, see official price alerts for the medicines they are receiving',
        sites: {},
      },
      {
        id: 'restock-advice',
        text: 'See restock advice from lost sales and suggested reorder drafts at their branches, read the reorder thresholds and dismiss advice cards',
        sites: {},
      },
      {
        id: 'central-purchasing',
        text: 'As the owner or a named central buyer, see stock demand across branches, raise central purchase orders and split a central delivery between branches',
        sites: {},
      },
      {
        id: 'revoke-supplier-links',
        text: 'Revoke supplier response links issued at their branches',
        sites: {},
      },
      {
        id: 'supplier-check-skips',
        text: 'See which supplier orders and deliveries went through while supplier checks were off',
        sites: {},
      },
      {
        id: 'read-pack-label-photo',
        text: "Read a pack's batch, expiry and printed price from a photo while receiving an order",
        sites: {},
      },
    ],
  },
  {
    key: 'manage-stock',
    label: 'Manage stock',
    homeRole: 'inventory',
    actions: ['pharmacy:inventory'],
    allows: [
      {
        id: 'set-reorder-levels-when',
        text: 'Set reorder levels when medicines are requested from an imported file',
        sites: { 'src/server/routers/pharmacy-medicine.ts': 1 },
      },
      {
        id: 'run-stock-branches-locations',
        text: "Run stock at their branches: locations, temperature logs, batches, stock counts (approving others'), write-offs, releasing quarantine, transfers, supplier claims, shelf labels and expiry markdowns",
        sites: { 'src/server/routers/pharmacy-inventory.ts': 1 },
      },
      {
        id: 'workspace-administrator-reach-stock',
        text: 'As a workspace administrator, reach stock at every branch, with each access logged',
        sites: { 'src/server/routers/pharmacy-inventory.ts': 1 },
      },
      {
        id: 'turn-stock-alert-into',
        text: 'Turn a stock alert into a draft transfer from another branch',
        sites: { 'src/lib/pharmacy/stock-signals-operations.ts': 1 },
      },
      {
        id: 'receive-stock-without-order',
        text: 'Receive stock straight into a batch at their branches without a purchase order, recording the supplier, invoice number, unit cost and printed MRP',
        sites: {},
      },
      {
        id: 'temperature-sensors',
        text: 'Add live temperature sensors to storage zones at their branches, see them, and issue, rotate and revoke their credentials',
        sites: {},
      },
      {
        id: 'set-safety-stock',
        text: 'Set safety-stock levels and cover days for medicines at their branches',
        sites: {},
      },
      {
        id: 'owner-switch-branch-transfers',
        text: 'As the owner, turn stock transfers between branches on or off',
        sites: {},
      },
      {
        id: 'allocate-stock-for-sale',
        text: "Set aside stock for a sale at their branches, earliest expiry first (taking another batch needs an approver's authenticator code (or PIN, if the owner turned the authenticator off))",
        sites: {},
      },
      {
        id: 'move-stock-break-packs',
        text: 'Move stock between storage locations and break sealed packs into loose units at their branches',
        sites: {},
      },
      {
        id: 'work-stock-alerts',
        text: 'Refresh stock alerts at their branches, mark old ones stale, and acknowledge, snooze or dismiss them (snooze and dismiss with a reason)',
        sites: {},
      },
      {
        id: 'quarantine-expiring-stock',
        text: 'Quarantine near-expiry and expired stock at their branches',
        sites: {},
      },
      {
        id: 'solo-owner-approve-own',
        text: 'As an owner working alone, approve their own stock count or branch transfer with a fresh authenticator code (or PIN, if the owner turned the authenticator off)',
        sites: {},
      },
    ],
  },
  {
    key: 'read-finance-accounts',
    label: 'See accounts',
    homeRole: 'finance',
    actions: ['finance:read'],
    allows: [
      {
        id: 'view-accounts',
        text: 'With the required administrator, branch and report access, view supplier invoices, payments and reversals, the general journal, bank statements and financial statements.',
        sites: {},
      },
    ],
  },
  {
    key: 'manage-finance-accounts',
    label: 'Manage account transactions',
    homeRole: 'finance',
    actions: ['finance:manage'],
    allows: [
      {
        id: 'manage-transactions',
        text: 'With See accounts and the required administrator access, record invoices and payments, manage journals and bank reconciliation, close periods and publish tax profiles. Reversing a supplier invoice, payment or approved credit set-off also requires management access and the approver’s authenticator code (or PIN, if the owner turned the authenticator off).',
        sites: {},
      },
    ],
  },
  {
    key: 'financial-reports',
    label: 'Use financial reports',
    homeRole: 'finance',
    actions: ['reports:financial'],
    allows: [
      {
        id: 'workspace-administrator-use-operational',
        text: 'As a workspace administrator with Use operational reports: view growth, marketing, branch comparison, anomaly and expiry-advice reports, and also change data there: save and delete seasonal windows, propose expiry returns, refresh, acknowledge and snooze anomalies, acknowledge pack-authentication flags and set the daily digest',
        sites: { 'src/server/routers/pharmacy-reports.ts': 1 },
      },
      {
        id: 'workspace-administrator-run-orderplanning',
        text: 'As a workspace administrator: run order-planning scenarios and see anomaly and expiry items in the daily work pack, also through the assistant; read supplier-credit follow-up through the assistant',
        sites: {
          'src/server/routers/pharmacy-reports.ts': 2,
          'src/lib/ai/tools/pharmacy-reports.ts': 1,
        },
      },
      {
        id: 'see-sales-margin-cash',
        text: 'See sales, margin, cash, refund, payables, receivables and khata figures in the Reports centre and the assistant',
        sites: {
          'src/server/routers/pharmacy-reports.ts': 1,
          'src/lib/pharmacy/reports.ts': 8,
          'src/lib/ai/tools/pharmacy-reports.ts': 2,
        },
      },
      {
        id: 'workspace-administrator-use-operational-2',
        text: 'As a workspace administrator with Use operational reports: view the accounts reports (cash-flow forecast, stock valuation, margins, leakage). Reading financial statements also requires finance access through a grant or as the workspace owner',
        sites: { 'src/server/routers/pharmacy-finance.ts': 2 },
      },
      {
        id: 'workspace-administrator-use-operational-3',
        text: 'As a workspace administrator with Use operational reports: look up accounting journal entries when you also have finance access through a grant or as the workspace owner',
        sites: { 'src/lib/pharmacy/accounts/journal-entry-lookup.ts': 1 },
      },
      {
        id: 'workspace-administrator-use-operational-4',
        text: 'As a workspace administrator with Use operational reports: view the fiscal exceptions register',
        sites: { 'src/lib/pharmacy/accounts/fiscal-exceptions.reader.ts': 1 },
      },
      {
        id: 'workspace-administrator-use-operational-5',
        text: 'As a workspace administrator with Use operational reports: ask the assistant for stock capital, leakage, margin and repeat-purchase insights',
        sites: { 'src/lib/ai/tools/pharmacy-reports.ts': 2 },
      },
      {
        id: 'workspace-administrator-ask-assistant',
        text: "As a workspace administrator: ask the assistant to check a day's cash close for variances, refunds and voids",
        sites: { 'src/lib/ai/tools/pharmacy-reports.ts': 1 },
      },
      {
        id: 'workspace-administrator-use-operational-6',
        text: 'As a workspace administrator with Use operational reports and the CRM module: generate, review and view basket and growth suggestions',
        sites: { 'src/server/routers/pharmacy-marketing.ts': 1 },
      },
      {
        id: 'workspace-administrator-use-operational-7',
        text: 'As a workspace administrator with Use operational reports: receive the daily owner digest',
        sites: { 'src/lib/pharmacy/owner-digest.ts': 1 },
      },
      {
        id: 'see-stock-cost-value',
        text: "See stock cost and value at risk on the expiry board and the inventory page's near-expiry summary",
        sites: { 'src/server/routers/pharmacy-inventory.ts': 2 },
      },
      {
        id: 'view-customer-khata-accounts',
        text: 'View customer khata accounts, statements and khata payments at their branches, even without Take payment',
        sites: { 'src/server/routers/pharmacy-sales.ts': 1 },
      },
      {
        id: 'workspace-administrator-run-dayclose',
        text: 'As a workspace administrator: run the day-close cash anomaly check and read draft shift handover notes',
        sites: { 'src/server/routers/pharmacy-sales.ts': 1 },
      },
      {
        id: 'view-supplier-returns-claims',
        text: 'View supplier returns, claims and supplier credits at their branches',
        sites: { 'src/server/routers/pharmacy-purchasing.ts': 2 },
      },
      {
        id: 'order-receive-stock-issue',
        text: 'With Order and receive stock: issue debit notes, create and dispatch supplier returns, and record and allocate supplier credits',
        sites: { 'src/server/routers/pharmacy-purchasing.ts': 1 },
      },
      {
        id: 'decide-proposed-debit-notes',
        text: 'With Order and receive stock: confirm or discard debit notes proposed when a delivery does not match its order or invoice',
        sites: {},
      },
      {
        id: 'delivery-distance-profitability',
        text: 'As a workspace administrator with Use operational reports: see delivered-order profitability by delivery distance',
        sites: {},
      },
      {
        id: 'admin-view-repeat-lostsales-packflags',
        text: 'As a workspace administrator with Use operational reports: view the repeat-purchasing, lost-sales recovery and pack-authentication flag reports for every branch',
        sites: {},
      },
    ],
  },
  {
    key: 'operational-reports',
    label: 'Use operational reports',
    homeRole: 'auditor',
    actions: ['reports:operational'],
    allows: [
      {
        id: 'run-seasonal-calendar-demandspike',
        text: 'Run the seasonal calendar, demand-spike and staffing reports for every branch; as a workspace administrator with Use financial reports, also view growth, marketing, branch comparison, anomaly and expiry-advice reports and change data there: save and delete seasonal windows, propose expiry returns, refresh, acknowledge and snooze anomalies, acknowledge pack-authentication flags and set the daily digest',
        sites: { 'src/server/routers/pharmacy-reports.ts': 1 },
      },
      {
        id: 'open-reports-centre-replenishment',
        text: 'Open the Reports centre, replenishment report, daily work pack and supplier list for every branch, and save their dashboard layout',
        sites: { 'src/server/routers/pharmacy-reports.ts': 1 },
      },
      {
        id: 'see-stock-alert-lost',
        text: 'See stock alert, lost demand, reorder, expiry value, recall, quarantine, supplier claim, receiving and safety queue figures',
        sites: { 'src/lib/pharmacy/reports.ts': 16 },
      },
      {
        id: 'ask-assistant-about-report',
        text: 'Ask the assistant about report figures and daily work packs for any branch',
        sites: { 'src/lib/ai/tools/pharmacy-reports.ts': 2 },
      },
      {
        id: 'workspace-administrator-use-financial',
        text: 'As a workspace administrator with Use financial reports: view the accounts reports (cash-flow forecast, stock valuation, margins, leakage). Reading financial statements also requires finance access through a grant or as the workspace owner',
        sites: { 'src/server/routers/pharmacy-finance.ts': 2 },
      },
      {
        id: 'workspace-administrator-use-financial-2',
        text: 'As a workspace administrator with Use financial reports: look up accounting journal entries when you also have finance access through a grant or as the workspace owner',
        sites: { 'src/lib/pharmacy/accounts/journal-entry-lookup.ts': 1 },
      },
      {
        id: 'workspace-administrator-use-financial-3',
        text: 'As a workspace administrator with Use financial reports: view the fiscal exceptions register',
        sites: { 'src/lib/pharmacy/accounts/fiscal-exceptions.reader.ts': 1 },
      },
      {
        id: 'workspace-administrator-use-financial-4',
        text: 'As a workspace administrator with Use financial reports: ask the assistant for stock capital, leakage, margin and repeat-purchase insights',
        sites: { 'src/lib/ai/tools/pharmacy-reports.ts': 2 },
      },
      {
        id: 'workspace-administrator-use-financial-5',
        text: 'As a workspace administrator with Use financial reports and the CRM module: generate, review and view basket and growth suggestions',
        sites: { 'src/server/routers/pharmacy-marketing.ts': 1 },
      },
      {
        id: 'workspace-administrator-use-financial-6',
        text: 'As a workspace administrator with Use financial reports: receive the daily owner digest',
        sites: { 'src/lib/pharmacy/owner-digest.ts': 1 },
      },
      {
        id: 'delivery-distance-profitability',
        text: 'As a workspace administrator with Use financial reports: see delivered-order profitability by delivery distance',
        sites: {},
      },
      {
        id: 'admin-view-repeat-lostsales-packflags',
        text: 'As a workspace administrator with Use financial reports: view the repeat-purchasing, lost-sales recovery and pack-authentication flag reports for every branch',
        sites: {},
      },
    ],
  },
  {
    key: 'controlled-medicines',
    label: 'Controlled medicines and safety',
    homeRole: 'owner',
    actions: ['pharmacy:safety'],
    allows: [
      {
        id: 'view-controlled-medicines-register',
        text: "View the controlled medicines register and export inspection packs for their branches, and correct entries with another pharmacist's authenticator code (or PIN, if the owner turned the authenticator off); for the whole pharmacy, approve register incidents, place legal holds, extend record keeping and install the procedures library",
        sites: { 'src/server/routers/pharmacy-safety.ts': 1 },
      },
      {
        id: 'see-which-pharmacists-can',
        text: 'See which pharmacists can witness controlled-medicine entries',
        sites: { 'src/server/routers/pharmacy-safety.ts': 1 },
      },
      {
        id: 'view-official-price-notices',
        text: 'View official price notices and price alerts',
        sites: { 'src/server/routers/pharmacy-medicine.ts': 2 },
      },
      {
        id: 'upload-official-price-notices',
        text: 'Upload official price notices and dismiss official price alerts',
        sites: { 'src/server/routers/pharmacy-medicine.ts': 2 },
      },
      {
        id: 'manage-recalls-whole-pharmacy',
        text: 'Manage recalls for the whole pharmacy, see recall contact lists, block or unblock batches and quarantine stock at any branch',
        sites: { 'src/server/routers/pharmacy-inventory.ts': 1 },
      },
      {
        id: 'trace-recall-their-branches',
        text: "Trace a recall's stock and units sold at their branches; a workspace administrator with Manage stock sees every branch",
        sites: {},
      },
      {
        id: 'open-substitution-workspace-review',
        text: 'Open the substitution workspace to review substitutions',
        sites: { 'src/server/routers/pharmacy-dispensing.ts': 1 },
      },
      {
        id: 'review-mark-ready-submit',
        text: 'Review, mark ready, submit and export adverse-reaction, medication-error and product-quality reports for their branches',
        sites: { 'src/server/routers/pharmacy-reports.ts': 1 },
      },
      {
        id: 'file-adversereaction-medicationerror-productquality',
        text: 'File adverse-reaction, medication-error and product-quality reports for their branches',
        sites: { 'src/server/routers/pharmacy-reports.ts': 1 },
      },
      {
        id: 'order-receive-stock-see',
        text: 'With Order and receive stock, see who can witness a controlled delivery and see official price alerts while purchasing',
        sites: { 'src/server/routers/pharmacy-purchasing.ts': 3 },
      },
      {
        id: 'order-receive-stock-reverse',
        text: "With Order and receive stock, reverse a delivery that included controlled medicines, with another pharmacist's authenticator code (or PIN, if the owner turned the authenticator off)",
        sites: { 'src/lib/pharmacy/goods-receipt.ts': 1 },
      },
    ],
  },
  {
    key: 'suggest-catalogue-edits',
    label: 'Suggest medicine catalogue changes',
    homeRole: 'owner',
    actions: ['pharmacy:catalogue-edit'],
    allows: [
      {
        id: 'only-workspace-administrator-add',
        text: 'Only as a workspace administrator: add new medicines as unsaleable drafts and propose catalogue changes for review',
        sites: { 'src/server/routers/pharmacy-medicine.ts': 1 },
      },
      {
        id: 'request-create-imported-medicines',
        text: 'Only as a workspace administrator: ask for the medicines in an imported file to be created, follow the request and create them once someone approves it',
        sites: {},
      },
      {
        id: 'owner-approve-no-reviewer',
        text: 'As the owner and a workspace administrator, while nobody else can review: approve catalogue changes, review medicine details and publish or withdraw medicines, approving with a fresh authenticator code (or PIN, if the owner turned the authenticator off)',
        sites: {},
      },
    ],
  },
];

export const PHARMACY_ACTION_NON_GRANTING_SITES: Readonly<
  Record<string, Readonly<Record<string, NonGrantingSite>>>
> = {
  'finance:read': {
    'src/app/api/v1/clients/[id]/route.ts': {
      count: 1,
      reason: 'API bearer-token scope, granted separately from a person’s pharmacy role',
    },
    'src/app/api/v1/clients/route.ts': {
      count: 1,
      reason: 'API bearer-token scope, granted separately from a person’s pharmacy role',
    },
    'src/app/api/v1/finance/summary/route.ts': {
      count: 1,
      reason: 'API bearer-token scope, granted separately from a person’s pharmacy role',
    },
    'src/app/api/v1/invoices/[id]/route.ts': {
      count: 1,
      reason: 'API bearer-token scope, granted separately from a person’s pharmacy role',
    },
    'src/app/api/v1/invoices/route.ts': {
      count: 1,
      reason: 'API bearer-token scope, granted separately from a person’s pharmacy role',
    },
    'src/app/api/v1/transactions/route.ts': {
      count: 1,
      reason: 'API bearer-token scope, granted separately from a person’s pharmacy role',
    },
    'src/lib/api-auth.ts': {
      count: 1,
      reason: 'API bearer-token scope, granted separately from a person’s pharmacy role',
    },
    'src/lib/ai/tools/finance.ts': { count: 1, reason: 'comment describing the finance check' },
    'src/lib/pharmacy/accounts/ap-reversal-approvers.ts': {
      count: 1,
      reason: 'comment describing the finance check',
    },
    'src/server/pharmacy-general-journal-security.ts': {
      count: 1,
      reason: 'comment describing the finance check',
    },
    'src/server/routers/pharmacy-ap-invoices.ts': {
      count: 1,
      reason: 'comment describing the finance check',
    },
  },
  'pharmacy:counter': {
    'src/server/routers/pharmacy-access.ts': { count: 3, reason: 'comment and the menu list' },
    'src/lib/pharmacy/accounts/ap-reversal-approvers.ts': {
      count: 1,
      reason: 'comment: supplier reversals never apply the counter gate',
    },
    'src/lib/pharmacy/card-terminal/review-approvers.ts': {
      count: 1,
      reason: 'comment on the branch-only gate other controls use',
    },
    'src/server/routers/pharmacy-sales.ts': {
      count: 9,
      reason:
        'a type, comments, sale-readiness wording, a rule that makes a cashier open a drawer first (a restriction), and a screen flag',
    },
    'src/server/routers/pharmacy-ordering.ts': { count: 1, reason: 'type annotation' },
    'src/server/routers/pharmacy-purchasing.ts': { count: 1, reason: 'comment' },
    'src/lib/pharmacy/counter-messages.ts': { count: 4, reason: 'refusal messages' },
    'src/lib/pharmacy/settlement.ts': { count: 1, reason: 'comment' },
    'src/lib/pharmacy/staff-home.ts': { count: 1, reason: 'home-page link' },
    'src/lib/pharmacy/landing.ts': { count: 2, reason: 'comment and landing page' },
    'src/lib/pharmacy/counter-capability.ts': { count: 1, reason: 'comment' },
    'src/lib/pharmacy/procurement-access.ts': { count: 1, reason: 'comment' },
  },
  'pharmacy:orders': {
    'src/server/routers/pharmacy-purchasing.ts': { count: 1, reason: 'comment' },
    'src/lib/pharmacy/procurement-access.ts': { count: 1, reason: 'comment' },
  },
  'sop:complete': {
    'src/server/routers/pharmacy-sop.ts': {
      count: 2,
      reason: 'comment and a flag returned to the screen',
    },
    'src/lib/pharmacy/sop-evidence.ts': { count: 2, reason: 'comment and type' },
    'src/app/api/pharmacy/sop/evidence/route.ts': {
      count: 1,
      reason: 'comment; the upload is checked by the procedures router',
    },
  },
  'pharmacy:dispense': {
    'src/lib/approval-approver-rights.ts': {
      count: 2,
      reason:
        'DEV-961: the registry of approver rights the shared approval path accepts and the forced authenticator set-up asks about (a comment and the list); grants nothing',
    },
    'src/lib/pharmacy/goods-receipt.ts': {
      count: 1,
      reason:
        'DEV-961: names the approver right this approval already checks, for the shared approval path (approverRight); grants nothing',
    },
    'src/lib/pharmacy/write-off-witness.ts': {
      count: 1,
      reason:
        'DEV-961: names the approver right this approval already checks, for the shared approval path (approverRight); grants nothing',
    },
    'src/server/routers/pharmacy-safety.ts': {
      count: 1,
      reason:
        'DEV-961: names the approver right this approval already checks, for the shared approval path (approverRight); grants nothing',
    },
    'src/server/routers/pharmacy-prescriptions.ts': {
      count: 2,
      reason: 'comment, and a flag that hides fill buttons; the fill procedures check separately',
    },
    'src/server/routers/pharmacy-access.ts': {
      count: 3,
      reason: 'comments and the menu list; each page checks separately',
    },
    'src/server/routers/pharmacy-sales.ts': {
      count: 4,
      reason:
        'a type annotation, and a filter that keeps dispensing out of khata access; the legacy dotted name in the same khata filter; DEV-961: the approver right named for the shared approval path (grants nothing)',
    },
    'src/server/routers/pharmacy-ordering.ts': { count: 1, reason: 'type annotation' },
    'src/lib/pharmacy/counter-messages.ts': { count: 2, reason: 'comment and refusal messages' },
    'src/lib/pharmacy/sale-readiness.ts': {
      count: 2,
      reason: 'comment, and counting available countersigning pharmacists',
    },
    'src/lib/pharmacy/landing.ts': { count: 2, reason: 'comment and choosing the landing page' },
    'src/lib/pharmacy/controlled-restoration-authorization.ts': {
      count: 5,
      reason:
        'comment, a policy safety check, a type annotation, and counting other pharmacists for the solo exception; DEV-961: the approver right named for the shared approval path (grants nothing)',
    },
    'src/lib/pharmacy/rx-review-self-sign.ts': { count: 2, reason: 'comments' },
    'src/lib/pharmacy/pharmacist-check-policy.ts': {
      count: 2,
      reason:
        "a dispensing deny removes the owner's right to change the pharmacist-check setting; comment",
    },
    'src/lib/pharmacy/procurement-access.ts': { count: 1, reason: 'unused helper (no callers)' },
    'src/lib/pharmacy/refill-subscriptions.ts': { count: 1, reason: 'comment' },
    'src/lib/pharmacy/counter-line-approval.ts': { count: 1, reason: 'comment' },
    'src/lib/pharmacy/sop-adapter.ts': { count: 2, reason: 'comments' },
    'src/lib/pharmacy/counter-capability.ts': {
      count: 1,
      reason: 'a dispensing deny closes the whole counter; revokes, grants nothing',
    },
    'src/app/(app)/dashboard/pharmacist-home.tsx': {
      count: 2,
      reason: 'home-screen choice; the data comes from checked procedures',
    },
  },
  'pharmacy:prescriptions': {
    'src/server/routers/pharmacy-prescriptions.ts': { count: 1, reason: 'comment' },
    'src/server/routers/pharmacy-access.ts': { count: 2, reason: 'comment and the menu list' },
    'src/server/routers/pharmacy-dispensing.ts': { count: 1, reason: 'comment' },
    'src/server/routers/pharmacy-inventory.ts': { count: 1, reason: 'comment' },
    'src/app/(app)/dashboard/pharmacist-home.tsx': {
      count: 2,
      reason: 'home-screen choice; the data comes from checked procedures',
    },
  },
  'pharmacy:catalogue-review': {
    'src/lib/pharmacy/catalogue-approvals.ts': {
      count: 1,
      reason: "counts other reviewers to switch off the owner's solo-approval fallback",
    },
    'src/app/(app)/pharmacy/medicines/page.tsx': {
      count: 1,
      reason: 'page guard; the procedures behind the page check separately',
    },
  },
  'pharmacy:close': {
    'src/server/routers/pharmacy-sales.ts': {
      count: 4,
      reason: "a deny here blocks a manager's day close; checks and comments",
    },
    'src/server/routers/pharmacy-access.ts': { count: 4, reason: 'menu list' },
    'src/server/pharmacy-manager-branches.ts': { count: 1, reason: 'comment' },
  },
  'pharmacy:manage': {
    'src/lib/approval-approver-rights.ts': {
      count: 2,
      reason:
        'DEV-961: the registry of approver rights the shared approval path accepts and the forced authenticator set-up asks about (a comment and the list); grants nothing',
    },
    'src/lib/pharmacy/refund-authorization.ts': {
      count: 1,
      reason:
        'DEV-961: names the approver right this approval already checks, for the shared approval path (approverRight); grants nothing',
    },
    'src/server/routers/pharmacy-supplier-compliance.ts': { count: 1, reason: 'comment' },
    'src/lib/pharmacy/accounts/ap-reversal-approvers.ts': {
      count: 2,
      reason: 'comments; the approver count uses the shared card-review rule',
    },
    'src/server/routers/pharmacy-access.ts': {
      count: 2,
      reason: 'menu list; each page checks separately',
    },
    'src/lib/pharmacy/pharmacist-check-policy.ts': {
      count: 2,
      reason: "a deny here removes the owner's right to change the pharmacist-check setting",
    },
    'src/lib/pharmacy/supplier-compliance-policy.ts': {
      count: 3,
      reason: 'a deny list and comments',
    },
    'src/app/(app)/pharmacy/reports/page.tsx': {
      count: 1,
      reason: 'page guard; the procedures behind the page check separately',
    },
  },
  'pharmacy:procurement-approve': {
    'src/lib/approval-approver-rights.ts': {
      count: 2,
      reason:
        'DEV-961: the registry of approver rights the shared approval path accepts and the forced authenticator set-up asks about (a comment and the list); grants nothing',
    },
    'src/lib/pharmacy/purchase-approval.ts': {
      count: 1,
      reason:
        'DEV-961: names the approver right this approval already checks, for the shared approval path (approverRight); grants nothing',
    },
    'src/app/(app)/pharmacy/purchasing/orders/page.tsx': {
      count: 1,
      reason: 'decides which buttons the page offers; the server checks',
    },
    'src/app/(app)/pharmacy/purchasing/suppliers/page.tsx': {
      count: 1,
      reason: 'decides which buttons the page offers; the server checks',
    },
  },
  'sop:manage': {
    'src/server/routers/pharmacy-sop.ts': {
      count: 2,
      reason: 'comment and a flag returned to the screen',
    },
    'src/lib/pharmacy/sop-evidence.ts': { count: 2, reason: 'comment and type' },
  },
  'sop:verify': {
    'src/lib/approval-approver-rights.ts': {
      count: 2,
      reason:
        'DEV-961: the restaurant approver right in the shared registry (a comment and the list); grants nothing in a pharmacy',
    },
    'src/server/routers/pharmacy-sop.ts': {
      count: 4,
      reason: 'comments and a flag returned to the screen',
    },
    'src/lib/pharmacy/sop-evidence.ts': { count: 3, reason: 'comments and type' },
  },
  'pharmacy:procurement': {
    'src/server/routers/pharmacy-supplier-links.ts': { count: 1, reason: 'comment' },
    'src/server/routers/pharmacy-access.ts': { count: 2, reason: 'comment and the menu list' },
    'src/server/routers/pharmacy-sales.ts': { count: 1, reason: 'type annotation' },
    'src/lib/pharmacy/staff-home.ts': { count: 1, reason: 'home-page link' },
    'src/lib/pharmacy/supplier-compliance-policy.ts': {
      count: 2,
      reason: 'a deny here removes supplier-policy authority',
    },
  },
  'pharmacy:inventory': {
    'src/server/routers/pharmacy-medicine.ts': { count: 1, reason: 'comment' },
    'src/server/routers/pharmacy-access.ts': { count: 2, reason: 'comment and the menu list' },
    'src/server/routers/pharmacy-inventory.ts': { count: 7, reason: 'comments' },
    'src/lib/pharmacy/staff-home.ts': { count: 1, reason: 'home-page link' },
    'src/app/(app)/pharmacy/inventory/labels/page.tsx': {
      count: 1,
      reason: 'page guard; the procedures behind the page check separately',
    },
    'src/app/(app)/pharmacy/inventory/page.tsx': {
      count: 4,
      reason: 'comments, which forms the page offers, and refusal wording; the server checks',
    },
    'src/app/(app)/pharmacy/inventory/transfers/page.tsx': {
      count: 1,
      reason: 'page guard; the procedures behind the page check separately',
    },
  },
  'reports:financial': {
    'src/server/routers/pharmacy-reports.ts': {
      count: 2,
      reason: 'flags returned to the screen; the edits are checked separately',
    },
    'src/server/routers/pharmacy-inventory.ts': { count: 1, reason: 'comment' },
    'src/server/routers/pharmacy-sales.ts': { count: 1, reason: 'comment' },
    'src/lib/ai/tools/pharmacy-reports.ts': { count: 1, reason: 'comment' },
    'src/lib/pharmacy/report-labels.ts': { count: 2, reason: 'labels' },
    'src/lib/pharmacy/dashboard.ts': {
      count: 3,
      reason: 'dashboard widget tags; values are redacted on the server',
    },
    'src/lib/pharmacy/advice-access.ts': { count: 2, reason: 'comment and whether to show a link' },
    'src/lib/pharmacy/reports.ts': { count: 1, reason: 'type declaration' },
    'src/app/(app)/pharmacy/accounts/account-code-reference/page.tsx': {
      count: 1,
      reason: 'page guard; the procedures behind the page check separately',
    },
    'src/app/(app)/pharmacy/accounts/journal-evidence-export/page.tsx': {
      count: 1,
      reason: 'page guard; the procedures behind the page check separately',
    },
    'src/app/(app)/pharmacy/accounts/tax-profile-review/_lib/access.ts': {
      count: 1,
      reason: 'page guard; the procedures behind the page check separately',
    },
    'src/app/(app)/pharmacy/accounts/cheque-maturity/page.tsx': {
      count: 1,
      reason: 'page guard; the procedures behind the page check separately',
    },
    'src/app/(app)/pharmacy/inventory/expiry/page.tsx': { count: 1, reason: 'comment' },
    'src/app/(app)/pharmacy/purchasing/returns/page.tsx': {
      count: 2,
      reason: 'comment and page guard; the procedures behind the page check separately',
    },
    'src/app/(app)/pharmacy/reports/supplier-credit-follow-up/page.tsx': {
      count: 1,
      reason: 'page guard; the procedures behind the page check separately',
    },
  },
  'reports:operational': {
    'src/server/routers/pharmacy-reports.ts': {
      count: 4,
      reason: 'comments, and naming the duty whose deny blocks the manager branch path',
    },
    'src/server/routers/pharmacy-access.ts': { count: 4, reason: 'comments and the menu list' },
    'src/server/pharmacy-manager-branches.ts': { count: 1, reason: 'comment' },
    'src/lib/pharmacy/staff-home.ts': { count: 2, reason: 'comment and home-page routing' },
    'src/lib/pharmacy/landing.ts': { count: 2, reason: 'comment and landing page' },
    'src/lib/pharmacy/report-labels.ts': { count: 2, reason: 'labels' },
    'src/lib/pharmacy/dashboard.ts': {
      count: 8,
      reason: 'dashboard widget tags; values are redacted on the server',
    },
    'src/lib/pharmacy/advice-access.ts': { count: 2, reason: 'comment and whether to show a link' },
    'src/lib/pharmacy/reports.ts': { count: 1, reason: 'type declaration' },
    'src/app/(app)/dashboard/pharmacist-home.tsx': {
      count: 3,
      reason: 'home-screen choice; the data comes from checked procedures',
    },
    'src/app/(app)/dashboard/page.tsx': {
      count: 2,
      reason: 'home-screen choice; the data comes from checked procedures',
    },
    'src/app/(app)/pharmacy/reports/page.tsx': {
      count: 1,
      reason: 'page guard; the procedures behind the page check separately',
    },
    'src/app/(app)/pharmacy/accounts/account-code-reference/page.tsx': {
      count: 1,
      reason: 'page guard; the procedures behind the page check separately',
    },
    'src/app/(app)/pharmacy/accounts/journal-evidence-export/page.tsx': {
      count: 1,
      reason: 'page guard; the procedures behind the page check separately',
    },
    'src/app/(app)/pharmacy/accounts/tax-profile-review/_lib/access.ts': {
      count: 1,
      reason: 'page guard; the procedures behind the page check separately',
    },
  },
  'pharmacy:safety': {
    'src/server/routers/pharmacy-safety.ts': { count: 1, reason: 'a flag returned to the screen' },
    'src/server/routers/pharmacy-medicine.ts': {
      count: 1,
      reason: 'a procedure that always refuses (official prices are information only)',
    },
    'src/server/routers/pharmacy-access.ts': { count: 2, reason: 'comment and the menu list' },
    'src/server/routers/pharmacy-inventory.ts': { count: 1, reason: 'comment' },
    'src/server/routers/pharmacy-reports.ts': { count: 1, reason: 'comment' },
    'src/lib/pharmacy/procurement-access.ts': { count: 1, reason: 'unused helper (no callers)' },
    'src/lib/pharmacy/controlled-restoration-authorization.ts': {
      count: 1,
      reason: 'type annotation',
    },
  },
};

export const PHARMACY_SUB_ROLES: readonly PharmacySubRole[] = DEFINITIONS.map((definition) => ({
  ...definition,
  sensitive: definition.actions.some((action) => EXACT_GRANT_ONLY_ACTIONS.has(action)),
}));

/** Every action the pharmacy sub-roles cover, in catalogue order. */
export const PHARMACY_SUB_ROLE_ACTIONS: readonly Action[] = PHARMACY_SUB_ROLES.flatMap(
  (subRole) => subRole.actions
);

/** Finance ticks share the authorization used by the accounts procedures. */
export const PHARMACY_FINANCE_SUB_ROLES = PHARMACY_SUB_ROLES.filter((role) =>
  role.actions[0].startsWith('finance:')
);

type PermissionRule = { capability: string; effect: string };

export function changesPharmacyFinanceRules(
  before: readonly PermissionRule[],
  after: readonly PermissionRule[],
  mode: 'any' | 'increase' = 'any'
) {
  return PHARMACY_FINANCE_SUB_ROLES.some(({ actions: [action] }) => {
    const oldDecision = decideFromRules(before, action);
    const newDecision = decideFromRules(after, action);
    if (oldDecision === newDecision) return false;
    // Removing a denial can make a personal grant effective. An added denial only restricts access.
    return mode === 'any' || newDecision === true || oldDecision === false;
  });
}

/** The order in which role groups are shown; names come from the real templates. */
const GROUP_ORDER = [
  'cashier',
  'pharmacist',
  'manager',
  'procurement',
  'inventory',
  'finance',
  'auditor',
  'owner',
] as const;

export type PharmacySubRoleState = 'on' | 'off' | 'partial';

/** What the team screen receives: plain lines only, never the code locations. */
export type PharmacySubRoleView = {
  key: string;
  label: string;
  actions: readonly Action[];
  allows: string[];
  sensitive: boolean;
  state: PharmacySubRoleState;
};

export type PharmacySubRoleGroup = {
  roleKey: string;
  roleName: string;
  subRoles: PharmacySubRoleView[];
};

function templateName(key: string): string {
  return PHARMACY_ROLE_TEMPLATES.find((template) => template.key === key)?.name ?? key;
}

/** Ticks each sub-role whose actions are all in `allowed`; some of them is `partial`. */
export function pharmacySubRoleStates(
  allowed: ReadonlySet<string>,
  subRoles: readonly Pick<PharmacySubRole, 'key' | 'actions'>[] = PHARMACY_SUB_ROLES
): Map<string, PharmacySubRoleState> {
  return new Map(
    subRoles.map((subRole) => {
      const held = subRole.actions.filter((action) => allowed.has(action)).length;
      const state: PharmacySubRoleState =
        held === 0 ? 'off' : held === subRole.actions.length ? 'on' : 'partial';
      return [subRole.key, state];
    })
  );
}

/** All sub-roles grouped under their usual role, ticked from the allowed actions. */
export function pharmacySubRoleGroups(allowed: ReadonlySet<string>): PharmacySubRoleGroup[] {
  const states = pharmacySubRoleStates(allowed);
  return GROUP_ORDER.map((roleKey) => ({
    roleKey,
    roleName: templateName(roleKey),
    subRoles: PHARMACY_SUB_ROLES.filter((subRole) => subRole.homeRole === roleKey).map(
      (subRole) => ({
        key: subRole.key,
        label: subRole.label,
        actions: subRole.actions,
        allows: subRole.allows.map((item) => item.text),
        sensitive: subRole.sensitive,
        state: states.get(subRole.key) ?? 'off',
      })
    ),
  }));
}

/** The catalogue actions a set of persisted rules allows on its own (deny wins). */
export function pharmacyActionsAllowedByRules(
  rules: readonly { capability: string; effect: string }[]
): Set<Action> {
  return new Set(
    PHARMACY_SUB_ROLE_ACTIONS.filter((action) => decideFromRules(rules, action) === true)
  );
}

/** Keys of the sub-roles a ready-made pharmacy role has, from its real template. */
export function pharmacyTemplateSubRoleKeys(roleKey: string): string[] {
  const template = PHARMACY_ROLE_TEMPLATES.find((candidate) => candidate.key === roleKey);
  if (!template) return [];
  const allowed = pharmacyActionsAllowedByRules(
    template.capabilities.map((capability) => ({ capability, effect: 'ALLOW' }))
  );
  const states = pharmacySubRoleStates(allowed);
  return PHARMACY_SUB_ROLES.filter((subRole) => states.get(subRole.key) === 'on').map(
    (subRole) => subRole.key
  );
}
