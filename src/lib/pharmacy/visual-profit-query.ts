import { Prisma } from '@/generated/prisma/client';
import { physicalReturnLines } from './visual-report-returns';
import { grossMarginQuery } from './finance-reports';
import { pharmacyBusinessDayRange, shiftPharmacyDay } from './business-day';
import type { ChartId } from './visual-chart';

type Window = { id: string; first: string; last: string; start_at: string; stop_at: string };
const sql = Prisma.sql;
const org = sql`current_setting('app.current_organization_id',true)`;

export function profitFacts(
  chart: ChartId,
  windows: Window[],
  branches: { id: string; businessDayEndsAtHistory?: unknown }[],
  zone: string
) {
  const daily = chart === 'profitDay' || chart === 'marginDay';
  const category = chart === 'profitCategory';
  // Resolve distinct branch clocks with the same business-day helper used by the drawer.
  const days: { id: string; day: string; start_at: string; stop_at: string }[] = [];
  if (daily) {
    const cache = new Map<string, { from: Date; to: Date }>();
    for (const [index, w] of windows.entries()) {
      const dayEnd = branches[index]!.businessDayEndsAtHistory;
      for (let day = w.first; day <= w.last; day = shiftPharmacyDay(day, 1)) {
        const key = JSON.stringify([day, dayEnd]);
        const times =
          cache.get(key) ?? pharmacyBusinessDayRange(day, day, { timeZone: zone, dayEnd });
        cache.set(key, times);
        days.push({
          id: w.id,
          day,
          start_at: times.from.toISOString(),
          stop_at: times.to.toISOString(),
        });
      }
    }
  }
  const ledger = grossMarginQuery(
    { organizationId: org, branchIds: windows.map((w) => w.id) },
    {
      from: new Date(windows.map((w) => w.start_at).sort()[0]!),
      to: new Date(
        windows
          .map((w) => w.stop_at)
          .sort()
          .at(-1)!
      ),
      by: 'postingLine',
      where: sql`AND EXISTS (SELECT 1 FROM bounds b WHERE b.id=line."branchId" AND entry."occurredAt">=b.start_at AND entry."occurredAt"<b.stop_at)`,
    }
  );
  const group = daily
    ? sql`day`
    : category
      ? sql`COALESCE(initcap(replace(m."productFamily"::text,'_',' ')), 'Uncategorised')`
      : sql`COALESCE(product,'Unknown medicine')`;
  const label = daily || category ? group : sql`COALESCE(m."productName",'Unknown medicine')`;
  return sql`WITH postings AS (${ledger}),
    days AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(days)}::jsonb) AS d(id text,day text,start_at timestamp,stop_at timestamp)),
    lines AS (
      SELECT key->>0 AS entry, key->>1 AS branch, key->>2 AS product,key->>3 AS source,
        "grossMarginMinor" AS profit, "revenueMinor"-"discountMinor" AS net
      FROM postings
    ), evidence AS (
      SELECT ${daily ? sql`d.day` : sql`NULL::text`} AS day, p.product,
        concat(p.entry,'/',p.source) AS ref, e.description AS description,e.currency::text AS currency,
        p.profit, p.net, 0 AS excluded
      FROM lines p JOIN finance_journal_entries e ON e."organizationId"=${org} AND e.id=p.entry
      ${daily ? sql`JOIN days d ON d.id=p.branch AND e."occurredAt">=d.start_at AND e."occurredAt"<d.stop_at` : Prisma.empty}
      UNION ALL
      SELECT s."businessDate"::text,l."medicineId",l.id,'No sale posting',NULL::text,0,0,1
      FROM bounds b JOIN pharmacy_sales s ON s."organizationId"=${org} AND s."branchId"=b.id AND s.status='COMPLETED'
        AND s."businessDate">=b.first AND s."businessDate"<b.stop
      JOIN pharmacy_sale_lines l ON l."organizationId"=s."organizationId" AND l."branchId"=s."branchId" AND l."saleId"=s.id
      WHERE NOT EXISTS (SELECT 1 FROM finance_journal_entries e WHERE e."organizationId"=${org} AND e."branchId"=b.id
        AND e."sourceKind"='PHARMACY_SALE_LINE' AND e."sourceId"=l.id)
      UNION ALL
      SELECT ${daily ? sql`d.day` : sql`NULL::text`},r."medicineId",r.id,'No return posting',NULL::text,0,0,1
      FROM (${physicalReturnLines}) r
      ${daily ? sql`JOIN days d ON d.id=r."branchId" AND r.at>=d.start_at AND r.at<d.stop_at` : Prisma.empty}
      WHERE NOT EXISTS (SELECT 1 FROM finance_journal_entries e WHERE e."organizationId"=${org} AND e."branchId"=r."branchId"
        AND e."sourceKind"=r.source AND e."sourceId"=r.id)
    )
    SELECT ${group} AS key,${label} AS label,ref,
      concat(COALESCE(m."productName",'Unknown medicine'),' · ',description,CASE WHEN excluded>0 THEN ' · Excluded' END) AS detail,
      profit AS amount,net AS base,excluded,currency
    FROM evidence LEFT JOIN pharmacy_medicines m ON m."organizationId"=${org} AND m.id=product`;
}
