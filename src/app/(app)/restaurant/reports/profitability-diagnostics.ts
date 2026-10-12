import { Prisma } from '@/generated/prisma/browser';
import { businessDateToUtcDate } from '@/lib/restaurant/business-date';
import type { readFoodCostReport } from '@/lib/restaurant/reports';

export type ProfitabilityDiagnostics =
  | {
      status: 'ready';
      report: Pick<
        Awaited<ReturnType<typeof readFoodCostReport>>,
        'range' | 'products' | 'uncostedProducts' | 'truncated'
      >;
      currency: string | null;
      scopeLabel: string;
      recipeCostFreshness: null;
    }
  | { status: 'unavailable'; reason: string };

// The canonical money module is server-only. Use the same installed Prisma
// Decimal browser export and HALF_UP policy; round only at display, never ranking.
export function diagnosticAmount(value: string, currency: string | null) {
  return `${currency || 'Currency unknown'} ${new Prisma.Decimal(value).toFixed(2, Prisma.Decimal.ROUND_HALF_UP)}`;
}

export function profitabilityDiagnostics(
  report: Extract<ProfitabilityDiagnostics, { status: 'ready' }>['report']
) {
  const from = businessDateToUtcDate(report.range.from);
  const to = businessDateToUtcDate(report.range.to);
  if (to < from || to.getTime() - from.getTime() > 89 * 86_400_000) {
    throw new RangeError('Choose an ordered business-date range of at most 90 days.');
  }
  const decimal = (value: string) => {
    const result = new Prisma.Decimal(value);
    if (!result.isFinite()) throw new RangeError('Report amount unavailable.');
    return result;
  };
  const costed = report.products.map((row) => {
    decimal(row.quantity);
    return { ...row, contribution: decimal(row.netSales).minus(decimal(row.theoreticalCost)) };
  });
  const negative = costed
    .filter((row) => row.contribution.isNegative())
    .sort(
      (a, b) => a.contribution.comparedTo(b.contribution) || a.productId.localeCompare(b.productId)
    );
  // Exclusions can contain several reasons for the same product. Aggregate sales
  // exposure before ranking products; this is not estimated loss or missing cost.
  const gaps = new Map<
    string,
    {
      productId: string;
      productName: string;
      netSales: InstanceType<typeof Prisma.Decimal>;
      quantity: InstanceType<typeof Prisma.Decimal>;
      reasons: Set<string>;
    }
  >();
  for (const row of report.uncostedProducts) {
    const gap = gaps.get(row.productId) ?? {
      productId: row.productId,
      productName: row.productName,
      netSales: new Prisma.Decimal(0),
      quantity: new Prisma.Decimal(0),
      reasons: new Set<string>(),
    };
    gap.netSales = gap.netSales.plus(decimal(row.netSales));
    gap.quantity = gap.quantity.plus(decimal(row.quantity));
    gap.reasons.add(row.reason);
    gaps.set(row.productId, gap);
  }
  const rankedGaps = [...gaps.values()].sort(
    (a, b) => b.netSales.comparedTo(a.netSales) || a.productId.localeCompare(b.productId)
  );
  const negativeTotal = negative.reduce(
    (sum, row) => sum.plus(row.contribution.abs()),
    new Prisma.Decimal(0)
  );
  const topNegative = negative.slice(0, 5);
  const topTotal = topNegative.reduce(
    (sum, row) => sum.plus(row.contribution.abs()),
    new Prisma.Decimal(0)
  );
  return {
    negative: topNegative.map((row) => ({ ...row, contribution: row.contribution.toString() })),
    negativeCount: negative.length,
    negativeTotal: negativeTotal.toString(),
    topTotal: topTotal.toString(),
    concentration: negativeTotal.isZero()
      ? null
      : topTotal.dividedBy(negativeTotal).times(100).toFixed(2, Prisma.Decimal.ROUND_HALF_UP),
    gaps: rankedGaps.slice(0, 5).map((row) => ({
      ...row,
      netSales: row.netSales.toString(),
      quantity: row.quantity.toString(),
      reasons: [...row.reasons],
    })),
    gapCount: gaps.size,
    costedCount: costed.length,
    // A product may have both covered and excluded sales groups.
    productCount: new Set([...costed.map((row) => row.productId), ...gaps.keys()]).size,
  };
}
