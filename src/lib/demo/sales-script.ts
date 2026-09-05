export type DemoSalesScriptStep = {
  id:
    | 'dashboard'
    | 'pos-modifiers'
    | 'kds-ticket'
    | 'floor-table'
    | 'bill-settlement'
    | 'daily-close'
    | 'inventory-low-stock'
    | 'recipe-lines'
    | 'purchase-receipt'
    | 'reports-overview';
  title: string;
  talkingPoints: readonly [string, string, string?];
  likelyQuestion: string;
  answer: string;
};

export const DEMO_SALES_SCRIPT = [
  {
    id: 'dashboard',
    title: 'Chain overview',
    talkingPoints: [
      'Karahi Khaas runs Lahore DHA, Lahore Gulberg, and Karachi Clifton as one seeded PKR workspace.',
      'The dashboard starts with reconciled closed-day performance, then links directly into operational work.',
      'Each sales seat has isolated demo data, so another presenter cannot change this walkthrough.',
    ],
    likelyQuestion: 'Can a regional manager work across all three branches?',
    answer:
      'Yes. This demo manager is assigned across all three branches, while operational screens retain their branch scope.',
  },
  {
    id: 'pos-modifiers',
    title: 'POS order and modifiers',
    talkingPoints: [
      'The POS loads the currently published menu and keeps prices in PKR on each quoted order line.',
      'Modifier groups enforce required and maximum selections before an item can be added.',
      'Course, seat, table, and operator context travel with the order into kitchen service.',
    ],
    likelyQuestion: 'What happens if the connection drops during service?',
    answer:
      'The POS can keep new-order work in its bounded local queue; checkout and tender actions remain connected-only.',
  },
  {
    id: 'kds-ticket',
    title: 'Kitchen display',
    talkingPoints: [
      'This is the product KDS with real seeded tickets, station scope, course state, and ticket age.',
      'Kitchen staff progress individual items through held, fired, prepared, served, and remake states.',
      'The board refreshes its authoritative queue and keeps the last confirmed state visible during recovery.',
    ],
    likelyQuestion: 'Can separate kitchen stations receive different work?',
    answer:
      'Yes. Enrolled displays are branch and station scoped, so each board receives its own authorized ticket queue.',
  },
  {
    id: 'floor-table',
    title: 'Floor and tables',
    talkingPoints: [
      'The floor map shows actual tables, capacity, availability, and active-order occupancy.',
      'Karahi Khaas can maintain different floor layouts for Lahore DHA, Lahore Gulberg, and Karachi Clifton.',
      'Table and server-section context connects front-of-house seating to the same order ledger.',
    ],
    likelyQuestion: 'Can each branch have a different table plan?',
    answer:
      'Yes. Floors, tables, capacity, stations, and server sections are maintained within the selected branch.',
  },
  {
    id: 'bill-settlement',
    title: 'Bills, tenders, and refunds',
    talkingPoints: [
      'Checkout can cut one bill or split it by item, seat assignment, or fractional weight.',
      'Each open bill exposes its own tender balance, while settled bills retain receipt detail.',
      'Refunds are recorded against the selected tender and cannot exceed its remaining refundable amount.',
    ],
    likelyQuestion: 'Can guests split a bill and later receive a partial refund?',
    answer:
      'Yes. Bill splitting and per-tender partial refunds are separate, auditable operations in the settlement ledger.',
  },
  {
    id: 'daily-close',
    title: 'Daily close',
    talkingPoints: [
      'Daily close records tender totals, drawer variances, order totals, tax, and service-charge results.',
      'Corrections form a chain with one authoritative tip instead of overwriting the prior close.',
      'The register keeps branch, business date, device, and operator context visible for review.',
    ],
    likelyQuestion: 'What if a manager discovers a closing mistake tomorrow?',
    answer:
      'They create a correction in the close chain; the earlier record remains visible and the new tip becomes authoritative.',
  },
  {
    id: 'inventory-low-stock',
    title: 'Inventory and low stock',
    talkingPoints: [
      'On-hand balances and low-stock thresholds are shown by ingredient and storage location.',
      'Triggered rules make shortages visible before the next service instead of hiding them in a spreadsheet.',
      'The movement ledger records receipts, recipe consumption, wastage, spoilage, and staff meals as distinct reasons.',
    ],
    likelyQuestion: 'Can we see why stock fell, not only the current balance?',
    answer:
      'Yes. The stock movement ledger preserves reason, quantity, location, and occurrence time behind each balance.',
  },
  {
    id: 'recipe-lines',
    title: 'Recipes and unit conversion',
    talkingPoints: [
      'The selected seeded recipe exposes its versioned ingredient lines in grams, millilitres, and pieces.',
      'A 250 g line normalizes to 0.25 kg only through the defined gram-to-kilogram factor of 0.001.',
      'Volume and piece conversions remain ingredient-specific; the product never applies a blanket quantity conversion.',
    ],
    likelyQuestion: 'Will the system automatically convert millilitres into kilograms?',
    answer:
      'Only when a valid ingredient-specific conversion exists. It does not assume that volume and mass are interchangeable.',
  },
  {
    id: 'purchase-receipt',
    title: 'Purchasing and receiving',
    talkingPoints: [
      'Purchase orders retain supplier, branch, expected date, line quantity, unit, and approval state.',
      'Receiving records actual quantities and discrepancy notes against the selected order.',
      'Posted receipts feed the same stock intake ledger used by inventory operations.',
    ],
    likelyQuestion: 'Can the team trace a short delivery back to its purchase order?',
    answer:
      'Yes. Receipt history stays attached to the selected order with supplier, received lines, and discrepancy detail.',
  },
  {
    id: 'reports-overview',
    title: 'Operational reports',
    talkingPoints: [
      'Closed-day overview reports show orders, covers, top items, and permitted PKR sales totals.',
      'Inventory reporting brings valuation, negative stock, low stock, and wastage movements into the same date range.',
      'Purchasing reporting summarizes order value, receipts, supplier spend, status counts, and receiving discrepancies.',
    ],
    likelyQuestion: 'Does this demo include live card processing or fiscal certification?',
    answer:
      'No. It demonstrates DevFathom operational ledgers and PKR reporting, not a live card processor, fiscal certification, or an unconfigured external integration.',
  },
] as const satisfies readonly DemoSalesScriptStep[];
