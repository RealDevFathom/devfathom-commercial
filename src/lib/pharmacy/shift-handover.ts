import { formatCloseMoney, type CashCloseCheck, type CashCloseFinding } from './cash-close-check';

/**
 * DEV-695 — the shift handover note produced at drawer close. Pure composition
 * over numbers the database already computed: open emergency-supply
 * prescriptions, items promised to customers, the drawer cash variance, and the
 * flags from the #728 cash-close check (DEV-84). It runs no detector of its own:
 * unusual voids, refunds and variances are exactly that check's findings.
 *
 * The note is a draft for a person to read, edit and hand over. It never names a
 * medicine, salt, patient or customer — only counts, amounts and dates — and it
 * posts, saves and sends nothing.
 */
export const OPEN_CUSTOMER_ORDER_STATUSES = [
  'PROPOSED',
  'ACCEPTED',
  'PACKING',
  'READY_FOR_COLLECTION',
  'OUT_FOR_DELIVERY',
] as const;

export type OpenCustomerOrderStatus = (typeof OPEN_CUSTOMER_ORDER_STATUSES)[number];

const ORDER_STATUS_LABEL: Record<OpenCustomerOrderStatus, string> = {
  PROPOSED: 'awaiting acceptance',
  ACCEPTED: 'accepted',
  PACKING: 'being packed',
  READY_FOR_COLLECTION: 'ready for collection',
  OUT_FOR_DELIVERY: 'out for delivery',
};

export type ShiftHandoverFacts = {
  check: CashCloseCheck;
  /** Emergency supplies still waiting for the prescription to be brought in. */
  pendingRx: { count: number; oldestAt: Date | null };
  /** Open customer orders: status and when each one's reservation runs out. */
  orders: Array<{ status: OpenCustomerOrderStatus; reservationExpiresAt: Date }>;
  /** Customers promised a call (or a reserved pack) when stock arrives. */
  restock: { count: number; reserveOnArrival: number };
  /** The moment the note is drawn up; reservations before it are overdue. */
  now: Date;
};

export type ShiftHandoverNote = {
  businessDate: string;
  currency: string;
  closed: boolean;
  draft: true;
  readOnly: true;
  pendingRx: { count: number; oldestAt: string | null };
  promised: {
    openOrders: number;
    overdueOrders: number;
    ordersByStatus: Partial<Record<OpenCustomerOrderStatus, number>>;
    restockPromises: number;
    restockReserveOnArrival: number;
  };
  cash: {
    expectedMinor: number;
    countedMinor: number | null;
    varianceMinor: number | null;
  };
  /** The cash-close check's findings, unchanged and in its order. */
  flags: CashCloseFinding[];
  policyVersion: string;
  note: string;
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export function buildPharmacyShiftHandover(facts: ShiftHandoverFacts): ShiftHandoverNote {
  const { check } = facts;
  const money = (minor: number) => formatCloseMoney(minor, check.currency);
  const ordersByStatus: Partial<Record<OpenCustomerOrderStatus, number>> = {};
  for (const order of facts.orders)
    ordersByStatus[order.status] = (ordersByStatus[order.status] ?? 0) + 1;
  const overdueOrders = facts.orders.filter(
    (order) => order.reservationExpiresAt.getTime() < facts.now.getTime()
  ).length;
  const oldestAt = facts.pendingRx.oldestAt?.toISOString().slice(0, 10) ?? null;

  const rxLine = facts.pendingRx.count
    ? `- Pending Rx: ${plural(facts.pendingRx.count, 'emergency supply', 'emergency supplies')} still waiting for the prescription (oldest from ${oldestAt}).`
    : '- Pending Rx: none waiting for a prescription.';
  const statusParts = OPEN_CUSTOMER_ORDER_STATUSES.filter((status) => ordersByStatus[status]).map(
    (status) => `${ordersByStatus[status]} ${ORDER_STATUS_LABEL[status]}`
  );
  const orderLine = facts.orders.length
    ? `- Customer orders: ${plural(facts.orders.length, 'open order')} (${statusParts.join(', ')})${overdueOrders ? `; ${overdueOrders} past its reservation time` : ''}.`
    : '- Customer orders: none open.';
  const restockLine = facts.restock.count
    ? `- Restock promises: ${plural(facts.restock.count, 'customer')} to contact when stock arrives${facts.restock.reserveOnArrival ? ` (${facts.restock.reserveOnArrival} to reserve on arrival)` : ''}.`
    : '- Restock promises: none outstanding.';

  const { cashExpectedMinor, cashCountedMinor, cashVarianceMinor } = check.totals;
  const cashLine =
    cashCountedMinor === null || cashVarianceMinor === null
      ? `- Cash: ${money(cashExpectedMinor)} expected; not every drawer has been counted yet.`
      : `- Cash: ${money(cashCountedMinor)} counted against ${money(cashExpectedMinor)} expected — ${
          cashVarianceMinor === 0
            ? 'no variance'
            : `${cashVarianceMinor > 0 ? 'over' : 'short'} ${money(Math.abs(cashVarianceMinor))}`
        }.`;

  const flagLines = check.findings.length
    ? check.findings.map(
        (finding) => `- [${finding.severity.toLowerCase()}] ${finding.explanation}`
      )
    : ['- No unusual voids, refunds or variances flagged by the cash-close check.'];

  const note = [
    `Shift handover — ${check.businessDate} (${check.closed ? 'day closed' : 'day still open'})`,
    '',
    'For the next shift:',
    rxLine,
    orderLine,
    restockLine,
    cashLine,
    '',
    'Review items:',
    ...flagLines,
    '',
    'Draft from recorded figures. Review and edit before handing over; nothing has been saved or sent.',
  ].join('\n');

  return {
    businessDate: check.businessDate,
    currency: check.currency,
    closed: check.closed,
    draft: true,
    readOnly: true,
    pendingRx: { count: facts.pendingRx.count, oldestAt },
    promised: {
      openOrders: facts.orders.length,
      overdueOrders,
      ordersByStatus,
      restockPromises: facts.restock.count,
      restockReserveOnArrival: facts.restock.reserveOnArrival,
    },
    cash: {
      expectedMinor: cashExpectedMinor,
      countedMinor: cashCountedMinor,
      varianceMinor: cashVarianceMinor,
    },
    flags: check.findings,
    policyVersion: check.policyVersion,
    note,
  };
}
