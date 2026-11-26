import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';
import { pharmacyBusinessDay, pharmacyBusinessDayRange, shiftPharmacyDay } from './business-day';
import {
  previousReportPeriod,
  reportPeriod,
  type ReportPeriod,
  type ReportPreset,
} from './visual-report-period';
import { physicalReturnLines } from './visual-report-returns';
import { profitFacts } from './visual-profit-query';
import { REPORT_CHARTS, chartValue, type ChartId } from './visual-chart';
import { completedLineRevenue } from './visual-report-sales-basis';

type Branch = { id: string; businessDayEndsAtHistory?: unknown };
type ChartInput = {
  chart: ChartId;
  preset: ReportPreset;
  custom?: ReportPeriod;
  previous?: boolean;
  bucket?: string;
  offset?: number;
};
type Row = {
  currencies: string[] | null;
  included: bigint;
  key: string;
  label: string;
  amount: bigint;
  base: bigint;
  excluded: bigint;
};
const sql = Prisma.sql;

// Imported history extension point: a future source supplies separate, labelled series with
// its own coverage dates. These facts are exclusively live transactions.
function saleFacts(chart: ChartId, zone: string) {
  let key = sql`s."businessDate"::text`;
  let label = key;
  let joins = Prisma.empty;
  if (chart === 'salesHour') {
    key =
      label = sql`COALESCE(to_char((s."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${zone}, 'HH24:00'), 'Time unknown')`;
  } else if (chart === 'salesWeekday') {
    key = sql`EXTRACT(ISODOW FROM s."businessDate")::int::text`;
    label = sql`to_char(s."businessDate", 'FMDay')`;
  } else if (chart === 'salesCategory') {
    key = label = sql`COALESCE(initcap(replace(m."productFamily"::text,'_',' ')), 'Uncategorised')`;
  } else if (chart === 'salesCashier') {
    joins = sql`LEFT JOIN LATERAL (SELECT e."actorId" FROM pharmacy_sale_events e
      WHERE e."organizationId"=s."organizationId" AND e."branchId"=s."branchId" AND e."saleId"=s.id AND e.kind='COMPLETED'
      ORDER BY e."occurredAt" DESC,e.id DESC LIMIT 1) completion ON TRUE
      LEFT JOIN users u ON u."organizationId"=s."organizationId" AND u.id=COALESCE(completion."actorId",s."createdByUserId")`;
    key = sql`COALESCE(completion."actorId",s."createdByUserId")`;
    label = sql`COALESCE(u.name, 'Unknown cashier')`;
  }
  const revenue = completedLineRevenue;
  const returns = chart === 'returnRate' || chart === 'returnsDay';
  return sql`SELECT ${key} AS key, ${label} AS label, l.id AS ref,
    concat(COALESCE('Receipt '||s."receiptNumber"::text,'Sale '||s.id), ' · ',m."productName") AS detail,
    ${returns ? sql`0` : revenue}::bigint AS amount, ${returns ? revenue : sql`0`}::bigint AS base, 0 AS excluded
    FROM bounds b JOIN pharmacy_sales s ON s."organizationId"=${org} AND s."branchId"=b.id
      AND s.status='COMPLETED' AND s."businessDate">=b.first AND s."businessDate"<b.stop
    JOIN pharmacy_sale_lines l ON l."organizationId"=s."organizationId" AND l."branchId"=s."branchId" AND l."saleId"=s.id
    LEFT JOIN pharmacy_medicines m ON m."organizationId"=l."organizationId" AND m.id=l."medicineId"
    ${joins}`;
}

const org = sql`current_setting('app.current_organization_id',true)`;

function chartFacts(chart: ChartId, zone: string) {
  if (chart === 'salesPayment')
    return sql`SELECT t.type::text AS key, initcap(replace(t.type::text,'_',' ')) AS label,
    t.id AS ref,concat('Payment · ',t."saleId") AS detail,t."amountMinor"::bigint AS amount,0::bigint AS base,0 AS excluded
    FROM bounds b JOIN pharmacy_tenders t ON t."organizationId"=${org} AND t."branchId"=b.id
    AND t."businessDate">=b.first AND t."businessDate"<b.stop`;
  if (chart === 'returnMedicine' || chart === 'physicalReason') {
    const reason = sql`COALESCE(NULLIF(trim(reason),''),'No reason recorded')`;
    return sql`SELECT ${chart === 'returnMedicine' ? sql`"medicineId"` : reason} AS key,
      ${chart === 'returnMedicine' ? sql`"productName"` : reason} AS label,id AS ref,
      concat("productName",' · ',reason) AS detail,units::bigint AS amount,0::bigint AS base,0 AS excluded
      FROM (${physicalReturnLines}) physical`;
  }
  if (chart === 'returnReason' || chart === 'returnsDay' || chart === 'returnRate') {
    const group =
      chart === 'returnReason'
        ? sql`COALESCE(NULLIF(trim(r.reason),''),'No reason recorded')`
        : sql`r."businessDate"::text`;
    const refunds = sql`SELECT ${group} AS key,${group} AS label,r.id AS ref,concat('Refund · ',r.reason) AS detail,
      r."amountMinor"::bigint AS amount,0::bigint AS base,0 AS excluded
      FROM bounds b JOIN pharmacy_refunds r ON r."organizationId"=${org} AND r."branchId"=b.id
      AND r."businessDate">=b.first AND r."businessDate"<b.stop`;
    return chart === 'returnReason' ? refunds : sql`${refunds} UNION ALL ${saleFacts(chart, zone)}`;
  }
  return saleFacts(chart, zone);
}

export async function readVisualChart(
  db: ScopedDb,
  branches: Branch[],
  timeZone: string | undefined | null,
  input: ChartInput,
  now = new Date()
) {
  const zone = workspaceTimezone(timeZone);
  const windows = branches.map((branch) => {
    const clock = { timeZone: zone, dayEnd: branch.businessDayEndsAtHistory };
    const current = reportPeriod(input.preset, pharmacyBusinessDay(clock, now), input.custom);
    const period = input.previous ? previousReportPeriod(current) : current;
    const range = pharmacyBusinessDayRange(period.from, period.to, clock);
    return {
      id: branch.id,
      first: period.from,
      last: period.to,
      stop: shiftPharmacyDay(period.to, 1),
      start_at: range.from.toISOString(),
      stop_at: range.to.toISOString(),
    };
  });
  const period = {
    from: windows.map((w) => w.first).sort()[0]!,
    to: windows
      .map((w) => w.last)
      .sort()
      .at(-1)!,
  };
  const profit = REPORT_CHARTS.Profit.some((id) => id === input.chart);
  const facts = profit
    ? profitFacts(input.chart, windows, branches, zone)
    : chartFacts(input.chart, zone);
  const drill = input.bucket !== undefined;
  const groups = drill ? sql`ref,detail` : sql`key,label`;
  const rows = await db.$queryRaw<Row[]>(sql`WITH bounds AS (
    SELECT * FROM jsonb_to_recordset(${JSON.stringify(windows)}::jsonb)
    AS b(id text,first date,stop date,start_at timestamp,stop_at timestamp)
  ), facts AS (${facts})
  SELECT ${drill ? sql`ref AS key,detail AS label` : sql`key,label`},
  ${profit ? sql`ARRAY_AGG(DISTINCT currency) FILTER(WHERE currency IS NOT NULL)` : sql`NULL::text[]`} AS currencies,
  COUNT(*) FILTER (WHERE excluded=0) AS included, SUM(amount)::bigint AS amount,SUM(base)::bigint AS base,SUM(excluded)::bigint AS excluded
  FROM facts ${drill ? sql`WHERE key=${input.bucket}` : Prisma.empty}
  GROUP BY ${groups} ORDER BY ${drill ? sql`ref` : sql`key`}
  ${drill ? sql`LIMIT 51 OFFSET ${input.offset ?? 0}` : Prisma.empty}`);
  const number = (value: bigint) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new RangeError('Report total exceeds supported precision.');
    return n;
  };
  return {
    period,
    postedCurrencies: [...new Set(rows.flatMap((row) => row.currencies ?? []))].sort(),
    more: drill && rows.length > 50,
    rows: (drill ? rows.slice(0, 50) : rows).map((row) => {
      const amount = number(row.amount),
        base = number(row.base);
      return {
        key: row.key,
        label: row.label,
        amount,
        base,
        excluded: number(row.excluded),
        value: profit && Number(row.included) === 0 ? null : chartValue(input.chart, amount, base),
      };
    }),
  };
}
