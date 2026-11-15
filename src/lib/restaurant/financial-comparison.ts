import 'server-only';

import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { money, roundMoney, sub } from './money';
import {
  readPaymentsReport,
  RestaurantReportError,
  type RestaurantReportRange,
  validateRestaurantReportRange,
} from './reports';

const definitions = {
  grossSales: 'Settled bill subtotals before comps and discounts, on bill business date.',
  netSales:
    'Settled grossSales minus compTotal minus discountTotal minus the sales part of refunds (refund principal net of refunded tax, service charges and delivery fees). Excludes tax, service charges, tips and delivery fees; not profit or cash.',
  discountTotal: 'Discounts on settled bills, on bill business date.',
  compTotal: 'Comps on settled bills, on bill business date.',
  refundTotal:
    'Refund principal on processing business date, potentially for earlier sales; includes refunded tax and service charges. Already deducted from netSales for its sales part only.',
  taxTotal: 'Tax on settled bills, before refunds, on bill business date.',
  serviceChargeTotal: 'Service charges on settled bills, before refunds, on bill business date.',
  tipTotal: 'Tender tips on collection business date; not sales or net of tip refunds.',
  deliveryFeeSales: 'Delivery fees on settled bills, on bill business date.',
  deliveryFeeRefunds:
    'Delivery fee refunds on processing business date; a component of refundTotal.',
  voidTotal: 'Voided bill grand totals; excluded from settled sales, not realized loss.',
  cashExpected: 'Drawer ledger expected cash on drawer business date; not sales or profit.',
  cashCounted:
    'Counted drawer cash on drawer business date; null unless source-close drawer counts are complete. Not sales or profit.',
  cashVariance:
    'Counted minus expected drawer cash; null unless source-close drawer counts are complete. Discrepancy, not an attribution of loss.',
} as const;

export type RestaurantFinancialDriver = keyof typeof definitions;
type PaymentsReport = Awaited<ReturnType<typeof readPaymentsReport>>;
export type RestaurantFinancialChange = {
  definition: string;
  current: string | null;
  previous: string | null;
  absoluteChange: string | null;
  percentageChange: string | null;
};

export function restaurantComparisonWindows(range: RestaurantReportRange) {
  const parsed = validateRestaurantReportRange(range);
  if (new Set(range.branchIds).size !== range.branchIds.length) {
    throw new RestaurantReportError('Comparison branches must be unique.');
  }
  const previousFrom = new Date(parsed.from);
  previousFrom.setUTCDate(previousFrom.getUTCDate() - parsed.days);
  const previousTo = new Date(parsed.from);
  previousTo.setUTCDate(previousTo.getUTCDate() - 1);
  const previous = {
    branchIds: [...range.branchIds],
    from: previousFrom.toISOString().slice(0, 10),
    to: previousTo.toISOString().slice(0, 10),
  };
  // Bound total reader work, not just each half. At most 45 days per window.
  validateRestaurantReportRange({ ...range, from: previous.from });
  return { current: { ...range, branchIds: [...range.branchIds] }, previous, days: parsed.days };
}

/** Preserve the existing reader and chain-tip resolver, excluding closes written
 * after the shared cutoff. Mutable rollups still cannot provide an MVCC snapshot. */
function boundedReaderDb(db: ScopedDb, asOf: Date): ScopedDb {
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key === 'restaurantDailyClose') {
        return new Proxy(target.restaurantDailyClose, {
          get(delegate, method, delegateReceiver) {
            if (method === 'findMany')
              return (args: Prisma.RestaurantDailyCloseFindManyArgs) =>
                delegate.findMany({
                  ...args,
                  where: { ...args.where, createdAt: { lte: asOf } },
                });
            return Reflect.get(delegate, method, delegateReceiver);
          },
        });
      }
      if (key === 'insightDailyRollup') {
        return new Proxy(target.insightDailyRollup, {
          get(delegate, method, delegateReceiver) {
            if (method === 'findMany')
              return (args: Prisma.InsightDailyRollupFindManyArgs) =>
                delegate.findMany({
                  ...args,
                  where: { ...args.where, computedAt: { lte: asOf } },
                });
            return Reflect.get(delegate, method, delegateReceiver);
          },
        });
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

function change(
  key: RestaurantFinancialDriver,
  current: PaymentsReport,
  previous: PaymentsReport
): RestaurantFinancialChange {
  // Zero closed days is unknown coverage, not proof of zero activity.
  const needsCounts = key === 'cashCounted' || key === 'cashVariance';
  const value = (report: PaymentsReport) =>
    report.freshness.closedDayCount &&
    (!needsCounts || report.cashCountCoverage.status === 'COMPLETE')
      ? money(report[key]).toFixed(2)
      : null;
  const currentValue = value(current);
  const previousValue = value(previous);
  const delta =
    currentValue !== null && previousValue !== null ? sub(currentValue, previousValue) : null;
  return {
    definition: definitions[key],
    current: currentValue,
    previous: previousValue,
    absoluteChange: delta?.toFixed(2) ?? null,
    percentageChange:
      delta !== null && previousValue !== null && !money(previousValue).isZero()
        ? roundMoney(delta.dividedBy(money(previousValue).abs()).times(100)).toFixed(2)
        : null,
  };
}

function discountRate(current: PaymentsReport, previous: PaymentsReport) {
  const ratio = (report: PaymentsReport) => {
    const unavailableReason = !report.freshness.closedDayCount
      ? 'No observed closed branch-days.'
      : money(report.grossSales).lte(0)
        ? 'Settled gross sales must be positive to define the discount rate.'
        : null;
    return {
      value: unavailableReason
        ? null
        : money(report.discountTotal).times(100).dividedBy(money(report.grossSales)),
      unavailableReason,
    };
  };
  const now = ratio(current);
  const before = ratio(previous);
  return {
    unit: 'PERCENT' as const,
    definition:
      '100 * sum(settled bill discountTotal) / sum(settled bill subtotal before comps and discounts), for observed closed branch-days in each report period and scope. Excludes comps, refunds, tax, service charges, tips and delivery fees. Partial coverage is not a full-period rate.',
    current: now.value === null ? null : roundMoney(now.value).toFixed(2),
    previous: before.value === null ? null : roundMoney(before.value).toFixed(2),
    percentagePointChange:
      now.value !== null && before.value !== null
        ? roundMoney(now.value.minus(before.value)).toFixed(2)
        : null,
    changeDefinition:
      'Current minus previous in percentage points, calculated from unrounded ratios. Rates and change use Decimal arithmetic and HALF_UP rounding to 2 decimals.',
    unavailableReason: { current: now.unavailableReason, previous: before.unavailableReason },
  };
}

export async function readFinancialComparison(
  db: ScopedDb,
  range: RestaurantReportRange,
  scope: { organizationId: string }
) {
  const windows = restaurantComparisonWindows(range);
  const asOf = new Date();
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { currency: true },
  });
  const boundedDb = boundedReaderDb(db, asOf);
  const current = await readPaymentsReport(boundedDb, windows.current);
  const previous = await readPaymentsReport(boundedDb, windows.previous);
  const drivers = Object.fromEntries(
    (Object.keys(definitions) as RestaurantFinancialDriver[]).map((key) => [
      key,
      change(key, current, previous),
    ])
  ) as Record<RestaurantFinancialDriver, RestaurantFinancialChange>;
  return {
    scope: { organizationId: scope.organizationId, branchIds: windows.current.branchIds },
    currency: organization?.currency ?? null,
    currencyBasis:
      'Current server-side organization currency; daily closes do not pin historical currency. No conversion performed.',
    moneyUnit: 'DECIMAL_MAJOR' as const,
    periodBasis: 'BUSINESS_DATE' as const,
    periods: {
      current: { from: windows.current.from, to: windows.current.to },
      previous: { from: windows.previous.from, to: windows.previous.to },
      daysPerPeriod: windows.days,
    },
    source: 'readPaymentsReport: authoritative daily-close chain tips' as const,
    asOf: asOf.toISOString(),
    observedThrough: new Date().toISOString(),
    consistency: {
      snapshotGuaranteed: false as const,
      limitation:
        'Both windows filter close.createdAt and rollup.computedAt at asOf. ScopedDb does not establish repeatable-read isolation: later commits with earlier timestamps and mutable rollup replacement can affect observations. This is not a historical snapshot.',
    },
    coverage: { current: current.freshness, previous: previous.freshness },
    cashCountCoverage: { current: current.cashCountCoverage, previous: previous.cashCountCoverage },
    coverageDefinition:
      'Values sum observed closed branch-days only. Missing days are not imputed; no closed days yields null. Cash counted and variance additionally require COMPLETE cashCountCoverage for that period; otherwise the value and affected changes are null. Partial-window changes are not full-period comparisons. Rollup freshness is preserved separately from authoritative close amounts.',
    changeDefinition:
      'absoluteChange = current minus previous; percentageChange = 100 * change / abs(previous), rounded HALF_UP to 2 decimals; null for zero or unavailable baseline.',
    drivers,
    discountRate: discountRate(current, previous),
    refundAdjustedNetSales: null,
    refundAdjustedNetSalesUnavailableReason:
      'readPaymentsReport does not expose the tax/service-charge/principal refund allocation needed to adjust merchandise net sales correctly. Refunds remain separate; deliveryFeeRefunds must not be deducted again.',
  };
}

export type RestaurantFinancialComparison = Awaited<ReturnType<typeof readFinancialComparison>>;
