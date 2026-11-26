'use client';
import { useRef, useState } from 'react';
import {
  BusinessChart,
  reportMoney,
  type BusinessChartPoint,
} from '@/components/charts/business-chart';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { SelectField } from '@/components/ui/select-field';
import { trpc } from '@/lib/trpc';
import {
  CHARTS,
  REPORT_CHARTS,
  chartValue,
  type ChartId,
  type ChartRow,
} from '@/lib/pharmacy/visual-chart';
import {
  reportPeriod,
  REPORT_PRESETS,
  type ReportPeriod,
  type ReportPreset,
} from '@/lib/pharmacy/visual-report-period';
import { shiftPharmacyDay } from '@/lib/pharmacy/business-day';
import { VisualReportTable } from './visual-report-table';

type Filters = { preset: ReportPreset; custom?: ReportPeriod; branchId?: string };
type ReportName = keyof typeof REPORT_CHARTS;
type Drill = { chart: ChartId; key: string; label: string; previous?: boolean };
const isProfit = (chart: ChartId) => REPORT_CHARTS.Profit.some((id) => id === chart);
const percent = (chart: ChartId) =>
  ['returnRate', 'topMargin', 'bottomMargin', 'marginDay'].includes(chart);
const unitCount = (chart: ChartId) => chart === 'returnMedicine' || chart === 'physicalReason';
const formatter = (chart: ChartId, currency: string | null) => (v: number) =>
  percent(chart)
    ? v.toLocaleString('en', { maximumFractionDigits: 2 }) + '%'
    : unitCount(chart)
      ? v.toLocaleString('en') + ' units'
      : reportMoney(v, currency);
const isDaily = (chart: ChartId) =>
  ['salesDay', 'returnsDay', 'returnRate', 'profitDay', 'marginDay'].includes(chart);
const caption: Record<ChartId, string> = {
  salesDay: 'Completed sales after discounts',
  salesHour: 'Sales by the local hour of payment',
  salesWeekday: 'Sales by business weekday',
  salesPayment: 'Amounts received by payment method',
  salesCashier: 'Sales by the person who completed payment',
  salesCategory: 'Sales by product category',
  returnsDay: 'Refunds paid alongside completed sales',
  returnRate: 'Refunds as a share of sales',
  returnMedicine: 'Medicines with the most units returned',
  physicalReason: 'Units returned by the recorded reason',
  returnReason: 'Refund amounts by recorded reason',
  profitDay: 'Gross profit from posted sales and returns',
  marginDay: 'Posted gross profit as a share of net revenue',
  profitCategory: 'Gross profit by product category',
  topMargin: 'Highest gross margin percentages on posted transactions',
  bottomMargin: 'Lowest gross margin percentages on posted transactions',
};
const rangeLabel = (p: ReportPeriod) => (p.from === p.to ? p.from : p.from + ' to ' + p.to);
function total(rows: ChartRow[] | undefined, chart: ChartId) {
  if (!rows) return null;
  if (!rows.length && !isProfit(chart) && !percent(chart)) return 0;
  if (!rows.some((row) => row.value !== null)) return null;
  return chartValue(
    chart,
    rows.reduce((n, r) => n + r.amount, 0),
    rows.reduce((n, r) => n + r.base, 0)
  );
}
function useChart(chart: ChartId, filters: Filters, previous = false, enabled = true) {
  return trpc.pharmacyReports.visualChart.useQuery(
    { ...filters, chart, previous },
    { enabled, retry: false }
  );
}
function ChangeStat({
  label,
  value,
  prior,
  compare,
  format,
  percentage = false,
}: {
  percentage?: boolean;
  label: string;
  value: number | null;
  prior: number | null;
  compare: boolean;
  format: (n: number) => string;
}) {
  const delta = value !== null && prior !== null ? value - prior : null;
  return (
    <Stat
      label={label}
      value={value === null ? '—' : format(value)}
      valueClassName="break-words text-2xl"
      deltaDirection={delta === null || delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down'}
      delta={
        compare
          ? delta === null
            ? 'Comparison unavailable'
            : delta === 0
              ? 'No change'
              : (delta > 0 ? 'Up ' : 'Down ') +
                (percentage
                  ? Math.abs(delta).toLocaleString('en', { maximumFractionDigits: 2 }) +
                    ' percentage points'
                  : format(Math.abs(delta)))
          : undefined
      }
    />
  );
}
function PaymentStat({
  filters,
  compare,
  currency,
}: {
  filters: Filters;
  compare: boolean;
  currency: string | null;
}) {
  const current = useChart('salesPayment', filters),
    prior = useChart('salesPayment', filters, true, compare);
  return (
    <ChangeStat
      label="Payments received"
      value={total(current.data?.rows, 'salesPayment')}
      prior={total(prior.data?.rows, 'salesPayment')}
      compare={compare}
      format={formatter('salesPayment', currency)}
    />
  );
}
function ChartPanel({
  chart,
  filters,
  compare,
  currency,
  main,
  select,
}: {
  chart: ChartId;
  filters: Filters;
  compare: boolean;
  currency: string | null;
  main: boolean;
  select: (v: Drill) => void;
}) {
  const current = useChart(chart, filters),
    prior = useChart(chart, filters, true, compare && main);
  const currencies = current.data?.postedCurrencies ?? [];
  const priorCurrencies = prior.data?.postedCurrencies ?? [];
  const differentCurrency =
    priorCurrencies.length > 1 ||
    (currencies.length === 1 &&
      priorCurrencies.length === 1 &&
      currencies[0] !== priorCurrencies[0]);
  const comparisonData = differentCurrency ? undefined : prior.data;
  if (currencies.length > 1)
    return (
      <SectionCard title={CHARTS[chart]}>
        <p role="status">
          This period contains postings in {currencies.join(' and ')}. Choose a branch or period
          with one currency to see profit.
        </p>
      </SectionCard>
    );
  const format = formatter(chart, currencies[0] ?? currency),
    rows = current.data?.rows ?? [],
    before = comparisonData?.rows ?? [];
  const period = current.data?.period;
  const previousRows = new Map(before.map((row) => [row.key, row]));
  const points: BusinessChartPoint[] = [];
  if (main && period && isDaily(chart) && (rows.length || before.length)) {
    const currentRows = new Map(rows.map((r) => [r.key, r]));
    for (let date = period.from, i = 0; date <= period.to; date = shiftPharmacyDay(date, 1), i++) {
      const row = currentRows.get(date);
      const previous = comparisonData
        ? previousRows.get(shiftPharmacyDay(comparisonData.period.from, i))
        : null;
      points.push({
        key: date,
        label: date,
        value: row?.value ?? (isProfit(chart) ? null : 0),
        previous: previous?.value ?? (comparisonData && !isProfit(chart) ? 0 : null),
        previousKey: comparisonData ? shiftPharmacyDay(comparisonData.period.from, i) : undefined,
        secondary: row?.base ?? 0,
      });
    }
  } else
    for (const row of rows)
      points.push({ key: row.key, label: row.label, value: row.value, secondary: row.base });
  const excluded = current.data?.excludedLines ?? 0;
  return (
    <SectionCard
      title={CHARTS[chart]}
      className={main ? 'min-w-0' : 'min-w-0 h-full'}
      compact={!main}
    >
      {!current.data ? (
        current.isError ? (
          <p role="alert">
            This chart could not be loaded.{' '}
            <Button variant="outline" onClick={() => current.refetch()}>
              Try again
            </Button>
          </p>
        ) : (
          <p aria-busy="true" className="min-h-56 text-sm text-text-muted">
            Loading {CHARTS[chart].toLowerCase()}…
          </p>
        )
      ) : (
        <>
          <p className="mb-4 text-sm text-text-muted">
            {caption[chart]} · {rangeLabel(current.data.period)}.
          </p>
          {main && (
            <div className="mb-6 grid gap-4 sm:grid-cols-2">
              <ChangeStat
                label={
                  chart === 'salesDay'
                    ? 'Total sales'
                    : chart === 'returnsDay'
                      ? 'Total refunds'
                      : 'Gross profit'
                }
                value={total(rows, chart)}
                prior={total(comparisonData?.rows, chart)}
                compare={compare}
                format={format}
              />
              {chart === 'salesDay' ? (
                <PaymentStat filters={filters} compare={compare} currency={currency} />
              ) : (
                <ChangeStat
                  percentage
                  label={chart === 'returnsDay' ? 'Return rate' : 'Gross margin'}
                  value={total(rows, chart === 'returnsDay' ? 'returnRate' : 'marginDay')}
                  prior={total(
                    comparisonData?.rows,
                    chart === 'returnsDay' ? 'returnRate' : 'marginDay'
                  )}
                  compare={compare}
                  format={formatter('returnRate', currency)}
                />
              )}
            </div>
          )}
          {isProfit(chart) && (
            <p role="note" className="mb-3 text-sm text-text-muted">
              {excluded} {excluded === 1 ? 'line' : 'lines'} excluded because the sale or return has
              no ledger posting.
            </p>
          )}
          {compare && main && differentCurrency && (
            <p className="text-sm text-text-muted">
              The two periods have different posted currencies. A monetary comparison is
              unavailable.
            </p>
          )}
          {compare && main && prior.isError && (
            <p role="status">
              The previous period could not be loaded.{' '}
              <Button variant="ghost" onClick={() => prior.refetch()}>
                Retry comparison
              </Button>
            </p>
          )}
          <BusinessChart
            title={CHARTS[chart]}
            points={points}
            empty="No matching activity. Try a different branch or a wider period."
            format={format}
            line={isDaily(chart)}
            comparison={compare && main && !!comparisonData}
            secondaryLabel={chart === 'returnsDay' ? 'Completed sales' : undefined}
            unitScale={percent(chart) || unitCount(chart) ? 1 : 100}
            onSelectPrevious={
              compare && main
                ? (p) => {
                    if (p.previousKey)
                      select({
                        chart,
                        key: p.previousKey,
                        label: p.previousKey + ' (previous period)',
                        previous: true,
                      });
                  }
                : undefined
            }
            onSelect={(p) => select({ chart, key: p.key!, label: p.label })}
          />
          {main && compare && comparisonData && (
            <p className="mt-2 text-xs text-text-muted">
              Previous period · {rangeLabel(comparisonData.period)}
            </p>
          )}
        </>
      )}
    </SectionCard>
  );
}
function DetailPanel({
  selection,
  filters,
  currency,
  close,
}: {
  selection: Drill;
  filters: Filters;
  currency: string | null;
  close: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const q = trpc.pharmacyReports.visualChart.useQuery(
    {
      ...filters,
      chart: selection.chart,
      bucket: selection.key,
      previous: selection.previous,
      offset,
    },
    { retry: false }
  );
  const postedCurrency = q.data?.postedCurrencies?.[0] ?? currency;
  const amount = (v: number) =>
    unitCount(selection.chart) ? v + ' units' : reportMoney(v, postedCurrency);
  return (
    <SectionCard
      title={CHARTS[selection.chart] + ' · ' + selection.label}
      actions={
        <Button variant="outline" onClick={close}>
          Close details
        </Button>
      }
    >
      {!q.data ? (
        <p role="status">{q.isError ? 'The records could not be loaded.' : 'Loading records…'}</p>
      ) : (
        <>
          <p className="text-sm text-text-muted">Records for {rangeLabel(q.data.period)}</p>
          <ul className="divide-y divide-border-subtle">
            {q.data.rows.map((row) => (
              <li className="flex flex-wrap justify-between gap-2 py-2" key={row.key}>
                <span>{row.label}</span>
                <span className="tabular-nums">
                  {row.excluded ? 'Excluded' : amount(row.amount)}
                  {(selection.chart === 'returnsDay' ||
                    selection.chart === 'returnRate' ||
                    isProfit(selection.chart)) &&
                  row.base !== 0
                    ? ' · Sales ' + reportMoney(row.base, postedCurrency)
                    : ''}
                </span>
              </li>
            ))}
          </ul>
          {!q.data.rows.length && <p>No matching records for this group.</p>}
          {(offset > 0 || q.data.more) && (
            <div className="flex gap-2">
              <Button variant="outline" disabled={!offset} onClick={() => setOffset(offset - 50)}>
                Previous records
              </Button>
              <Button
                variant="outline"
                disabled={!q.data.more}
                onClick={() => setOffset(offset + 50)}
              >
                Next records
              </Button>
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}
function Figures({
  chart,
  filters,
  currency,
  branchLabel,
  select,
}: {
  chart: ChartId;
  filters: Filters;
  currency: string | null;
  branchLabel: string;
  select: (v: Drill) => void;
}) {
  const q = useChart(chart, filters);
  if (!q.data)
    return <p role="status">{q.isError ? 'Figures could not be loaded.' : 'Loading figures…'}</p>;
  const currencies = q.data.postedCurrencies ?? [];
  if (currencies.length > 1)
    return (
      <p role="status">Choose one posted currency before viewing or exporting profit figures.</p>
    );
  const postedCurrency = currencies[0] ?? currency;
  return (
    <VisualReportTable
      rows={q.data.rows}
      unit={percent(chart) ? 'percent' : unitCount(chart) ? 'units' : 'money'}
      currency={postedCurrency}
      title={CHARTS[chart]}
      scope={branchLabel + ' · ' + rangeLabel(q.data.period)}
      format={formatter(chart, postedCurrency)}
      extra={
        isProfit(chart) || chart === 'returnsDay' || chart === 'returnRate'
          ? {
              label: isProfit(chart) ? 'Net revenue' : 'Sales',
              format: (r) => reportMoney(r.base, postedCurrency),
            }
          : undefined
      }
      select={(row) => select({ chart, key: row.key, label: row.label })}
    />
  );
}
export function VisualReports({
  branches,
  initialBranch,
  initialPeriod,
  today,
  currency,
  initialReport,
}: {
  branches: { id: string; name: string }[];
  initialBranch?: string;
  initialPeriod?: ReportPeriod;
  today: string;
  currency: string | null;
  initialReport: ReportName;
}) {
  const [report, setReport] = useState(initialReport),
    [branch, setBranch] = useState(initialBranch ?? ''),
    [preset, setPreset] = useState<ReportPreset>(initialPeriod ? 'custom' : 'month');
  const [custom, setCustom] = useState(initialPeriod ?? reportPeriod('month', today)),
    [compare, setCompare] = useState(true);
  const [selection, setSelection] = useState<Drill | null>(null),
    [table, setTable] = useState<ChartId>(REPORT_CHARTS[report][0]);
  const filters = {
    preset,
    ...(preset === 'custom' ? { custom } : {}),
    ...(branch ? { branchId: branch } : {}),
  };
  let error = '';
  try {
    reportPeriod(preset, today, custom);
  } catch (e) {
    error = (e as Error).message;
  }
  const charts = REPORT_CHARTS[report];
  const origin = useRef<HTMLElement | null>(null);
  function closeDetails() {
    setSelection(null);
    requestAnimationFrame(() => origin.current?.focus());
  }
  function select(row: Drill) {
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelection(row);
    requestAnimationFrame(() => document.getElementById('visual-report-details')?.focus());
  }
  const branchLabel = branches.find((b) => b.id === branch)?.name ?? 'All available branches';
  return (
    <div className="min-w-0 space-y-5" data-report-print>
      <div className="space-y-4 print:hidden">
        <nav aria-label="Visual reports" className="flex flex-wrap gap-2">
          {(['Sales', 'Returns', 'Profit'] as const).map((name) => (
            <Button
              key={name}
              variant={report === name ? 'default' : 'outline'}
              aria-pressed={report === name}
              onClick={() => {
                setReport(name);
                setSelection(null);
                setTable(REPORT_CHARTS[name][0]);
              }}
            >
              {name}
            </Button>
          ))}
        </nav>
        <div className="flex flex-wrap items-end gap-4">
          <label className="min-w-36 text-sm font-medium">
            Period
            <SelectField
              value={preset}
              onChange={(e) => {
                setPreset(e.target.value as ReportPreset);
                setSelection(null);
              }}
            >
              {Object.entries(REPORT_PRESETS).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </SelectField>
          </label>
          <label className="min-w-40 text-sm font-medium">
            Branch
            <SelectField
              value={branch}
              onChange={(e) => {
                setBranch(e.target.value);
                setSelection(null);
              }}
            >
              <option value="">All available branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SelectField>
          </label>
          {preset === 'custom' &&
            (['from', 'to'] as const).map((key) => (
              <label key={key} className="text-sm">
                {key === 'from' ? 'From' : 'To'}
                <Input
                  type="date"
                  value={custom[key]}
                  onChange={(e) => {
                    setCustom({ ...custom, [key]: e.target.value });
                    setSelection(null);
                  }}
                />
              </label>
            ))}
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <Switch checked={compare} onCheckedChange={setCompare} />
            Compare with previous period
          </label>
        </div>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <div className="space-y-5 print:hidden">
            <ChartPanel
              chart={charts[0]}
              filters={filters}
              compare={compare}
              currency={currency}
              main
              select={select}
            />
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              {charts.slice(1).map((chart) => (
                <ChartPanel
                  key={chart}
                  chart={chart}
                  filters={filters}
                  compare={false}
                  currency={currency}
                  main={false}
                  select={select}
                />
              ))}
            </div>
          </div>
          {selection && (
            <div
              id="visual-report-details"
              onKeyDown={(e) => {
                if (e.key === 'Escape') closeDetails();
              }}
              tabIndex={-1}
              className="print:hidden"
            >
              <DetailPanel
                key={selection.chart + selection.key}
                selection={selection}
                filters={filters}
                currency={currency}
                close={closeDetails}
              />
            </div>
          )}
          <label className="block max-w-sm text-sm font-medium print:hidden">
            Figures to show
            <SelectField value={table} onChange={(e) => setTable(e.target.value as ChartId)}>
              {charts.map((id) => (
                <option key={id} value={id}>
                  {CHARTS[id]}
                </option>
              ))}
            </SelectField>
          </label>
          <Figures
            key={table}
            chart={table}
            filters={filters}
            branchLabel={branchLabel}
            currency={currency}
            select={select}
          />
        </>
      )}
    </div>
  );
}
