'use client';

import { businessDateToUtcDate, resolveBusinessDate } from '@/lib/restaurant/business-date';
import { workspaceTimezone } from '@/lib/timezone';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, RotateCcw, Save } from 'lucide-react';

import { RestaurantBranchSelect } from '@/components/restaurant/restaurant-branch-select';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type DashboardPreference = RouterOutputs['restaurantDashboard']['getPreferences'];
type WidgetPreference = DashboardPreference['widgets'][number];
type FinancialRow = RouterOutputs['restaurantInsights']['listFinancialReports'][number];
type OperationalRow = RouterOutputs['restaurantInsights']['listOperationalReports'][number];
type OperationalDetail = NonNullable<RouterOutputs['restaurantInsights']['readOperationalReport']>;
type LabourRow = RouterOutputs['restaurantInsights']['listLabourCosts'][number];
type ReadQuery = {
  error: unknown;
  isLoading: boolean;
  refetch: () => unknown;
};

const CLIENT_DEFAULT: DashboardPreference = {
  version: 1,
  defaultBranchId: null,
  rangeDays: 7,
  widgets: [
    { key: 'performance', visible: true, span: 'wide' },
    { key: 'trend', visible: true, span: 'wide' },
    { key: 'exceptions', visible: true, span: 'compact' },
    { key: 'itemMix', visible: true, span: 'compact' },
    { key: 'labour', visible: true, span: 'wide' },
  ],
};

const WIDGET_LABELS: Record<WidgetPreference['key'], string> = {
  performance: 'Performance summary',
  trend: 'Daily trend',
  exceptions: 'Exceptions',
  itemMix: 'Latest item mix',
  labour: 'Labour',
};

const controlClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

function cloneDefault(): DashboardPreference {
  return { ...CLIENT_DEFAULT, widgets: CLIENT_DEFAULT.widgets.map((widget) => ({ ...widget })) };
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function closedDateRange(
  days: 7 | 30,
  now = new Date(),
  timeZone?: string | null,
  cutoff?: string
) {
  const to = businessDateToUtcDate(resolveBusinessDate(now, workspaceTimezone(timeZone), cutoff));
  to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: dateString(from), to: dateString(to) };
}

function isDenied(error: unknown): boolean {
  const code = (error as { data?: { code?: string } | null } | null)?.data?.code;
  return code === 'FORBIDDEN' || code === 'UNAUTHORIZED';
}

function decimal(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDecimal(value: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-dashed border-border-default px-5 py-8 text-center">
      <p className="font-medium text-text-strong">{title}</p>
      <p className="mt-1 text-sm text-text-body">{detail}</p>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-4 w-full max-w-sm" />
    </div>
  );
}

function ErrorState({
  denied,
  retry,
  subject,
}: {
  denied: boolean;
  retry: () => unknown;
  subject: string;
}) {
  return (
    <div
      role={denied ? 'status' : 'alert'}
      aria-label={`${subject} ${denied ? 'restricted' : 'unavailable'}`}
      className="space-y-3"
    >
      <StatusPill
        status={denied ? 'Restricted' : 'Unavailable'}
        tone="warning"
        className="text-text-body [&>span]:bg-warning"
      />
      <p className="text-sm text-text-body">
        {denied
          ? `${subject} require the existing financial-report permission. No cached figures are shown.`
          : `${subject} could not be loaded. No cached figures are shown. Other dashboard tools remain available.`}
      </p>
      {!denied ? (
        <Button type="button" variant="outline" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function FinancialState({
  query,
  rows,
  children,
}: {
  query: ReadQuery;
  rows: FinancialRow[];
  children: ReactNode;
}) {
  if (query.isLoading) return <LoadingState label="Loading reconciled rollups" />;
  if (query.error) {
    return (
      <ErrorState
        denied={isDenied(query.error)}
        retry={() => void query.refetch()}
        subject="Financial analytics"
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No closed-day rollups"
        detail="No reconciled daily close exists for this branch and date range. Numeric zero is shown only when a rollup records zero."
      />
    );
  }
  return children;
}

function WidgetFrame({
  preference,
  children,
}: {
  preference: WidgetPreference;
  children: ReactNode;
}) {
  return (
    <section
      data-widget={preference.key}
      data-span={preference.span}
      className={cn('min-w-0', preference.span === 'wide' && 'lg:col-span-2')}
    >
      {children}
    </section>
  );
}

function PerformanceWidget({
  financialRows,
  financialQuery,
  operationalRows,
  operationalQuery,
}: {
  financialRows: FinancialRow[];
  financialQuery: ReadQuery;
  operationalRows: OperationalRow[];
  operationalQuery: ReadQuery;
}) {
  const financialTotals = useMemo(
    () =>
      financialRows.reduce(
        (result, row) => ({
          netSales: result.netSales + decimal(row.netSales),
          orders: result.orders + row.orderCount,
        }),
        { netSales: 0, orders: 0 }
      ),
    [financialRows]
  );
  const operationalTotals = useMemo(
    () =>
      operationalRows.reduce(
        (result, row) => ({
          orders: result.orders + row.orderCount,
          covers: result.covers + row.coverCount,
        }),
        { orders: 0, covers: 0 }
      ),
    [operationalRows]
  );
  const averageCheck =
    financialTotals.orders > 0
      ? formatDecimal(financialTotals.netSales / financialTotals.orders)
      : '—';

  return (
    <SectionCard eyebrow="Management overview" title="Performance" titleLevel={2}>
      {financialQuery.isLoading || operationalQuery.isLoading ? (
        <LoadingState label="Loading reconciled performance rollups" />
      ) : financialRows.length === 0 &&
        operationalRows.length === 0 &&
        !financialQuery.error &&
        !operationalQuery.error ? (
        <EmptyState
          title="No closed-day rollups"
          detail="No reconciled daily close exists for this branch and date range. Numeric zero is shown only when a rollup records zero."
        />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {financialQuery.error ? (
            <ErrorState
              denied={isDenied(financialQuery.error)}
              retry={() => void financialQuery.refetch()}
              subject="Financial analytics"
            />
          ) : (
            <Stat
              label="Net sales"
              value={financialRows.length ? formatDecimal(financialTotals.netSales) : 'No data'}
              sub={financialRows.length ? 'Closed days' : undefined}
            />
          )}
          <Stat
            label="Orders"
            value={operationalRows.length ? operationalTotals.orders.toLocaleString() : 'No data'}
            sub={operationalRows.length ? 'Closed days' : undefined}
          />
          <Stat
            label="Covers"
            value={operationalRows.length ? operationalTotals.covers.toLocaleString() : 'No data'}
            sub={operationalRows.length ? 'Closed days' : undefined}
          />
          <Stat
            label="Average check"
            value={financialRows.length ? averageCheck : 'No data'}
            sub={financialRows.length ? 'Net sales ÷ orders' : undefined}
          />
        </div>
      )}
    </SectionCard>
  );
}

function TrendWidget({
  financialRows,
  financialQuery,
  operationalRows,
  operationalQuery,
}: {
  financialRows: FinancialRow[];
  financialQuery: ReadQuery;
  operationalRows: OperationalRow[];
  operationalQuery: ReadQuery;
}) {
  const chronological = [...operationalRows].reverse();
  const salesByDate = new Map(
    financialRows.map((row) => [row.businessDate, decimal(row.netSales)])
  );
  const maximum = Math.max(...financialRows.map((row) => Math.abs(decimal(row.netSales))), 1);
  return (
    <SectionCard eyebrow="Daily rollups" title="Net sales and orders" titleLevel={2}>
      {operationalQuery.isLoading || financialQuery.isLoading ? (
        <LoadingState label="Loading daily net sales and orders trend" />
      ) : operationalQuery.error ? (
        <ErrorState
          denied={isDenied(operationalQuery.error)}
          retry={() => void operationalQuery.refetch()}
          subject="Operational trend"
        />
      ) : chronological.length === 0 ? (
        <EmptyState
          title="No closed-day rollups"
          detail="No reconciled daily trend exists for this branch and date range."
        />
      ) : (
        <ol aria-label="Daily net sales and orders trend" className="space-y-3">
          {chronological.map((row) => {
            const netSales = financialQuery.error ? undefined : salesByDate.get(row.businessDate);
            return (
              <li
                key={row.id}
                className="grid grid-cols-[6rem_1fr_auto] items-center gap-3 text-sm"
              >
                <span className="font-mono text-xs text-text-body">
                  {row.businessDate.slice(5)}
                </span>
                <span className="h-2 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
                  {netSales == null ? null : (
                    <span
                      className="block h-full rounded-full bg-accent-brand"
                      style={{
                        width: `${Math.max((Math.abs(netSales) / maximum) * 100, 2)}%`,
                      }}
                    />
                  )}
                </span>
                <span className="min-w-28 text-right font-mono text-xs tabular-nums text-text-body">
                  {netSales == null ? 'Restricted' : formatDecimal(netSales)} · {row.orderCount}{' '}
                  orders
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}

function ExceptionsWidget({ rows, query }: { rows: FinancialRow[]; query: ReadQuery }) {
  const totals = useMemo(
    () =>
      rows.reduce(
        (result, row) => ({
          comps: result.comps + decimal(row.compTotal),
          refunds: result.refunds + decimal(row.refundTotal),
          voids: result.voids + decimal(row.voidTotal),
          variance: result.variance + decimal(row.drawerVariance),
        }),
        { comps: 0, refunds: 0, voids: 0, variance: 0 }
      ),
    [rows]
  );
  return (
    <SectionCard eyebrow="Controls" title="Exceptions" titleLevel={2}>
      <FinancialState query={query} rows={rows}>
        <dl className="divide-y divide-border-subtle">
          {[
            ['Comps', totals.comps],
            ['Refunds', totals.refunds],
            ['Voids', totals.voids],
            ['Drawer variance', totals.variance],
          ].map(([label, value]) => (
            <div
              key={String(label)}
              className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
            >
              <dt className="text-sm text-text-body">{label}</dt>
              <dd className="font-mono text-sm font-semibold tabular-nums text-text-strong">
                {formatDecimal(Number(value))}
              </dd>
            </div>
          ))}
        </dl>
      </FinancialState>
    </SectionCard>
  );
}

function ItemMixWidget({
  rows,
  query,
  detail,
}: {
  rows: OperationalRow[];
  query: ReadQuery;
  detail: {
    data: OperationalDetail | undefined;
    error: unknown;
    isLoading: boolean;
    refetch: () => unknown;
  };
}) {
  return (
    <SectionCard eyebrow="Latest closed day" title="Item mix" titleLevel={2}>
      {query.isLoading ? (
        <LoadingState label="Loading latest closed-day rollup" />
      ) : query.error ? (
        <ErrorState
          denied={isDenied(query.error)}
          retry={() => void query.refetch()}
          subject="Operational item mix"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No closed-day rollups"
          detail="No operational rollup is available for item mix."
        />
      ) : detail.isLoading ? (
        <LoadingState label="Loading latest item mix" />
      ) : detail.error ? (
        <ErrorState
          denied={isDenied(detail.error)}
          retry={() => void detail.refetch()}
          subject="Latest item mix"
        />
      ) : detail.data?.itemMix.length ? (
        <div>
          <p className="mb-3 font-mono text-xs text-text-body">
            Business date {detail.data.businessDate}
          </p>
          <ol className="divide-y divide-border-subtle">
            {detail.data.itemMix.slice(0, 5).map((item) => (
              <li
                key={item.productId}
                className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
              >
                <span className="min-w-0 truncate text-sm font-medium text-text-strong">
                  {item.productName}
                </span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-text-body">
                  {item.quantity} sold
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <EmptyState
          title="No item mix"
          detail="The latest closed-day rollup contains no non-voided item snapshots."
        />
      )}
    </SectionCard>
  );
}

function LabourWidget({ rows, query }: { rows: LabourRow[]; query: ReadQuery }) {
  const totals = rows.reduce(
    (result, row) => ({
      hours: result.hours + decimal(row.labourHours),
      cost: result.cost + decimal(row.labourCost),
    }),
    { hours: 0, cost: 0 }
  );
  return (
    <SectionCard eyebrow="Restricted rollup" title="Imported labour" titleLevel={2}>
      {query.isLoading ? (
        <LoadingState label="Loading restricted labour rollups" />
      ) : query.error ? (
        <ErrorState denied={false} retry={() => void query.refetch()} subject="Labour analytics" />
      ) : rows.length ? (
        <div className="grid gap-5 sm:grid-cols-2">
          <Stat label="Labour hours" value={formatDecimal(totals.hours)} sub="Imported facts" />
          <Stat label="Labour cost" value={formatDecimal(totals.cost)} sub="Imported facts" />
        </div>
      ) : (
        <EmptyState
          title="No labour facts"
          detail="You have access, but no imported labour fact matches this branch and range."
        />
      )}
    </SectionCard>
  );
}

function LayoutEditor({
  widgets,
  onChange,
  labourDenied,
}: {
  widgets: WidgetPreference[];
  onChange: (widgets: WidgetPreference[]) => void;
  labourDenied: boolean;
}) {
  const update = (index: number, replacement: WidgetPreference) =>
    onChange(widgets.map((widget, widgetIndex) => (widgetIndex === index ? replacement : widget)));
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= widgets.length) return;
    const next = [...widgets];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  return (
    <SectionCard eyebrow="Edit mode" title="Widget layout" titleLevel={2}>
      <ul className="divide-y divide-border-subtle">
        {widgets.map((widget, index) =>
          widget.key === 'labour' && labourDenied ? null : (
            <li
              key={widget.key}
              className="flex flex-wrap items-center gap-2 py-3 first:pt-0 last:pb-0"
            >
              <span className="mr-auto min-w-40 text-sm font-medium text-text-strong">
                {WIDGET_LABELS[widget.key]}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`${widget.visible ? 'Hide' : 'Show'} ${WIDGET_LABELS[widget.key]}`}
                onClick={() => update(index, { ...widget, visible: !widget.visible })}
              >
                {widget.visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                {widget.visible ? 'Hide' : 'Show'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Use ${widget.span === 'wide' ? 'compact' : 'wide'} span for ${WIDGET_LABELS[widget.key]}`}
                onClick={() =>
                  update(index, { ...widget, span: widget.span === 'wide' ? 'compact' : 'wide' })
                }
              >
                {widget.span === 'wide' ? 'Wide' : 'Compact'}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={`Move ${WIDGET_LABELS[widget.key]} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp aria-hidden />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={`Move ${WIDGET_LABELS[widget.key]} down`}
                disabled={index === widgets.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown aria-hidden />
              </Button>
            </li>
          )
        )}
      </ul>
    </SectionCard>
  );
}

export function RestaurantManagementOverview({ insightsEnabled }: { insightsEnabled: boolean }) {
  const utils = trpc.useUtils();
  const preferencesQuery = trpc.restaurantDashboard.getPreferences.useQuery();
  const updatePreferences = trpc.restaurantDashboard.updatePreferences.useMutation();
  const branchesQuery = trpc.restaurantStaff.listBranches.useQuery(undefined, {
    enabled: insightsEnabled,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DashboardPreference>(cloneDefault);
  const draftRef = useRef(draft);
  const [branchOverride, setBranchOverride] = useState<string | null>(null);
  const [rangeOverride, setRangeOverride] = useState<7 | 30 | null>(null);
  const activeBranches = (branchesQuery.data ?? []).filter((branch) => branch.active);
  const storedBranch = activeBranches.find(
    (branch) => branch.id === preferencesQuery.data?.defaultBranchId
  );
  const fallbackBranch = activeBranches.find((branch) => branch.isDefault) ?? activeBranches[0];
  const selectedBranchId = activeBranches.some((branch) => branch.id === branchOverride)
    ? (branchOverride ?? '')
    : ((storedBranch ?? fallbackBranch)?.id ?? '');
  const rangeDays = rangeOverride ?? preferencesQuery.data?.rangeDays ?? 7;

  const selectedBranch = activeBranches.find((branch) => branch.id === selectedBranchId);
  const range = closedDateRange(
    rangeDays,
    new Date(),
    selectedBranch?.timezone,
    selectedBranch?.businessDayCutoff
  );
  const branchReady = insightsEnabled && selectedBranchId.length > 0;
  const rangeInput = {
    branchId: selectedBranchId,
    from: range.from,
    to: range.to,
    limit: rangeDays,
  };
  const financialQuery = trpc.restaurantInsights.listFinancialReports.useQuery(rangeInput, {
    enabled: branchReady,
    retry: false,
  });
  const financialRows = financialQuery.error ? [] : (financialQuery.data ?? []);
  const operationalQuery = trpc.restaurantInsights.listOperationalReports.useQuery(rangeInput, {
    enabled: branchReady,
    retry: false,
  });
  const operationalRows = operationalQuery.error ? [] : (operationalQuery.data ?? []);
  const latestDate = operationalRows[0]?.businessDate ?? '';
  const detailQuery = trpc.restaurantInsights.readOperationalReport.useQuery(
    { branchId: selectedBranchId, businessDate: latestDate },
    { enabled: branchReady && latestDate.length > 0 && !operationalQuery.error, retry: false }
  );
  const labourQuery = trpc.restaurantInsights.listLabourCosts.useQuery(rangeInput, {
    enabled: branchReady,
    retry: false,
  });
  const labourRows = labourQuery.error ? [] : (labourQuery.data ?? []);
  const layout = editing ? draft : (preferencesQuery.data ?? CLIENT_DEFAULT);
  const freshness = [...financialRows, ...operationalRows].some(
    (row) => row.freshness.status === 'STALE'
  )
    ? 'STALE'
    : financialRows.length || operationalRows.length
      ? 'CURRENT'
      : null;

  const beginEditing = () => {
    const current = preferencesQuery.data ?? CLIENT_DEFAULT;
    const next = {
      ...current,
      defaultBranchId: selectedBranchId || current.defaultBranchId,
      rangeDays,
      widgets: current.widgets.map((widget) => ({ ...widget })),
    };
    draftRef.current = next;
    setDraft(next);
    setEditing(true);
  };

  const save = async () => {
    const next = draftRef.current;
    const saved = await updatePreferences.mutateAsync(next);
    utils.restaurantDashboard.getPreferences.setData(undefined, saved);
    setEditing(false);
  };

  const restoreDefault = () => {
    const next = cloneDefault();
    draftRef.current = next;
    setDraft(next);
    setRangeOverride(next.rangeDays);
    setBranchOverride(null);
  };

  if (!insightsEnabled) {
    return (
      <SectionCard
        eyebrow="Management overview"
        title="Analytics module not enabled"
        titleLevel={2}
        className="[&_[data-slot=eyebrow]]:text-text-body"
      >
        <div className="space-y-3" role="status">
          <StatusPill
            status="Disabled"
            tone="warning"
            className="text-text-body [&>span]:bg-warning"
          />
          <p className="max-w-2xl text-sm leading-6 text-text-body">
            Reconciled closed-day analytics require Restaurant Insights. Quick access remains
            available for every enabled operational module.
          </p>
        </div>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-5 [&_[data-slot=eyebrow]]:text-text-body">
      <SectionCard
        eyebrow="Reconciled closed-day rollups"
        title="Management overview"
        titleLevel={2}
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            {freshness ? (
              <StatusPill
                status={freshness === 'STALE' ? 'Stale rollups' : 'Current rollups'}
                tone={freshness === 'STALE' ? 'warning' : 'success'}
                className={freshness === 'STALE' ? 'text-text-body [&>span]:bg-warning' : undefined}
              />
            ) : null}
            {!editing ? (
              <Button type="button" variant="outline" onClick={beginEditing}>
                <Pencil aria-hidden />
                Edit dashboard
              </Button>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={restoreDefault}>
                  <RotateCcw aria-hidden />
                  Restore default
                </Button>
                <Button
                  type="button"
                  onClick={() => void save()}
                  disabled={updatePreferences.isPending}
                >
                  <Save aria-hidden />
                  {updatePreferences.isPending ? 'Saving…' : 'Save dashboard'}
                </Button>
              </>
            )}
          </div>
        }
      >
        <p className="mb-5 max-w-3xl text-sm leading-6 text-text-body">
          Figures come only from reconciled business-day closes. They are not current-shift or live
          service data.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1.5">
            <span className="eyebrow">{editing ? 'Saved default branch' : 'Branch'}</span>
            <RestaurantBranchSelect
              branches={branchesQuery.data ?? []}
              loading={branchesQuery.isLoading}
              error={Boolean(branchesQuery.error)}
              value={selectedBranchId}
              onChange={(value) => {
                setBranchOverride(value);
                if (editing) {
                  const next = { ...draftRef.current, defaultBranchId: value };
                  draftRef.current = next;
                  setDraft(next);
                }
              }}
              ariaLabel={editing ? 'Saved default branch' : 'Branch'}
            />
          </label>
          <label className="space-y-1.5">
            <span className="eyebrow">{editing ? 'Saved date range' : 'Closed-date range'}</span>
            <select
              className={controlClass}
              aria-label={editing ? 'Saved date range' : 'Closed-date range'}
              value={rangeDays}
              onChange={(event) => {
                const next = Number(event.target.value) as 7 | 30;
                setRangeOverride(next);
                if (editing) {
                  const nextDraft = { ...draftRef.current, rangeDays: next };
                  draftRef.current = nextDraft;
                  setDraft(nextDraft);
                }
              }}
            >
              <option value={7}>Last 7 dates</option>
              <option value={30}>Last 30 dates</option>
            </select>
          </label>
        </div>
        <p className="mt-3 font-mono text-xs text-text-body">
          Inclusive range {range.from} — {range.to}
        </p>
        {updatePreferences.error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            Dashboard settings were not saved. Your previous layout is unchanged.
          </p>
        ) : null}
      </SectionCard>

      {editing ? (
        <LayoutEditor
          widgets={draft.widgets}
          onChange={(widgets) => {
            const next = { ...draftRef.current, widgets };
            draftRef.current = next;
            setDraft(next);
          }}
          labourDenied={isDenied(labourQuery.error)}
        />
      ) : null}

      {!branchReady ? (
        <SectionCard title="Choose an active branch" titleLevel={2}>
          <EmptyState
            title={branchesQuery.error ? 'Branches unavailable' : 'Branch required'}
            detail="Analytics reads stay disabled until an active branch is available."
          />
        </SectionCard>
      ) : (
        <div
          data-testid="restaurant-dashboard-grid"
          className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2"
        >
          {layout.widgets.map((preference) => {
            if (!preference.visible) return null;
            if (preference.key === 'labour' && isDenied(labourQuery.error)) {
              return null;
            }
            const content =
              preference.key === 'performance' ? (
                <PerformanceWidget
                  financialRows={financialRows}
                  financialQuery={financialQuery}
                  operationalRows={operationalRows}
                  operationalQuery={operationalQuery}
                />
              ) : preference.key === 'trend' ? (
                <TrendWidget
                  financialRows={financialRows}
                  financialQuery={financialQuery}
                  operationalRows={operationalRows}
                  operationalQuery={operationalQuery}
                />
              ) : preference.key === 'exceptions' ? (
                <ExceptionsWidget rows={financialRows} query={financialQuery} />
              ) : preference.key === 'itemMix' ? (
                <ItemMixWidget
                  rows={operationalRows}
                  query={operationalQuery}
                  detail={detailQuery}
                />
              ) : (
                <LabourWidget rows={labourRows} query={labourQuery} />
              );
            return (
              <WidgetFrame key={preference.key} preference={preference}>
                {content}
              </WidgetFrame>
            );
          })}
        </div>
      )}
    </div>
  );
}
