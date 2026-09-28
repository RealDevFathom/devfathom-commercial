'use client';

import { useState, type ReactNode } from 'react';
import type { inferRouterOutputs } from '@trpc/server';

import { useEntitlements } from '@/components/entitlements-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';
import { RestaurantBranchSelect } from '../restaurant-branch-select';
import { ContributionScenarios } from './contribution-scenarios';
import { CloseReadinessPanel } from './close-readiness-panel';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type FinancialRow = RouterOutputs['restaurantInsights']['listFinancialReports'][number];
type OperationalRow = RouterOutputs['restaurantInsights']['listOperationalReports'][number];
type ReportRow = FinancialRow | OperationalRow;
type FinancialDetail = NonNullable<RouterOutputs['restaurantInsights']['readFinancialReport']>;
type OperationalDetail = NonNullable<RouterOutputs['restaurantInsights']['readOperationalReport']>;
type ReportDetail = FinancialDetail | OperationalDetail;
type LabourRow = RouterOutputs['restaurantInsights']['listLabourCosts'][number];
type ExportFile = NonNullable<RouterOutputs['restaurantInsights']['exportFinancialReports']>;

type ReportKind = 'financial' | 'operational';
type InsightsTab = ReportKind | 'labour' | 'scenarios' | 'close';
type UiError = { message: string; data?: { code?: string } | null };
type ReadQuery<T> = {
  data: T | undefined;
  error: unknown;
  isLoading: boolean;
  refetch: () => unknown;
};

const labelClass =
  'block font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-text-muted';

function isDenied(error: unknown): boolean {
  const value = error as UiError | null;
  return value?.data?.code === 'FORBIDDEN' || value?.data?.code === 'UNAUTHORIZED';
}

/** A financial row is the money-bearing superset; narrow only when the kind proves it. */
function financialRow(row: ReportRow, kind: ReportKind): FinancialRow | null {
  return kind === 'financial' ? (row as FinancialRow) : null;
}

function financialDetail(detail: ReportDetail, kind: ReportKind): FinancialDetail | null {
  return kind === 'financial' ? (detail as FinancialDetail) : null;
}

function triggerDownload(file: ExportFile): void {
  if (typeof window === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([file.content], { type: file.contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function Field({
  label,
  children,
  description,
}: {
  label: string;
  children: ReactNode;
  description?: string;
}) {
  return (
    <label className="space-y-1.5">
      <span className={labelClass}>{label}</span>
      {children}
      {description ? <span className="block text-xs text-text-muted">{description}</span> : null}
    </label>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-dashed border-border-default px-5 py-10 text-center">
      <p className="font-medium text-text-strong">{title}</p>
      <p className="mt-1 text-sm text-text-muted">{detail}</p>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function ErrorState({
  error,
  retry,
  subject,
}: {
  error: unknown;
  retry: () => void;
  subject: string;
}) {
  const value = error as UiError | null;
  const denied = isDenied(error);
  return (
    <div className="space-y-3 rounded-md border border-border-default p-5" role="alert">
      <StatusPill status={denied ? 'Permission denied' : 'Read failed'} tone="danger" />
      <div>
        <p className="font-medium text-text-strong">
          {denied ? 'Insights access denied' : 'Could not load ' + subject}
        </p>
        <p className="mt-1 text-sm text-text-muted">
          {denied
            ? 'Your role does not grant the capability and branch assignment required for this report.'
            : value?.message || 'The read failed without changing any rollup data.'}
        </p>
      </div>
      {!denied ? (
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function TableFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="max-w-full overflow-x-auto rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&_[data-slot=table-container]]:overflow-visible"
    >
      {children}
    </div>
  );
}

function FreshnessPill({ status }: { status: 'CURRENT' | 'STALE' }) {
  return (
    <StatusPill
      status={status === 'CURRENT' ? 'Current' : 'Stale — rebuild'}
      tone={status === 'CURRENT' ? 'success' : 'warning'}
    />
  );
}

export function InsightsConsole() {
  const entitlements = useEntitlements();
  const insightsModule = entitlements.modules.find(
    (module) => module.key === 'restaurant-insights'
  );
  const insightsEnabled =
    insightsModule?.enabled ?? entitlements.enabledModules.includes('restaurant-insights');
  const branchesQuery = trpc.restaurantStaff.listBranches.useQuery(undefined, {
    enabled: insightsEnabled,
  });

  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tab, setTab] = useState<InsightsTab>('financial');
  const [selectedDate, setSelectedDate] = useState('');
  const [closeBusinessDate, setCloseBusinessDate] = useState('');

  const normalizedBranchId = branchId.trim();
  const branchReady = insightsEnabled && normalizedBranchId.length > 0;
  const financialActive = branchReady && tab === 'financial';
  const operationalActive = branchReady && tab === 'operational';
  const labourActive = branchReady && tab === 'labour';
  const closeBranch = branchesQuery.data?.find(
    (branch) => branch.id === normalizedBranchId && branch.active
  );
  const closeBranchAvailable =
    Boolean(closeBranch) && !branchesQuery.error && !branchesQuery.isLoading;

  const rangeInput = {
    branchId: normalizedBranchId,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: 100,
  };
  const detailInput = { branchId: normalizedBranchId, businessDate: selectedDate };

  const financialList = trpc.restaurantInsights.listFinancialReports.useQuery(rangeInput, {
    enabled: financialActive,
  });
  const operationalList = trpc.restaurantInsights.listOperationalReports.useQuery(rangeInput, {
    enabled: operationalActive,
  });
  const financialDetailQuery = trpc.restaurantInsights.readFinancialReport.useQuery(detailInput, {
    enabled: financialActive && selectedDate.length > 0,
  });
  const operationalDetailQuery = trpc.restaurantInsights.readOperationalReport.useQuery(
    detailInput,
    { enabled: operationalActive && selectedDate.length > 0 }
  );
  const labourList = trpc.restaurantInsights.listLabourCosts.useQuery(rangeInput, {
    enabled: labourActive,
  });

  const resetSelection = () => setSelectedDate('');
  const updateBranch = (value: string) => {
    setBranchId(value);
    resetSelection();
  };
  const updateFrom = (value: string) => {
    setFrom(value);
    resetSelection();
  };
  const updateTo = (value: string) => {
    setTo(value);
    resetSelection();
  };
  const updateTab = (value: string) => {
    setTab(value as InsightsTab);
    resetSelection();
  };

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Restaurant operations"
        heading="Insights"
        description="Read deterministic daily rollups reconciled to the authoritative close chain, then export the exact reports."
      />

      <SectionCard eyebrow="Insight rollups" title="Filters" titleLevel={2}>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Branch" description="Required before any report read runs.">
            <RestaurantBranchSelect
              branches={branchesQuery.data ?? []}
              loading={branchesQuery.isLoading}
              error={Boolean(branchesQuery.error)}
              value={tab === 'close' && !closeBranch ? '' : branchId}
              onChange={updateBranch}
              disabled={!insightsEnabled}
            />
          </Field>
          <Field label="From date" description="Optional inclusive range start.">
            <Input
              aria-label="From date"
              type="date"
              value={from}
              onChange={(event) => updateFrom(event.target.value)}
              className="h-11"
              disabled={!insightsEnabled}
            />
          </Field>
          <Field label="To date" description="Optional inclusive range end.">
            <Input
              aria-label="To date"
              type="date"
              value={to}
              onChange={(event) => updateTo(event.target.value)}
              className="h-11"
              disabled={!insightsEnabled}
            />
          </Field>
        </div>
      </SectionCard>

      {!insightsEnabled ? (
        <SectionCard title="Restaurant Insights module disabled">
          <div className="space-y-3" role="status">
            <StatusPill status="Disabled" tone="warning" />
            <p className="max-w-2xl text-sm text-text-muted">
              Insight reports require the Restaurant Insights entitlement. Filters and reads remain
              disabled until it is granted.
            </p>
          </div>
        </SectionCard>
      ) : (
        <Tabs value={tab} onValueChange={updateTab}>
          <TabsList
            aria-label="Insight reports"
            className="max-w-full flex-wrap group-data-horizontal/tabs:h-auto"
          >
            <TabsTrigger value="financial">Financial</TabsTrigger>
            <TabsTrigger value="operational">Operational</TabsTrigger>
            <TabsTrigger value="labour">Labour</TabsTrigger>
            <TabsTrigger value="scenarios">Scenarios</TabsTrigger>
            <TabsTrigger value="close">Close readiness</TabsTrigger>
          </TabsList>

          {!branchReady && tab !== 'scenarios' ? (
            <SectionCard title="Branch required">
              <div className="space-y-3" role="status">
                <StatusPill status="Reads disabled" tone="neutral" />
                <p className="text-sm text-text-muted">
                  Select a branch to load the selected read-only report. Branch scope fails closed:
                  cross-branch access requires the configure capability.
                </p>
              </div>
            </SectionCard>
          ) : null}

          <TabsContent value="financial">
            {financialActive ? (
              <ReportsPanel
                kind="financial"
                branchId={normalizedBranchId}
                from={from}
                to={to}
                listQuery={financialList}
                detailQuery={financialDetailQuery}
                selectedDate={selectedDate}
                onSelect={setSelectedDate}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="operational">
            {operationalActive ? (
              <ReportsPanel
                kind="operational"
                branchId={normalizedBranchId}
                from={from}
                to={to}
                listQuery={operationalList}
                detailQuery={operationalDetailQuery}
                selectedDate={selectedDate}
                onSelect={setSelectedDate}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="labour">
            {labourActive ? (
              <LabourPanel branchId={normalizedBranchId} from={from} to={to} query={labourList} />
            ) : null}
          </TabsContent>
          <TabsContent value="scenarios">
            <ContributionScenarios
              key={`${normalizedBranchId}:${from}:${to}`}
              branchId={normalizedBranchId || null}
              from={from || null}
              to={to || null}
            />
          </TabsContent>
          <TabsContent value="close">
            {tab === 'close' ? (
              <CloseReadinessPanel
                key={`${entitlements.organizationId}:${normalizedBranchId}:${closeBranchAvailable}`}
                organizationId={entitlements.organizationId}
                branchId={normalizedBranchId}
                branchName={closeBranch?.name ?? normalizedBranchId}
                branchAvailable={closeBranchAvailable}
                businessDate={closeBusinessDate}
                onBusinessDateChange={setCloseBusinessDate}
              />
            ) : null}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function ExportButton({
  kind,
  branchId,
  from,
  to,
}: {
  kind: ReportKind | 'labour';
  branchId: string;
  from: string;
  to: string;
}) {
  const utils = trpc.useUtils();
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle');

  const runExport = async () => {
    setStatus('working');
    const input = { branchId, ...(from ? { from } : {}), ...(to ? { to } : {}) };
    try {
      const file =
        kind === 'financial'
          ? await utils.restaurantInsights.exportFinancialReports.fetch(input)
          : kind === 'operational'
            ? await utils.restaurantInsights.exportOperationalReports.fetch(input)
            : await utils.restaurantInsights.exportLabourCosts.fetch(input);
      if (file) triggerDownload(file);
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={status === 'working'}
        aria-label={'Export ' + kind + ' report CSV'}
        onClick={() => void runExport()}
      >
        {status === 'working' ? 'Preparing export…' : 'Export CSV'}
      </Button>
      {status === 'error' ? (
        <span role="alert" className="text-xs text-destructive">
          Export failed — no data changed. Try again.
        </span>
      ) : null}
    </div>
  );
}

function ReportsPanel({
  kind,
  branchId,
  from,
  to,
  listQuery,
  detailQuery,
  selectedDate,
  onSelect,
}: {
  kind: ReportKind;
  branchId: string;
  from: string;
  to: string;
  listQuery: ReadQuery<ReportRow[]>;
  detailQuery: ReadQuery<ReportDetail | undefined>;
  selectedDate: string;
  onSelect: (businessDate: string) => void;
}) {
  const denied = isDenied(listQuery.error);
  const rows = denied ? [] : (listQuery.data ?? []);
  return (
    <div className="space-y-5">
      <SectionCard
        eyebrow={kind === 'financial' ? 'Financial reports' : 'Operational reports'}
        title={kind === 'financial' ? 'Sales and reconciliation' : 'Covers and throughput'}
        actions={<ExportButton kind={kind} branchId={branchId} from={from} to={to} />}
      >
        {listQuery.isLoading ? (
          <LoadingState label={'Loading ' + kind + ' reports'} />
        ) : listQuery.error ? (
          <ErrorState
            error={listQuery.error}
            retry={() => void listQuery.refetch()}
            subject={kind + ' reports'}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No rollups found"
            detail="No daily rollup exists for this branch and range yet."
          />
        ) : (
          <TableFrame label={kind + ' reports table'}>
            <Table className={kind === 'financial' ? 'min-w-[1180px]' : 'min-w-[760px]'}>
              <TableHeader>
                <TableRow>
                  <TableHead>Business date</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Freshness</TableHead>
                  <TableHead numeric>Orders</TableHead>
                  <TableHead numeric>Covers</TableHead>
                  {kind === 'financial' ? (
                    <>
                      <TableHead numeric>Gross</TableHead>
                      <TableHead numeric>Net</TableHead>
                      <TableHead numeric>Delivery fees</TableHead>
                      <TableHead numeric>Delivery fee refunds</TableHead>
                      <TableHead numeric>Comps</TableHead>
                      <TableHead numeric>Refunds</TableHead>
                      <TableHead numeric>Voids</TableHead>
                      <TableHead numeric>Drawer variance</TableHead>
                      <TableHead numeric>Loyalty liability</TableHead>
                    </>
                  ) : null}
                  <TableHead className="text-right">Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const money = financialRow(row, kind);
                  return (
                    <TableRow
                      key={row.id}
                      data-state={selectedDate === row.businessDate ? 'selected' : undefined}
                    >
                      <TableCell className="font-medium text-text-strong">
                        {row.businessDate}
                      </TableCell>
                      <TableCell>{row.branchName}</TableCell>
                      <TableCell>
                        <FreshnessPill status={row.freshness.status} />
                      </TableCell>
                      <TableCell numeric>{row.orderCount}</TableCell>
                      <TableCell numeric>{row.coverCount}</TableCell>
                      {money ? (
                        <>
                          <TableCell numeric>{money.grossSales}</TableCell>
                          <TableCell numeric>{money.netSales}</TableCell>
                          <TableCell numeric>{money.deliveryFeeSales}</TableCell>
                          <TableCell numeric>{money.deliveryFeeRefunds}</TableCell>
                          <TableCell numeric>{money.compTotal}</TableCell>
                          <TableCell numeric>{money.refundTotal}</TableCell>
                          <TableCell numeric>{money.voidTotal}</TableCell>
                          <TableCell numeric>{money.drawerVariance}</TableCell>
                          <TableCell numeric>{money.loyaltyLiability}</TableCell>
                        </>
                      ) : null}
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant={selectedDate === row.businessDate ? 'secondary' : 'outline'}
                          aria-pressed={selectedDate === row.businessDate}
                          onClick={() => onSelect(row.businessDate)}
                        >
                          View {row.businessDate}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableFrame>
        )}
      </SectionCard>

      {selectedDate ? (
        <SectionCard eyebrow="Selected business date" title="Report detail and item mix">
          {detailQuery.isLoading ? (
            <LoadingState label="Loading report detail" />
          ) : detailQuery.error ? (
            <ErrorState
              error={detailQuery.error}
              retry={() => void detailQuery.refetch()}
              subject="report detail"
            />
          ) : detailQuery.data ? (
            <ReportDetailPanel kind={kind} detail={detailQuery.data} />
          ) : (
            <EmptyState
              title="Report not found"
              detail="No rollup exists for the selected business date."
            />
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}

function ReportDetailPanel({ kind, detail }: { kind: ReportKind; detail: ReportDetail }) {
  const money = financialDetail(detail, kind);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <FreshnessPill status={detail.freshness.status} />
        <p className="font-mono text-xs text-text-muted">
          Source close {detail.freshness.sourceDailyCloseId} · computed{' '}
          {detail.freshness.computedAtLocal}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Orders" value={detail.orderCount} />
        <Stat label="Covers" value={detail.coverCount} />
        {money ? (
          <>
            <Stat label="Gross sales" value={money.grossSales} />
            <Stat label="Net sales" value={money.netSales} />
            <Stat label="Delivery fee sales" value={money.deliveryFeeSales} />
            <Stat label="Delivery fee refunds" value={money.deliveryFeeRefunds} />
            <Stat label="Comps" value={money.compTotal} />
            <Stat label="Refunds" value={money.refundTotal} />
            <Stat label="Voids" value={money.voidTotal} />
            <Stat label="Drawer variance" value={money.drawerVariance} />
            <Stat label="Loyalty liability" value={money.loyaltyLiability} />
          </>
        ) : null}
      </div>

      <section aria-labelledby="insights-item-mix-heading">
        <h3 id="insights-item-mix-heading" className="mb-3 font-semibold text-text-strong">
          Item mix
        </h3>
        {detail.itemMix.length ? (
          <TableFrame label="Item mix table">
            <Table className={kind === 'financial' ? 'min-w-[860px]' : 'min-w-[520px]'}>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead numeric>Quantity</TableHead>
                  {kind === 'financial' ? (
                    <>
                      <TableHead numeric>Gross</TableHead>
                      <TableHead numeric>Net</TableHead>
                      <TableHead numeric>Comps</TableHead>
                    </>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.itemMix.map((item) => {
                  const itemMoney =
                    kind === 'financial' ? (item as FinancialDetail['itemMix'][number]) : null;
                  return (
                    <TableRow key={item.productId}>
                      <TableCell>
                        <span className="block font-medium text-text-strong">
                          {item.productName}
                        </span>
                        <span className="block font-mono text-[0.625rem] text-text-faint">
                          {item.productId}
                        </span>
                      </TableCell>
                      <TableCell numeric>{item.quantity}</TableCell>
                      {itemMoney ? (
                        <>
                          <TableCell numeric>{itemMoney.grossSales}</TableCell>
                          <TableCell numeric>{itemMoney.netSales}</TableCell>
                          <TableCell numeric>{itemMoney.compTotal}</TableCell>
                        </>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableFrame>
        ) : (
          <EmptyState
            title="No item mix"
            detail="This rollup recorded no non-voided item snapshots."
          />
        )}
      </section>
    </div>
  );
}

function LabourPanel({
  branchId,
  from,
  to,
  query,
}: {
  branchId: string;
  from: string;
  to: string;
  query: ReadQuery<LabourRow[]>;
}) {
  const denied = isDenied(query.error);
  // Fail closed: never surface cached labour figures once the read is denied.
  const rows = denied || query.error ? [] : (query.data ?? []);
  return (
    <div className="space-y-5">
      <SectionCard
        eyebrow="Restricted report"
        title="Imported labour cost facts"
        actions={
          denied ? undefined : (
            <ExportButton kind="labour" branchId={branchId} from={from} to={to} />
          )
        }
      >
        <p className="mb-4 max-w-2xl text-sm text-text-muted">
          Labour cost is absent from ordinary reports. This restricted seam requires both the
          financial-reports and workforce-rates capabilities plus branch assignment.
        </p>
        {query.isLoading ? (
          <LoadingState label="Loading labour cost facts" />
        ) : query.error ? (
          <ErrorState
            error={query.error}
            retry={() => void query.refetch()}
            subject="labour cost facts"
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No labour cost facts"
            detail="No imported labour cost fact matches this branch and range."
          />
        ) : (
          <TableFrame label="Labour cost facts table">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Business date</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead numeric>Labour hours</TableHead>
                  <TableHead numeric>Labour cost</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Imported</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium text-text-strong">
                      {row.businessDate}
                    </TableCell>
                    <TableCell>{row.branchName}</TableCell>
                    <TableCell numeric>{row.labourHours}</TableCell>
                    <TableCell numeric>{row.labourCost}</TableCell>
                    <TableCell>{row.source}</TableCell>
                    <TableCell>{row.importedAtLocal}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        )}
      </SectionCard>
    </div>
  );
}
