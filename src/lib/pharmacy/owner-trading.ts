import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import { workspaceTimezone } from '@/lib/timezone';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { pharmacyBusinessDay, pharmacyBusinessDayRange, shiftPharmacyDay } from './business-day';
import { onHandValueQuery } from './migration/parallel-run';
import { readExpiryBalances } from './reports';
import { grossMarginQuery } from './finance-reports';
import { reportSaleLineJoin, reportSaleLineMinor, reportTenderTotal } from './trading-report-sql';

type Branch = { id: string; name: string; businessDayEndsAtHistory?: unknown };
export function dashboardPeriods(branches: Branch[], timeZone?: string | null, at = new Date()) {
  return branches.map((branch) => {
    const clock = { timeZone, dayEnd: branch.businessDayEndsAtHistory };
    return { ...branch, clock, today: pharmacyBusinessDay(clock, at) };
  });
}
export type DashboardPeriod = ReturnType<typeof dashboardPeriods>[number];
type Row = { key: string; value: number };
export type TradingPoint = {
  label: string;
  value: number | null;
  previous?: number | null;
  count?: boolean;
};
export type TradingSection =
  | 'summary'
  | 'days'
  | 'hours'
  | 'payments'
  | 'branches'
  | 'medicines'
  | 'profits'
  | 'stock'
  | 'expiry';
export function comparisonDays(rows: Row[]): TradingPoint[] {
  const totals = new Map(rows.map((row) => [Number(row.key), row.value]));
  return Array.from({ length: 30 }, (_, index) => {
    const offset = index - 29;
    return {
      label: offset === 0 ? 'Today' : offset === -1 ? 'Yesterday' : `${-offset}d ago`,
      value: totals.get(offset) ?? 0,
      previous: totals.get(offset - 30) ?? 0,
    };
  });
}

function periodsTable(periods: DashboardPeriod[]) {
  return Prisma.sql`(VALUES ${Prisma.join(periods.map((p) => Prisma.sql`(${p.id}::text, ${p.today}::date)`))}) AS period(id, today)`;
}

function margin(
  organizationId: string,
  periods: DashboardPeriod[],
  days: number,
  endOffset: number,
  by: 'branch' | 'product'
) {
  const windows = periods.map((p) => {
    const end = shiftPharmacyDay(p.today, endOffset);
    return { id: p.id, ...pharmacyBusinessDayRange(shiftPharmacyDay(end, 1 - days), end, p.clock) };
  });
  return grossMarginQuery(
    { organizationId, branchIds: periods.map((p) => p.id) },
    {
      from: new Date(Math.min(...windows.map((w) => w.from.getTime()))),
      to: new Date(Math.max(...windows.map((w) => w.to.getTime()))),
      by,
      where: Prisma.sql`AND (${Prisma.join(
        windows.map(
          (w) =>
            Prisma.sql`(line."branchId"=${w.id} AND entry."occurredAt">=${w.from} AND entry."occurredAt"<${w.to})`
        ),
        ' OR '
      )})`,
    }
  );
}

export async function readOwnerTrading(
  db: ScopedDb,
  organizationId: string,
  periods: DashboardPeriod[],
  section: TradingSection,
  financial: boolean
): Promise<TradingPoint[]> {
  if (!periods.length) return [];
  if (section !== 'summary' && !financial) return [];
  if (section === 'expiry') {
    const [row] = await readExpiryBalances(
      db,
      periods.map((p) => p.id)
    );
    return ([30, 60, 90] as const).map((days) => ({
      label: `${days} days`,
      value: row?.[`d${days}`] ?? 0,
    }));
  }
  if (section === 'stock') {
    // Anchor on the same on-hand projection as the stock reconciliation report.
    // In one database snapshot subtract subsequent AVAILABLE movements to get each close.
    const days = periods.flatMap((p) =>
      Array.from({ length: 30 }, (_, i) => {
        const offset = i - 29;
        const day = shiftPharmacyDay(p.today, offset);
        const bounds = pharmacyBusinessDayRange(day, day, p.clock);
        return Prisma.sql`(${p.id}::text,${offset}::int,${bounds.from}::timestamp,${bounds.to}::timestamp)`;
      })
    );
    const rows = await db.$queryRaw<{ offset: number; value: number }[]>(Prisma.sql`
      WITH days(branch,offset_day,start_at,end_at) AS (VALUES ${Prisma.join(days)}),
      anchor AS (${onHandValueQuery(
        organizationId,
        periods.map((p) => p.id)
      )}),
      movement AS (SELECT d.offset_day, COALESCE(SUM(m."quantityUnits"::bigint * lot."unitCostMinor"),0) AS delta
        FROM days d LEFT JOIN pharmacy_stock_movements m ON m."organizationId"=${organizationId} AND m."branchId"=d.branch
          AND m.disposition='AVAILABLE' AND m."occurredAt">=d.start_at AND m."occurredAt"<d.end_at
        LEFT JOIN pharmacy_inventory_lots lot ON lot."organizationId"=m."organizationId" AND lot.id=m."inventoryLotId"
        GROUP BY d.offset_day)
      SELECT offset_day AS offset, ((SELECT value FROM anchor)-COALESCE(SUM(delta) OVER
        (ORDER BY offset_day ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING),0))::float8 AS value
      FROM movement ORDER BY offset_day`);
    return rows.map((r) => ({
      label: r.offset === 0 ? 'Today' : `${-r.offset}d ago`,
      value: r.value,
    }));
  }
  const dates = periodsTable(periods);
  const sales = Prisma.sql`FROM ${dates} JOIN pharmacy_sales s ON s."organizationId"=${organizationId} AND s."branchId"=period.id AND s.status='COMPLETED'`;
  const lines = Prisma.sql`JOIN pharmacy_sale_lines l ON ${reportSaleLineJoin}`;
  const amount = Prisma.sql`COALESCE(SUM(${reportSaleLineMinor}),0)::float8`;
  if (section === 'summary' || section === 'payments') {
    const day = Prisma.sql`t."businessDate"-period.today`;
    const tenders = financial
      ? await db.$queryRaw<{ offset: number; type: string; value: number }[]>(Prisma.sql`
      SELECT ${day} AS offset, t.type::text AS type, ${reportTenderTotal}::float8 AS value FROM ${dates}
      JOIN pharmacy_tenders t ON t."organizationId"=${organizationId} AND t."branchId"=period.id
      AND t."businessDate" IN (period.today, period.today-7) GROUP BY 1,2 ORDER BY 2`)
      : [];
    if (section === 'payments')
      return tenders
        .filter((t) => t.offset === 0)
        .map((t) => ({ label: t.type.replaceAll('_', ' '), value: t.value }));
    const rows = await db.$queryRaw<
      { offset: number; bills: number; value: number | null }[]
    >(Prisma.sql`
      SELECT s."businessDate"-period.today AS offset, COUNT(DISTINCT s.id)::int AS bills, ${financial ? amount : Prisma.sql`NULL::float8`} AS value
      ${sales} ${financial ? Prisma.sql`LEFT JOIN pharmacy_sale_lines l ON ${reportSaleLineJoin}` : Prisma.empty}
      WHERE s."businessDate" IN (period.today,period.today-7) GROUP BY 1`);
    const points = await Promise.all(
      [0, -7].map(async (offset) => {
        const row = rows.find((r) => r.offset === offset);
        const bills = row?.bills ?? 0;
        const points: TradingPoint[] = [{ label: 'Bills', value: bills, count: true }];
        if (!financial) return points;
        const revenue = row?.value ?? 0;
        const profit = margin(organizationId, periods, 1, offset, 'branch');
        const [total] = await db.$queryRaw<{ value: number | null }[]>(
          Prisma.sql`SELECT SUM("grossMarginMinor")::float8 AS value FROM (${profit}) AS posted`
        );
        points.unshift({ label: 'Sales', value: revenue });
        points.push(
          { label: 'Average bill', value: bills ? Math.round(revenue / bills) : null },
          { label: 'Gross profit', value: total?.value ?? null }
        );
        for (const [label, methods] of [
          ['Cash', ['CASH']],
          ['Card', ['CARD']],
          ['Wallet', ['WALLET', 'JAZZCASH', 'EASYPAISA']],
        ] as const) {
          points.push({
            label,
            value: tenders
              .filter((t) => t.offset === offset && methods.some((m) => m === t.type))
              .reduce((sum, t) => sum + t.value, 0),
          });
        }
        return points;
      })
    );
    return points[0]!.map((p, i) => ({ ...p, previous: points[1]![i]!.value }));
  }
  if (section === 'profits') {
    const profit = margin(organizationId, periods, 30, 0, 'product');
    return db.$queryRaw<TradingPoint[]>(
      Prisma.sql`SELECT m."productName" AS label, p."grossMarginMinor" AS value FROM (${profit}) p JOIN pharmacy_medicines m ON m.id=p.key AND m."organizationId"=${organizationId} WHERE m."productFamily"<>'FRONT_SHOP' ORDER BY value DESC, m.id LIMIT 10`
    );
  }
  const group = {
    days: Prisma.sql`s."businessDate"-period.today`,
    hours: Prisma.sql`EXTRACT(HOUR FROM (s."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${workspaceTimezone(periods[0]!.clock.timeZone)})::int`,
    branches: Prisma.sql`s."branchId"`,
    medicines: Prisma.sql`m.id`,
  }[section];
  const back = section === 'days' ? 59 : section === 'medicines' ? 29 : 0;
  const medicines = section === 'medicines';
  const rows = await db.$queryRaw<
    (Row & { name: string | null })[]
  >(Prisma.sql`SELECT (${group})::text AS key, ${amount} AS value, ${medicines ? Prisma.sql`MIN(m."productName")` : Prisma.sql`NULL::text`} AS name
    ${sales} ${lines}
    ${medicines ? Prisma.sql`JOIN pharmacy_medicines m ON m."organizationId"=s."organizationId" AND m.id=l."medicineId" AND m."productFamily"<>'FRONT_SHOP'` : Prisma.empty}
    WHERE s."businessDate" BETWEEN period.today-${back}::int AND period.today
    GROUP BY 1 ORDER BY value DESC, key ${medicines ? Prisma.sql`LIMIT 10` : Prisma.empty}`);
  if (section === 'days') return comparisonDays(rows);
  if (section === 'hours')
    return Array.from({ length: 24 }, (_, hour) => ({
      label: `${hour.toString().padStart(2, '0')}:00`,
      value: rows.find((r) => r.key === String(hour))?.value ?? 0,
    }));
  if (section === 'branches')
    return periods.map((p) => ({
      label: p.name,
      value: rows.find((r) => r.key === p.id)?.value ?? 0,
    }));
  return rows.map((r) => ({ label: r.name ?? r.key, value: r.value }));
}
