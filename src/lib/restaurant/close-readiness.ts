import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { businessDateToUtcDate, resolveBusinessDate } from './business-date';
import { closeFinancialPreview, countUnbilledActiveOrders, resolveChainTip } from './daily-close';
import { readPaymentsReport } from './reports';

export type CloseReadinessStatus = 'READY' | 'BLOCKED' | 'UNKNOWN' | 'ALREADY_CLOSED';
export type PrepareClosePacketInput = { branchId: string; businessDate: string; asOf: string };
export const CLOSE_PACKET_MAX_AGE_MS = 60_000;

export const CLOSE_PACKET_ROUTES = {
  bills: {
    href: '/restaurant/money',
    procedure: 'restaurantBills.listBills',
    capability: 'money:read',
    module: 'restaurant-pos',
  },
  drawers: {
    href: '/restaurant/money',
    procedure: 'restaurantCash.listDrawerSessions',
    capability: 'money:read',
    module: 'restaurant-pos',
  },
  closes: {
    href: '/restaurant/money',
    procedure: 'restaurantCash.listDailyCloses',
    capability: 'money:read',
    module: 'restaurant-pos',
  },
  orders: {
    href: '/restaurant/orders',
    procedure: 'restaurantOrders.listOrders',
    capability: 'orders:read',
    module: 'restaurant-pos',
  },
  reports: {
    href: '/restaurant/reports',
    procedure: 'restaurantReports.payments',
    capability: 'reports:financial',
    module: 'restaurant-core',
  },
} as const;
export type ClosePacketRoute = keyof typeof CLOSE_PACKET_ROUTES;
export type ClosePacketAccess = {
  organizationId: string;
  financial: boolean;
  operational: boolean;
  allowedRoutes: ClosePacketRoute[];
};
export type ClosePacketEvidence = {
  code: string;
  message: string;
  source: string;
  recordIds: string[];
  responsibleRole: 'FINANCE_MANAGER' | 'CASHIER' | 'SHIFT_MANAGER';
  allowedExistingRoutes: (typeof CLOSE_PACKET_ROUTES)[ClosePacketRoute][];
};
type Section<T> = {
  status: CloseReadinessStatus;
  blockers: ClosePacketEvidence[];
  missingEvidence: ClosePacketEvidence[];
  data: T | null;
};

const definitions = {
  grossSales: 'Settled bill subtotals on bill business date, before comps and discounts.',
  netSales:
    'Settled gross sales minus comps and discounts on bill business date, minus refund principal on processing business date; excludes tax, fees and tips. Not profit or cash.',
  refundTotal:
    'Refund principal on processing business date, including refunds for earlier sales; already deducted from netSales, reported separately.',
  tipTotal:
    'Tender tips on collection business date, including collections for earlier bills; not sales.',
  cashExpected:
    'Expected cash from the drawer movement ledger on drawer business date; not sales or profit.',
  cashCounted:
    'Counted drawer cash; null without complete count evidence. Explicit zero is a count.',
  cashVariance:
    'Counted minus expected drawer cash; null without complete count evidence. Discrepancy, not attributed loss.',
} as const;
type AmountKey = keyof typeof definitions;
type PaymentsReport = Awaited<ReturnType<typeof readPaymentsReport>>;
type FinancialData = {
  existingCloseId: string | null;
  closeGuards: Awaited<ReturnType<typeof closeFinancialPreview>>['readiness'] & {
    /** Present only when reports:operational authorizes the order evidence. */
    unbilledOrderCount?: number;
  };
  currency: string | null;
  currencyBasis: string;
  moneyUnit: 'DECIMAL_MAJOR';
  source: 'closePreview' | 'readPaymentsReport';
  amounts: Record<AmountKey, { value: string | null; definition: string }>;
  tenders: PaymentsReport['tenders'] | null;
  tenderDefinition: string;
  cashCountCoverage:
    | PaymentsReport['cashCountCoverage']
    | {
        status: 'COMPLETE' | 'INCOMPLETE';
        drawerSessionCount: number;
        missingCountSessionCount: number;
        definition: string;
      };
  reportFreshness: PaymentsReport['freshness'] | null;
};
type OperationalData = {
  unbilledOrders: { count: number; recordIds: string[]; truncated: boolean; definition: string };
  terminalSynchronization: 'UNKNOWN';
  staffClockouts: 'UNAVAILABLE';
};

export class ClosePacketError extends Error {
  constructor(
    message: string,
    readonly reason: 'INVALID' | 'NOT_FOUND' | 'FORBIDDEN'
  ) {
    super(message);
    this.name = 'ClosePacketError';
  }
}

/** On-demand, live domain reads only. Authorization is supplied by the audited API;
 * the ScopedDb remains pinned to that authenticated organization. No close command,
 * terminal action, job, external provider or idempotency record is invoked here. */
export async function prepareClosePacket(
  db: ScopedDb,
  input: PrepareClosePacketInput,
  access: ClosePacketAccess
) {
  if (!access.organizationId || (!access.financial && !access.operational)) {
    throw new ClosePacketError('Report access is required.', 'FORBIDDEN');
  }
  const startedAt = new Date();
  const asOf = new Date(input.asOf);
  if (!Number.isFinite(asOf.getTime()))
    throw new ClosePacketError('Invalid asOf timestamp.', 'INVALID');
  let businessDate: Date;
  try {
    businessDate = businessDateToUtcDate(input.businessDate);
  } catch {
    throw new ClosePacketError('Invalid business date.', 'INVALID');
  }
  const branch = await db.restaurantBranch.findFirst({
    where: { id: input.branchId, organizationId: access.organizationId },
    select: { id: true, timezone: true, businessDayCutoff: true },
  });
  if (!branch) throw new ClosePacketError('Restaurant branch not found.', 'NOT_FOUND');
  if (
    input.businessDate > resolveBusinessDate(startedAt, branch.timezone, branch.businessDayCutoff)
  ) {
    throw new ClosePacketError('Cannot prepare a future branch business date.', 'INVALID');
  }
  const scope = { organizationId: access.organizationId, branchId: input.branchId };
  const period = {
    from: input.businessDate,
    to: input.businessDate,
    basis: 'BUSINESS_DATE' as const,
  };
  const evidence = (
    code: string,
    message: string,
    source: string,
    responsibleRole: ClosePacketEvidence['responsibleRole'],
    routes: ClosePacketRoute[] = [],
    recordIds: string[] = []
  ): ClosePacketEvidence => ({
    code,
    message,
    source,
    recordIds,
    responsibleRole,
    allowedExistingRoutes: routes
      .filter((route) => access.allowedRoutes.includes(route))
      .map((route) => CLOSE_PACKET_ROUTES[route]),
  });
  const unavailable = <T>(code: string, message: string, source: string): Section<T> => ({
    status: 'UNKNOWN',
    blockers: [],
    data: null,
    missingEvidence: [evidence(code, message, source, 'SHIFT_MANAGER')],
  });
  let financial: Section<FinancialData> = unavailable(
    'FINANCIAL_PERMISSION_REQUIRED',
    'Financial evidence requires reports:financial.',
    'reports:financial'
  );
  let operational: Section<OperationalData> = unavailable(
    'OPERATIONAL_PERMISSION_REQUIRED',
    'Operational handover requires reports:operational.',
    'reports:operational'
  );
  const ageAtStart = startedAt.getTime() - asOf.getTime();
  const freshRequest = ageAtStart >= 0 && ageAtStart <= CLOSE_PACKET_MAX_AGE_MS;
  const where = { ...scope, businessDate };

  if (freshRequest && access.financial) {
    try {
      const organization = await db.organization.findUnique({
        where: { id: access.organizationId },
        select: { currency: true },
      });
      const preview = await closeFinancialPreview(db, input);
      const bills = await db.restaurantBill.findMany({
        where: { ...where, status: 'OPEN' },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 101,
      });
      const drawers = await db.restaurantDrawerSession.findMany({
        where,
        select: { id: true, status: true, countedCash: true },
      });
      const openDrawers = drawers.filter((drawer) => drawer.status === 'OPEN');
      const missingCounts = drawers.filter((drawer) => drawer.countedCash === null);
      const report = preview.existingCloseId
        ? await readPaymentsReport(db, {
            branchIds: [input.branchId],
            from: input.businessDate,
            to: input.businessDate,
          })
        : null;
      const cashCountCoverage = report?.cashCountCoverage ?? {
        status:
          missingCounts.length || openDrawers.length
            ? ('INCOMPLETE' as const)
            : ('COMPLETE' as const),
        drawerSessionCount: drawers.length,
        missingCountSessionCount: missingCounts.length,
        definition:
          'Live preview: every observed drawer must be CLOSED with a non-null count. No drawers is an observed empty set; no cash is imputed for missing counts.',
      };
      const blockers: ClosePacketEvidence[] = [];
      const missingEvidence: ClosePacketEvidence[] = [];
      if (preview.readiness.openBillCount > 0)
        blockers.push(
          evidence(
            'UNSETTLED_BILL',
            `${preview.readiness.openBillCount} open bills prevent the existing daily close. Record IDs show at most 100.`,
            'src/lib/restaurant/daily-close.ts#assertReadyToClose',
            'CASHIER',
            ['bills'],
            bills.slice(0, 100).map((row) => row.id)
          )
        );
      if (preview.readiness.openDrawerCount > 0)
        blockers.push(
          evidence(
            'OPEN_DRAWER',
            `${preview.readiness.openDrawerCount} open drawers prevent the existing daily close.`,
            'src/lib/restaurant/daily-close.ts#assertReadyToClose',
            'CASHIER',
            ['drawers'],
            openDrawers.slice(0, 100).map((row) => row.id)
          )
        );
      if (cashCountCoverage.status !== 'COMPLETE')
        missingEvidence.push(
          evidence(
            'CASH_COUNT_INCOMPLETE',
            'Cash counts are incomplete or do not verify the source close. Counted cash and variance are unavailable.',
            report
              ? 'src/lib/restaurant/reports.ts#readCashCountCoverage'
              : 'RestaurantDrawerSession.countedCash/status',
            'CASHIER',
            ['drawers'],
            missingCounts.slice(0, 100).map((row) => row.id)
          )
        );
      if (!organization?.currency)
        missingEvidence.push(
          evidence(
            'CURRENCY_UNAVAILABLE',
            'Organization currency is unavailable.',
            'Organization.currency',
            'FINANCE_MANAGER'
          )
        );
      if (
        Math.min(preview.readiness.openBillCount, 101) !== bills.length ||
        preview.readiness.openDrawerCount !== openDrawers.length ||
        (report && report.freshness.closedDayCount !== 1)
      )
        missingEvidence.push(
          evidence(
            'SOURCE_CHANGED',
            'Source reads disagree. Refresh the packet before acting.',
            'closePreview/readPaymentsReport',
            'FINANCE_MANAGER',
            ['reports']
          )
        );
      const amounts = Object.fromEntries(
        (Object.keys(definitions) as AmountKey[]).map((key) => [
          key,
          {
            value:
              !organization?.currency ||
              ((key === 'cashCounted' || key === 'cashVariance') &&
                cashCountCoverage.status !== 'COMPLETE') ||
              (report && !report.freshness.closedDayCount)
                ? null
                : report
                  ? report[key]
                  : preview[key].toString(),
            definition: definitions[key],
          },
        ])
      ) as FinancialData['amounts'];
      financial = {
        status: preview.existingCloseId
          ? 'ALREADY_CLOSED'
          : blockers.length
            ? 'BLOCKED'
            : missingEvidence.length
              ? 'UNKNOWN'
              : 'READY',
        blockers,
        missingEvidence,
        data: {
          existingCloseId: preview.existingCloseId,
          closeGuards: preview.readiness,
          currency: organization?.currency ?? null,
          currencyBasis:
            'Current authenticated organization currency; not historically pinned and no conversion performed.',
          moneyUnit: 'DECIMAL_MAJOR',
          source: report ? 'readPaymentsReport' : 'closePreview',
          amounts,
          tenders: organization?.currency
            ? (report?.tenders ??
              preview.tenderTotals.map((row) => ({
                tenderType: row.tenderType,
                amount: row.amount.toString(),
                tipAmount: row.tipAmount.toString(),
                count: row.count,
              })))
            : null,
          tenderDefinition:
            'Persisted tender principal and tips on collection business date, including earlier-day bills. Separate from sales and refunds; no provider capture or bank reconciliation is inferred.',
          cashCountCoverage,
          reportFreshness: report?.freshness ?? null,
        },
      };
      // A cut/correction between the preview and report must not attach amounts
      // from a different authoritative close to the preview's source ID.
      const finalCloses = await db.restaurantDailyClose.findMany({
        where,
        select: { id: true, supersedesCloseId: true },
        orderBy: { createdAt: 'asc' },
      });
      if ((resolveChainTip(finalCloses)?.id ?? null) !== preview.existingCloseId) {
        financial = unavailable(
          'SOURCE_CHANGED',
          'The daily-close chain changed during preparation. Refresh to read its authoritative amounts.',
          'src/lib/restaurant/daily-close.ts#resolveChainTip'
        );
      }
    } catch {
      financial = unavailable(
        'FINANCIAL_SOURCE_UNAVAILABLE',
        'Financial readers did not complete. No readiness or zero totals can be inferred.',
        'closePreview/readPaymentsReport'
      );
    }
  }
  if (freshRequest && access.operational) {
    try {
      // Matches the existing settlement predicate's NO_BILLS case. Fractional and
      // partially billed orders need that full predicate, not an item-count guess.
      const unbilledWhere = {
        ...where,
        status: { not: 'CANCELLED' as const },
        items: { some: { status: { not: 'VOIDED' as const } } },
        bills: { none: { status: { not: 'VOID' as const } } },
      };
      const count = await db.restaurantOrder.count({ where: unbilledWhere });
      const rows = await db.restaurantOrder.findMany({
        where: unbilledWhere,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 100,
      });
      const blockers = count
        ? [
            evidence(
              'UNBILLED_ORDERS',
              `${count} orders with active items have no live bill. Operational handover requires review.`,
              'src/lib/restaurant/bills.ts#evaluateOrderSettlement:NO_BILLS',
              'SHIFT_MANAGER',
              ['orders'],
              rows.map((row) => row.id)
            ),
          ]
        : [];
      operational = {
        status: blockers.length ? 'BLOCKED' : 'UNKNOWN',
        blockers,
        missingEvidence: [
          evidence(
            'TERMINAL_SYNC_UNKNOWN',
            'No authoritative evidence proves every offline terminal has synchronized. An empty server queue cannot establish this.',
            'terminal-local offline queues: no complete server-side reader',
            'SHIFT_MANAGER'
          ),
          evidence(
            'PARTIAL_BILL_COVERAGE_UNAVAILABLE',
            'This read proves only orders with no live bill. Partial bill coverage and fractional settlement require the existing per-order settlement review.',
            'src/lib/restaurant/bills.ts#evaluateOrderSettlement',
            'SHIFT_MANAGER',
            ['orders']
          ),
          evidence(
            'STAFF_CLOCKOUTS_UNAVAILABLE',
            'Staff clockouts are outside this report permission and preparation reader.',
            'workforce permission boundary',
            'SHIFT_MANAGER'
          ),
        ],
        data: {
          unbilledOrders: {
            count,
            recordIds: rows.map((row) => row.id),
            truncated: count > rows.length,
            definition:
              'Selected branch/business date: non-cancelled orders with non-voided items and no non-void bill. Does not prove partial/fractional bill coverage.',
          },
          terminalSynchronization: 'UNKNOWN',
          staffClockouts: 'UNAVAILABLE',
        },
      };
      if (Math.min(count, 100) !== rows.length) {
        operational.missingEvidence.push(
          evidence(
            'SOURCE_CHANGED',
            'Order count and records changed between reads. Refresh before handover.',
            'RestaurantOrder.count/findMany',
            'SHIFT_MANAGER',
            ['orders']
          )
        );
        operational.status = 'UNKNOWN';
      }
      // This close guard includes empty active orders as well as orders with
      // items. Keep the existing handover evidence and its definition intact.
      const unbilledOrderCount = await countUnbilledActiveOrders(db, input.branchId, businessDate);
      if (financial.data) {
        financial.data.closeGuards.unbilledOrderCount = unbilledOrderCount;
        financial.data.closeGuards.allBillsResolved &&= unbilledOrderCount === 0;
        if (unbilledOrderCount > 0) {
          financial.blockers.push(
            evidence(
              'UNBILLED_ORDERS',
              `${unbilledOrderCount} active orders without a live bill prevent the existing daily close.`,
              'src/lib/restaurant/daily-close.ts#assertReadyToClose',
              'CASHIER',
              ['orders']
            )
          );
          if (financial.status !== 'ALREADY_CLOSED') financial.status = 'BLOCKED';
        }
      }
    } catch {
      operational = unavailable(
        'OPERATIONAL_SOURCE_UNAVAILABLE',
        'Operational readers did not complete. Unbilled orders are unavailable, not zero.',
        'RestaurantOrder.count/findMany'
      );
    }
  }
  if (financial.data && financial.data.closeGuards.unbilledOrderCount === undefined) {
    financial.missingEvidence.push(
      evidence(
        'ORDER_CLOSE_GUARD_UNAVAILABLE',
        'The operational order guard could not be verified. Financial evidence alone does not establish daily-close readiness.',
        'src/lib/restaurant/daily-close.ts#countUnbilledActiveOrders',
        'SHIFT_MANAGER',
        ['orders']
      )
    );
    if (financial.status === 'READY') financial.status = 'UNKNOWN';
  }
  const completedAt = new Date();
  const fresh = freshRequest && completedAt.getTime() - asOf.getTime() <= CLOSE_PACKET_MAX_AGE_MS;
  if (!fresh) {
    if (access.financial)
      financial = unavailable(
        'FRESHNESS_UNAVAILABLE',
        'Request is stale, future-dated or preparation exceeded its freshness window. Request a new packet.',
        'server observation clock'
      );
    if (access.operational)
      operational = unavailable(
        'FRESHNESS_UNAVAILABLE',
        'Request a new packet; historical state cannot be reconstructed by live readers.',
        'server observation clock'
      );
  }
  const status: CloseReadinessStatus =
    financial.status === 'ALREADY_CLOSED'
      ? 'ALREADY_CLOSED'
      : financial.status === 'BLOCKED' || operational.status === 'BLOCKED'
        ? 'BLOCKED'
        : 'UNKNOWN';
  return {
    scope,
    period,
    status,
    financial,
    operational,
    freshness: {
      status: fresh ? ('LIVE_OBSERVATION' as const) : ('UNAVAILABLE' as const),
      asOf: asOf.toISOString(),
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      expiresAt: new Date(asOf.getTime() + CLOSE_PACKET_MAX_AGE_MS).toISOString(),
      definition:
        'asOf is a request freshness anchor, not a historical cutoff. Sequential live readers are not an atomic snapshot; mutable rows may change during or after preparation. Refresh before any existing action.',
    },
    unattendedCloseReady: false as const,
    execution: {
      mode: 'READ_ONLY' as const,
      scheduled: false as const,
      definition:
        'Preparation runs on request. Scheduling requires a later explicit opt-in through existing jobs. Existing close guards, locking and idempotency remain authoritative.',
    },
  };
}

export type RestaurantClosePacket = Awaited<ReturnType<typeof prepareClosePacket>>;
