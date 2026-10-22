import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { LOYALTY_POINT_VALUE_MINOR } from '@/lib/commerce/loyalty-arithmetic';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { validatePharmacyReportFilters, type PharmacyReportFilters } from './reports';

const BASIS_POINTS = 10_000;

export type LoyaltyDashboardMetrics = {
  vouchersIssuedCount: number;
  vouchersIssuedMinor: number;
  vouchersRedeemedCount: number;
  vouchersRedeemedMinor: number;
  redemptionRateBasisPoints: number;
  repeatVisitRateBasisPoints: number;
  churnedCustomersCount: number;
  churnDays: number;
  pointsLiabilityMinor: number;
  netMarginImpactMinor: number;
};

type CountMoney = { count: number; amountMinor: number };
type CustomerCounts = { total: number; repeat: number };

export function rateBasisPoints(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : Math.floor((numerator * BASIS_POINTS) / denominator);
}

export function composeLoyaltyDashboardMetrics(input: {
  issued: CountMoney;
  redeemed: CountMoney;
  visitors: CustomerCounts;
  churnedCustomersCount: number;
  churnDays: number;
  pointsBalance: number;
  redeemedMarginMinor: number;
}): LoyaltyDashboardMetrics {
  return {
    vouchersIssuedCount: input.issued.count,
    vouchersIssuedMinor: input.issued.amountMinor,
    vouchersRedeemedCount: input.redeemed.count,
    vouchersRedeemedMinor: input.redeemed.amountMinor,
    redemptionRateBasisPoints: rateBasisPoints(input.redeemed.count, input.issued.count),
    repeatVisitRateBasisPoints: rateBasisPoints(input.visitors.repeat, input.visitors.total),
    churnedCustomersCount: input.churnedCustomersCount,
    churnDays: input.churnDays,
    pointsLiabilityMinor: Math.max(0, input.pointsBalance) * LOYALTY_POINT_VALUE_MINOR,
    netMarginImpactMinor: input.redeemedMarginMinor - input.redeemed.amountMinor,
  };
}

async function readIssuedVouchers(db: ScopedDb, branchIds: readonly string[], from: Date, to: Date) {
  const rows = await db.$queryRaw<CountMoney[]>(Prisma.sql`
    SELECT COUNT(*)::int AS count, COALESCE(SUM("valueMinor"), 0)::int AS "amountMinor"
    FROM pharmacy_vouchers
    WHERE "organizationId"=current_setting('app.current_organization_id', true)
      AND "branchId" IN (${Prisma.join(branchIds)}) AND "issuedAt">=${from} AND "issuedAt"<${to}`);
  return rows[0] ?? { count: 0, amountMinor: 0 };
}

async function readRedeemedVouchers(db: ScopedDb, branchIds: readonly string[], from: Date, to: Date) {
  const rows = await db.$queryRaw<CountMoney[]>(Prisma.sql`
    SELECT COUNT(*)::int AS count, COALESCE(SUM("valueMinor"), 0)::int AS "amountMinor"
    FROM pharmacy_vouchers
    WHERE "organizationId"=current_setting('app.current_organization_id', true)
      AND "branchId" IN (${Prisma.join(branchIds)}) AND "status"='REDEEMED'
      AND "redeemedAt">=${from} AND "redeemedAt"<${to}`);
  return rows[0] ?? { count: 0, amountMinor: 0 };
}

async function readRepeatVisitors(db: ScopedDb, branchIds: readonly string[], from: Date, to: Date) {
  const rows = await db.$queryRaw<CustomerCounts[]>(Prisma.sql`
    WITH visits AS (
      SELECT "customerId", MIN("completedAt") AS first_in_period
      FROM pharmacy_sales
      WHERE "organizationId"=current_setting('app.current_organization_id', true)
        AND "branchId" IN (${Prisma.join(branchIds)}) AND status='COMPLETED' AND "customerId" IS NOT NULL
        AND "completedAt">=${from} AND "completedAt"<${to} GROUP BY "customerId"
    )
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM pharmacy_sales prior WHERE prior."organizationId"=current_setting('app.current_organization_id', true)
          AND prior."branchId" IN (${Prisma.join(branchIds)}) AND prior.status='COMPLETED'
          AND prior."customerId"=visits."customerId" AND prior."completedAt"<visits.first_in_period
      ))::int AS repeat FROM visits`);
  return rows[0] ?? { total: 0, repeat: 0 };
}

async function readChurnedCustomers(
  db: ScopedDb,
  branchIds: readonly string[],
  asOf: Date,
  churnDays: number
) {
  const rows = await db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS count FROM (
      SELECT "customerId", MAX("completedAt") AS last_visit FROM pharmacy_sales
      WHERE "organizationId"=current_setting('app.current_organization_id', true)
        AND "branchId" IN (${Prisma.join(branchIds)}) AND status='COMPLETED' AND "customerId" IS NOT NULL
        AND "completedAt"<${asOf} GROUP BY "customerId"
      HAVING MAX("completedAt") < ${new Date(asOf.getTime() - churnDays * 86_400_000)}
    ) churned`);
  return rows[0]?.count ?? 0;
}

async function readPointsBalance(db: ScopedDb, branchIds: readonly string[]) {
  const rows = await db.$queryRaw<Array<{ points: number }>>(Prisma.sql`
    SELECT COALESCE(SUM(points), 0)::int AS points FROM pharmacy_loyalty_points_entries
    WHERE "organizationId"=current_setting('app.current_organization_id', true)
      AND "branchId" IN (${Prisma.join(branchIds)})`);
  return rows[0]?.points ?? 0;
}

async function readRedeemedVoucherMargin(
  db: ScopedDb,
  branchIds: readonly string[],
  from: Date,
  to: Date
) {
  const rows = await db.$queryRaw<Array<{ marginMinor: number }>>(Prisma.sql`
    SELECT COALESCE(SUM((line."quantity" * line."unitPriceMinor" - line."discountMinor")::bigint
      * COALESCE(category."marginBasisPoints", settings."winBackDefaultMarginBasisPoints", 1450) / ${BASIS_POINTS}), 0)::int AS "marginMinor"
    FROM pharmacy_vouchers voucher
    JOIN pharmacy_sales sale ON sale."organizationId"=voucher."organizationId" AND sale.id=voucher."redeemedSaleId"
    JOIN pharmacy_sale_lines line ON line."organizationId"=sale."organizationId" AND line."saleId"=sale.id
    JOIN pharmacy_medicines medicine ON medicine."organizationId"=line."organizationId" AND medicine.id=line."medicineId"
    LEFT JOIN pharmacy_win_back_category_margins category ON category."organizationId"=medicine."organizationId"
      AND category."categoryId"=medicine."productFamily"::text
    LEFT JOIN pharmacy_loyalty_settings settings ON settings."organizationId"=voucher."organizationId"
    WHERE voucher."organizationId"=current_setting('app.current_organization_id', true)
      AND voucher."branchId" IN (${Prisma.join(branchIds)}) AND voucher.status='REDEEMED'
      AND voucher."redeemedAt">=${from} AND voucher."redeemedAt"<${to}`);
  return rows[0]?.marginMinor ?? 0;
}

export async function readPharmacyLoyaltyDashboard(
  db: ScopedDb,
  filters: PharmacyReportFilters,
  churnDays: number
) {
  const { from, to } = validatePharmacyReportFilters(filters);
  if (!Number.isSafeInteger(churnDays) || churnDays < 1 || churnDays > 3650)
    throw new Error('Churn days must be between 1 and 3650.');
  const [issued, redeemed, visitors, churnedCustomersCount, pointsBalance, redeemedMarginMinor] =
    await Promise.all([
      readIssuedVouchers(db, filters.branchIds, from, to),
      readRedeemedVouchers(db, filters.branchIds, from, to),
      readRepeatVisitors(db, filters.branchIds, from, to),
      readChurnedCustomers(db, filters.branchIds, to, churnDays),
      readPointsBalance(db, filters.branchIds),
      readRedeemedVoucherMargin(db, filters.branchIds, from, to),
    ]);
  return composeLoyaltyDashboardMetrics({
    issued,
    redeemed,
    visitors,
    churnedCustomersCount,
    churnDays,
    pointsBalance,
    redeemedMarginMinor,
  });
}
