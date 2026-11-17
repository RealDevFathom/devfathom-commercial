import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { can, subjectFromSession } from '@/lib/abac';
import { isModuleGranted } from '@/lib/module-catalog';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { pharmacyReportKpiFlags } from '@/lib/pharmacy/report-kpi-flags';
import {
  formatWorkspaceDateTime,
  workspaceDateRange,
  workspaceToday,
  workspaceZoneLabel,
} from '@/lib/timezone';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { pharmacySalesRouter } from '@/server/routers/pharmacy-sales';
import { createTRPCContext } from '@/server/trpc';
import { DailyWorkPack, DailyWorkPackLoading } from './daily-work-pack';
import { LostSalesRecovery } from './lost-sales-recovery';
import { MarketingSummary } from './marketing-summary';
import { ObservedDemand } from './observed-demand';
import { plainReportPermission, plainReportSource } from '@/lib/pharmacy/report-labels';
import { StaffingSuggestions } from './staffing-suggestions';
import { ReportCsvButton } from './report-csv-button';
import { ReportPrintButton } from './report-print-button';
import { DEFAULT_STAFFING_CONFIG } from '@/lib/pharmacy/staffing-suggestions';

export const metadata: Metadata = { title: 'Pharmacy reports' };

type SearchParams = Promise<
  Partial<
    Record<
      | 'branch'
      | 'from'
      | 'to'
      | 'section'
      | 'supplier'
      | 'ingredient'
      | 'batch'
      | 'digest'
      | 'anomaly'
      | 'advisor'
      | 'authentication'
      | 'staffCapacity'
      | 'staffMinimum',
      string | string[] | undefined
    >
  >
>;
const value = (input: string | string[] | undefined) =>
  typeof input === 'string' ? input : undefined;
const validDate = (input: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return false;
  const parsed = new Date(`${input}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === input;
};
// Module-scoped helper stays on the server; actions capture only the query string.
function reportActionRedirect(
  query: string,
  kind: 'anomaly' | 'advisor',
  state: 'saved' | 'error'
) {
  const copy = new URLSearchParams(query);
  copy.set(kind, state);
  return `/pharmacy/reports?${copy.toString()}`;
}
/** Keeps the report's branch scope on a metric drill-through (DEV-58). */
function scopedDrillThrough(path: string, branch: string | undefined) {
  if (!branch) return path;
  const url = new URL(path, 'https://reports.invalid');
  url.searchParams.set('branch', branch);
  return `${url.pathname}${url.search}`;
}
function ReportNotice({ title, detail }: { title: string; detail: string }) {
  return (
    <SectionCard title={title}>
      <p className="text-sm text-text-muted">{detail}</p>
    </SectionCard>
  );
}

export default async function PharmacyReportsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const ctx = await createTRPCContext();
  // DEV-35: settle the access lock before any report read, so a member without
  // the operational reports permission sees it at once rather than after the
  // branch and catalog loads. The procedures below stay the authority.
  const user = ctx.session?.user;
  const lockedDetail = !user?.id
    ? 'Sign in again to access pharmacy reports.'
    : !(await can(subjectFromSession(user), 'reports:operational', undefined, {
          db: ctx.db,
          source: 'TRPC',
          ip: ctx.requestMeta.ip,
        }))
      ? 'You need the operational reports permission to view pharmacy reports. Ask your workspace administrator to grant it.'
      : null;
  if (lockedDetail) {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy operations"
          heading="Reports"
          description="Bounded, permission-scoped command centre and report catalog."
        />
        <ReportNotice title="Reports unavailable" detail={lockedDetail} />
      </div>
    );
  }
  const caller = pharmacyReportsRouter.createCaller(ctx);
  let branchResult: Awaited<ReturnType<typeof caller.branches>>;
  let catalog: Awaited<ReturnType<typeof caller.catalog>>;
  try {
    [branchResult, catalog] = await Promise.all([caller.branches(), caller.catalog()]);
  } catch (error) {
    let detail =
      'Reports could not be loaded. Try again, or contact your workspace administrator if the problem continues.';
    if (error instanceof TRPCError) {
      if (error.code === 'UNAUTHORIZED') {
        detail = 'Sign in again to access pharmacy reports.';
      } else if (error.code === 'FORBIDDEN') {
        const moduleName =
          ctx.entitlements.modules.find((module) => module.key === 'pharmacy-reports')?.name ??
          'pharmacy-reports';
        if (error.message === 'You do not have permission for this action.') {
          detail =
            'You need the operational reports permission to view pharmacy reports. Ask your workspace administrator to grant it.';
        } else if (
          !isModuleGranted('pharmacy-reports', ctx.entitlements.enabledModules) &&
          (error.message === 'Pharmacy reports are not licensed.' ||
            error.message === `The ${moduleName} module is not enabled for this organization.`)
        ) {
          detail =
            'The Pharmacy Reports module is not enabled for this workspace. Ask your workspace administrator to enable it.';
        }
      }
    }
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy operations"
          heading="Reports"
          description="Bounded, permission-scoped command centre and report catalog."
        />
        <ReportNotice title="Reports unavailable" detail={detail} />
      </div>
    );
  }
  // Reuse the authenticated tenant context; report rows do not prove historical currency.
  const organizationCurrency =
    ctx.organization?.id === ctx.entitlements.organizationId ? ctx.organization?.currency : null;
  const currency =
    organizationCurrency && /^[A-Z]{3}$/.test(organizationCurrency) ? organizationCurrency : null;
  const money = (minor: number | null) => {
    if (minor == null || !Number.isSafeInteger(minor)) return '—';
    const amount = formatMinor(minor).replace(/\B(?=(\d{3})+\.)/g, ',');
    return currency ? `${currency} ${amount}` : `${amount} (currency unknown)`;
  };
  // The owner's business day: the workspace zone, not UTC (00:00–04:59 PKT is still "today").
  const timeZone = ctx.organization?.timezone;
  const today = workspaceToday(timeZone);
  const fromDate = new Date(`${today}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 6);
  const from = value(query.from) ?? fromDate.toISOString().slice(0, 10);
  const to = value(query.to) ?? today;
  const invalidRange = !validDate(from) || !validDate(to) || from > to;
  const branch =
    value(query.branch) ??
    (query.branch === undefined && branchResult.branches.length === 1
      ? branchResult.branches[0]?.id
      : undefined);
  const section = value(query.section);
  const supplier = value(query.supplier);
  let suppliers: Awaited<ReturnType<typeof caller.suppliers>> | null = null;
  try {
    suppliers = await caller.suppliers();
  } catch {
    // Keep the selected filter when supplier names cannot be loaded.
  }
  const ingredient = value(query.ingredient);
  const batch = value(query.batch);
  let result: Awaited<ReturnType<typeof caller.commandCentre>> | null = null;
  let digest: Awaited<ReturnType<typeof caller.digestOverview>> | null = null;
  let anomalies: Awaited<ReturnType<typeof caller.anomalySignals>> | null = null;
  let expiryAdvice: Awaited<ReturnType<typeof caller.expiryAdvice>> | null = null;
  let expiryAdviceError = false;
  let authenticationFlags: Awaited<ReturnType<typeof caller.packAuthenticationFlags>> = null;
  // Pack scans record no supplier, so the reader returns null instead of unfiltered flags.
  let authenticationNotFilterable = false;
  let reportError = false;
  let marketing: Awaited<ReturnType<typeof caller.marketing>> | null = null;
  let lostSales: Awaited<ReturnType<typeof caller.lostSalesRecovery>> | null = null;
  let demand: Awaited<
    ReturnType<ReturnType<typeof pharmacySalesRouter.createCaller>['demandAggregate']>
  > | null = null;
  let demandError = false;
  const reportFilters = {
    ...(branch ? { branchId: branch } : {}),
    ...(supplier ? { supplierId: supplier } : {}),
    ...(ingredient ? { ingredientId: ingredient } : {}),
    ...(batch ? { batchId: batch } : {}),
    from,
    to,
  };
  if (!invalidRange && branchResult.branches.length > 0) {
    const [
      reportResult,
      digestResult,
      anomalyResult,
      expiryResult,
      authenticationResult,
      marketingResult,
      lostSalesResult,
    ] = await Promise.allSettled([
      caller.commandCentre(reportFilters),
      caller.digestOverview(),
      caller.anomalySignals(reportFilters),
      caller.expiryAdvice(reportFilters),
      caller.packAuthenticationFlags(reportFilters),
      Promise.resolve().then(() =>
        caller.marketing({ ...(branch ? { branchId: branch } : {}), from, to })
      ),
      Promise.resolve().then(() =>
        catalog.permissions.financial
          ? caller.lostSalesRecovery({ ...(branch ? { branchId: branch } : {}), from, to })
          : null
      ),
    ]);
    if (marketingResult.status === 'fulfilled') marketing = marketingResult.value;
    if (lostSalesResult.status === 'fulfilled') lostSales = lostSalesResult.value;
    if (reportResult.status === 'fulfilled') result = reportResult.value;
    else reportError = true;
    if (digestResult.status === 'fulfilled') digest = digestResult.value;
    if (anomalyResult.status === 'fulfilled') anomalies = anomalyResult.value;
    if (expiryResult.status === 'fulfilled') expiryAdvice = expiryResult.value;
    else {
      expiryAdviceError = !(
        expiryResult.reason instanceof TRPCError &&
        ['FORBIDDEN', 'UNAUTHORIZED'].includes(expiryResult.reason.code)
      );
      if (expiryAdviceError) {
        console.error('[pharmacy-reports] Expiry advice failed', expiryResult.reason);
      }
    }
    if (authenticationResult.status === 'fulfilled') {
      authenticationFlags = authenticationResult.value;
      authenticationNotFilterable = authenticationResult.value === null;
    }
  }
  const demandScopeValid =
    !invalidRange &&
    ![query.branch, query.from, query.to].some(Array.isArray) &&
    (Date.parse(to) - Date.parse(from)) / 86_400_000 < 90;
  // DEV-845: observed demand is a manager or owner report. Hide the section for
  // anyone else rather than showing them the procedure's refusal as an error.
  let demandVisible =
    !!user &&
    (await can(subjectFromSession(user), 'pharmacy:manage', undefined, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    }));
  if (
    demandVisible &&
    demandScopeValid &&
    branch &&
    branchResult.branches.some((item) => item.id === branch)
  ) {
    try {
      // Event timestamps: bound the selected business dates on the workspace clock.
      demand = await pharmacySalesRouter.createCaller(ctx).demandAggregate({
        branchId: branch,
        ...workspaceDateRange(from, to, timeZone),
      });
    } catch (error) {
      // A counter DENY or a branch outside the manager's assignment is a refusal, not a failure.
      if (error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code))
        demandVisible = false;
      else demandError = true;
    }
  }
  // DEV-14: owner-adjustable assumptions; the server validates the bounds again.
  const staffingNumber = (input: string | undefined, fallback: number) =>
    input !== undefined && /^\d{1,3}$/.test(input) ? Number(input) : fallback;
  const receiptsPerStaffHour = staffingNumber(
    value(query.staffCapacity),
    DEFAULT_STAFFING_CONFIG.receiptsPerStaffHour
  );
  const minimumStaff = staffingNumber(
    value(query.staffMinimum),
    DEFAULT_STAFFING_CONFIG.minimumStaff
  );
  let staffing: Awaited<ReturnType<typeof caller.staffingSuggestions>> | null = null;
  let staffingError = false;
  if (demandScopeValid && branch && branchResult.branches.some((item) => item.id === branch)) {
    try {
      staffing = await caller.staffingSuggestions({
        branchId: branch,
        from,
        to,
        receiptsPerStaffHour,
        minimumStaff,
      });
    } catch {
      staffingError = true;
    }
  }
  const digestMessage = value(query.digest);
  const anomalyMessage = value(query.anomaly);
  const advisorMessage = value(query.advisor);
  const authenticationMessage = value(query.authentication);
  const returnQuery = new URLSearchParams(
    Object.entries({ branch, supplier, ingredient, batch, from, to }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
  const followUpQuery = new URLSearchParams(returnQuery);
  for (const filter of ['supplier', 'ingredient', 'batch']) followUpQuery.delete(filter);
  const workPackScopeValid =
    !invalidRange &&
    ![query.branch, query.from, query.to].some(Array.isArray) &&
    branchResult.branches.length > 0 &&
    (!branch || branchResult.branches.some((item) => item.id === branch));
  const returnQueryString = returnQuery.toString();

  async function saveDigestSetting(data: FormData) {
    'use server';
    try {
      const actionCtx = await createTRPCContext();
      const actionCaller = pharmacyReportsRouter.createCaller(actionCtx);
      await actionCaller.updateDigestSetting({
        branchId: String(data.get('branchId') ?? ''),
        enabled: data.get('enabled') === 'true',
        time: String(data.get('time') ?? ''),
      });
    } catch {
      redirect('/pharmacy/reports?digest=error');
    }
    redirect('/pharmacy/reports?digest=saved');
  }
  async function refreshAnomalies() {
    'use server';
    let failed = false;
    try {
      const actionCtx = await createTRPCContext();
      await pharmacyReportsRouter.createCaller(actionCtx).refreshAnomalies(reportFilters);
    } catch {
      failed = true;
    }
    redirect(reportActionRedirect(returnQueryString, 'anomaly', failed ? 'error' : 'saved'));
  }
  async function proposeReturn(data: FormData) {
    'use server';
    let failed = false;
    try {
      const actionCtx = await createTRPCContext();
      await pharmacyReportsRouter.createCaller(actionCtx).proposeExpiryReturn({
        branchId: String(data.get('branchId') ?? ''),
        lotId: String(data.get('lotId') ?? ''),
      });
    } catch {
      failed = true;
    }
    redirect(reportActionRedirect(returnQueryString, 'advisor', failed ? 'error' : 'saved'));
  }
  async function acknowledgeAnomaly(data: FormData) {
    'use server';
    let failed = false;
    try {
      const actionCtx = await createTRPCContext();
      await pharmacyReportsRouter.createCaller(actionCtx).acknowledgeAnomaly({
        branchId: String(data.get('branchId') ?? ''),
        signalId: String(data.get('signalId') ?? ''),
        reason: String(data.get('reason') ?? ''),
      });
    } catch {
      failed = true;
    }
    redirect(reportActionRedirect(returnQueryString, 'anomaly', failed ? 'error' : 'saved'));
  }
  async function snoozeAnomaly(data: FormData) {
    'use server';
    let failed = false;
    try {
      const actionCtx = await createTRPCContext();
      const parsedUntil = new Date(String(data.get('snoozedUntil') ?? ''));
      await pharmacyReportsRouter.createCaller(actionCtx).snoozeAnomaly({
        branchId: String(data.get('branchId') ?? ''),
        signalId: String(data.get('signalId') ?? ''),
        reason: String(data.get('reason') ?? ''),
        snoozedUntil: parsedUntil.toISOString(),
      });
    } catch {
      failed = true;
    }
    redirect(reportActionRedirect(returnQueryString, 'anomaly', failed ? 'error' : 'saved'));
  }
  async function acknowledgeAuthenticationFlag(data: FormData) {
    'use server';
    let failed = false;
    try {
      const actionCtx = await createTRPCContext();
      await pharmacyReportsRouter.createCaller(actionCtx).acknowledgePackAuthenticationFlag({
        branchId: String(data.get('branchId') ?? ''),
        signalId: String(data.get('scanId') ?? ''),
        reason: String(data.get('reason') ?? ''),
      });
    } catch {
      failed = true;
    }
    const copy = new URLSearchParams(returnQueryString);
    copy.set('authentication', failed ? 'error' : 'saved');
    redirect(`/pharmacy/reports?${copy.toString()}`);
  }
  const metrics = result?.metrics;
  // DEV-733: abnormal refund ratio / cash variance get an amber review flag (label + text, not
  // colour alone); a variance with no final close is shown as unavailable, never as 0.00.
  const kpiFlags = metrics ? pharmacyReportKpiFlags(metrics) : {};
  const varianceNotComputed =
    metrics != null && metrics.salesMinor != null && metrics.cashVarianceMinor == null;
  const cards: Array<{
    label: string;
    figure: string | number;
    flag?: { detail: string };
    note?: string;
  }> = metrics
    ? [
        { label: 'Sales', figure: money(metrics.salesMinor) },
        { label: 'Gross margin', figure: money(metrics.marginMinor) },
        { label: 'Cash', figure: money(metrics.cashMinor) },
        {
          label: 'Cash variance',
          figure: money(metrics.cashVarianceMinor),
          flag: kpiFlags.cashVarianceMinor,
          note: varianceNotComputed ? 'Not computed · no final day close in period' : undefined,
        },
        { label: 'Refunds', figure: money(metrics.refundsMinor), flag: kpiFlags.refundsMinor },
        // DEV-729: null means stock signals were never worked out for this scope, not zero.
        { label: 'Open stock signals', figure: metrics.openStockSignals ?? 'Not calculated yet' },
        { label: 'Recommended orders', figure: metrics.recommendedOrders ?? 'Not calculated yet' },
        { label: 'Expiry ≤30d', figure: money(metrics.expiryValueMinor30) },
        { label: 'Expiry ≤90d', figure: money(metrics.expiryValueMinor90) },
      ]
    : [];
  return (
    <div className="min-w-0 space-y-6" data-report-print>
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Reports"
        description="Bounded, permission-scoped command centre and report catalog. Values are ledger-derived and freshness-labelled."
        actions={
          // The sub-reports are the page's secondary actions, so they sit in the
          // header's action slot as Studio controls rather than as bare links.
          <nav aria-label="Sub-reports" className="flex flex-wrap gap-2">
            {result ? <ReportPrintButton /> : null}
            {result ? (
              <ReportCsvButton
                rows={cards.map((card) => ({ label: card.label, figure: String(card.figure) }))}
                context={{ Branch: branch ?? 'All available branches', From: from, To: to }}
                filename={`pharmacy-report-${from}-to-${to}.csv`}
              />
            ) : null}
            <Link
              href={`/pharmacy/reports/replenishment${branch ? `?${new URLSearchParams({ branch })}` : ''}`}
              className={buttonVariants({ variant: 'outline', size: 'lg' })}
            >
              Replenishment
            </Link>
            <Link
              href={`/pharmacy/reports/repeat-purchasing${branch ? `?${new URLSearchParams({ branch })}` : ''}`}
              className={buttonVariants({ variant: 'outline', size: 'lg' })}
            >
              Repeat purchasing
            </Link>
            {catalog.permissions.financial ? (
              <Link
                href={`/pharmacy/reports/supplier-credit-follow-up?${followUpQuery}`}
                prefetch={false}
                className={buttonVariants({ variant: 'outline', size: 'lg' })}
              >
                Supplier-credit follow-up
              </Link>
            ) : null}
            {catalog.permissions.owner ? (
              <Link
                href={`/pharmacy/reports/branch-comparison?${new URLSearchParams({ from, to })}`}
                className={buttonVariants({ variant: 'outline', size: 'lg' })}
              >
                Compare branches
              </Link>
            ) : null}
          </nav>
        }
      />
      <SectionCard eyebrow="Reports" title="Report filters" titleLevel={2}>
        <form data-report-filters className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" method="get">
          <label className="text-sm text-text-body">
            Branch
            <select
              className="mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              defaultValue={branch ?? ''}
              name="branch"
            >
              <option value="">All available</option>
              {branchResult.branches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="text-sm text-text-body">
            <label htmlFor="report-supplier" className="block">
              Supplier
            </label>
            <select
              id="report-supplier"
              className="mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              defaultValue={supplier ?? ''}
              name="supplier"
              aria-describedby={suppliers === null ? 'supplier-load-error' : undefined}
            >
              <option value="">All suppliers</option>
              {supplier && !suppliers?.some((item) => item.id === supplier) ? (
                <option value={supplier}>Selected supplier unavailable</option>
              ) : null}
              {suppliers?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            {suppliers === null ? (
              <span id="supplier-load-error" className="block text-sm text-text-muted">
                Supplier names could not load. Apply filters again to retry.
              </span>
            ) : null}
          </div>
          <label className="text-sm text-text-body">
            Ingredient ID
            <Input className="mt-1 min-h-11" defaultValue={ingredient} name="ingredient" />
          </label>
          <label className="text-sm text-text-body">
            Batch ID
            <Input className="mt-1 min-h-11" defaultValue={batch} name="batch" />
          </label>
          <label className="text-sm text-text-body">
            From
            <Input
              className="mt-1 min-h-11"
              defaultValue={from}
              name="from"
              type="date"
              required
              aria-invalid={invalidRange}
              aria-describedby={invalidRange ? 'report-date-error' : undefined}
            />
          </label>
          <label className="text-sm text-text-body">
            To
            <Input
              className="mt-1 min-h-11"
              defaultValue={to}
              name="to"
              type="date"
              required
              aria-invalid={invalidRange}
              aria-describedby={invalidRange ? 'report-date-error' : undefined}
            />
          </label>
          <Button className="min-h-11 self-end" type="submit">
            Apply filters
          </Button>
        </form>
      </SectionCard>
      {result ? (
        <SectionCard
          eyebrow="Owner command centre"
          title="Selected period at a glance"
          titleLevel={2}
        >
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {cards.map(({ label, figure, flag, note }) => (
              <Stat
                key={label}
                label={label}
                value={figure}
                className="min-w-0"
                valueClassName={flag ? 'break-words text-warning' : 'break-words'}
                data-flagged={flag ? 'true' : undefined}
                sub={
                  <span className="flex flex-col gap-1">
                    {flag ? (
                      <>
                        <StatusPill status="Review" tone="warning" />
                        <span className="text-warning">{flag.detail}</span>
                      </>
                    ) : null}
                    <span>
                      {note ??
                        (branch
                          ? 'Selected branch · ledger source'
                          : 'All available branches · ledger source')}
                    </span>
                  </span>
                }
              />
            ))}
          </div>
          <div className="mt-6">
            <Stat
              label="Organization-wide safety queue"
              value={metrics?.safetyQueue ?? '—'}
              sub="Current snapshot · organization-wide"
            />
            <p className="mt-2 text-sm text-text-muted">
              The selected branch does not apply to this queue. Date, supplier, ingredient and batch
              filters do not apply either. Unsigned pharmacist review items plus open
              controlled-register incidents, from pharmacist review and controlled-register records
              at read time.
            </p>
          </div>
          <p className="mt-6 text-sm text-text-muted">
            Report period: {from} to {to} (inclusive business dates). Branch scope:{' '}
            {branch
              ? (branchResult.branches.find((item) => item.id === branch)?.name ?? branch)
              : 'All available branches'}
            .{' '}
            {currency
              ? `Currency basis: current organization setting (${currency}); historical transaction currency is not verified.`
              : 'Currency unknown: an authoritative currency for this organization is unavailable; historical transaction currency is not verified.'}{' '}
            Amounts use the pharmacy minor-unit scale, shown to two decimal places. — means
            unavailable, not zero. Sales, gross margin, cash, cash variance and refunds cover the
            selected period. Stock signals, recommended orders and expiry exposure are current
            snapshots; expiry exposure is not realized loss. Gross margin is not cash flow. Gross
            margin uses the same exact posted journal as Finance, including returns and reversals,
            on postings from the start of the first selected date to the start of the day after the
            last, in {workspaceZoneLabel(timeZone)}. Finance&apos;s margin comparison still splits
            days at midnight UTC, so its totals can differ for the same dates. It may differ from
            sales grouped by business date. Missing journal evidence is unavailable; posted totals
            do not establish complete source or cost coverage. Supplier, ingredient and batch
            filters narrow sales, gross margin, stock signals, recommended orders and expiry
            exposure to the matching stock lots and products. Cash, cash variance and refunds cannot
            be traced to a supplier, ingredient or batch, so they show — while one is selected. The
            daily work pack and observed demand use branch/date scope only.
          </p>
        </SectionCard>
      ) : null}
      <MarketingSummary
        report={marketing}
        money={money}
        branch={branch}
        financial={catalog.permissions.financial}
      />
      <LostSalesRecovery
        report={lostSales}
        money={money}
        financial={catalog.permissions.financial}
      />
      {demandVisible ? (
        <ObservedDemand
          timeZone={timeZone}
          report={demand}
          failed={demandError}
          selected={!!branch}
          financial={catalog.permissions.financial}
        />
      ) : null}
      <StaffingSuggestions
        timeZone={timeZone}
        report={staffing}
        failed={staffingError}
        selected={!!branch}
        carry={Object.fromEntries(
          Object.entries({ branch, from, to }).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )}
        receiptsPerStaffHour={receiptsPerStaffHour}
        minimumStaff={minimumStaff}
      />
      {workPackScopeValid ? (
        <Suspense key={returnQuery.toString()} fallback={<DailyWorkPackLoading />}>
          <DailyWorkPack
            read={caller.dailyWorkPack}
            filters={{ ...(branch ? { branchId: branch } : {}), from, to }}
            branches={branchResult.branches}
            refreshFields={Object.fromEntries(returnQuery)}
          />
        </Suspense>
      ) : (
        <ReportNotice
          title="Daily work pack unavailable"
          detail="Select an available branch scope and a valid, unambiguous date range. No work-pack sources were queried."
        />
      )}
      {invalidRange ? (
        <p id="report-date-error" role="alert" className="text-sm text-destructive">
          Enter valid dates with From on or before To. No report was loaded.
        </p>
      ) : reportError ? (
        <ReportNotice
          title="Report could not load"
          detail="Check the date range and branch scope, then apply the filters again. No data was changed."
        />
      ) : result ? (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm text-text-muted">
            <StatusPill
              status={result.freshness.status === 'CURRENT' ? 'Current' : result.freshness.status}
              tone={result.freshness.status === 'CURRENT' ? 'success' : 'warning'}
            />
            <span>As of {formatWorkspaceDateTime(result.freshness.asOf, timeZone)}</span>
            <span>Source: {plainReportSource(result.freshness.source) ?? 'pharmacy records'}</span>
          </div>
          {section === 'sales' && metrics ? (
            <SectionCard
              id="sales"
              eyebrow="Sales detail"
              title="Sales and margin for the selected period"
              titleLevel={2}
            >
              <p className="mb-4 text-sm text-text-muted">
                Report period: {from} to {to} (inclusive business dates). Branch scope:{' '}
                {branch
                  ? (branchResult.branches.find((item) => item.id === branch)?.name ?? branch)
                  : 'All available branches'}
                . — means unavailable, not zero.
              </p>
              <div className="grid gap-6 sm:grid-cols-2">
                <Stat label="Sales" value={money(metrics.salesMinor)} sub="Ledger source" />
                <Stat label="Gross margin" value={money(metrics.marginMinor)} sub="Ledger source" />
              </div>
              <Link
                className="mt-4 inline-flex text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                href={scopedDrillThrough('/pharmacy/reports', branch)}
              >
                Back to overview
              </Link>
            </SectionCard>
          ) : null}
          {expiryAdvice ? (
            <SectionCard
              eyebrow="Advisory only"
              id="expiry-advisor"
              title="Expiry and supplier-return advisor"
              titleLevel={2}
            >
              <p className="max-w-3xl text-sm leading-6 text-text-muted">
                Ranked by projected stock value left at expiry, using only each branch&apos;s recent
                completed dispensing and sales. Draft proposals do not reserve, move, quarantine,
                write off, or return stock; a human must review and submit them. Supplier,
                ingredient and batch filters narrow the lots listed.
              </p>
              {advisorMessage === 'saved' ? (
                <p className="mt-3 text-sm text-success" role="status">
                  Draft expiry claim created for human review.
                </p>
              ) : advisorMessage === 'error' ? (
                <p className="mt-3 text-sm text-destructive" role="alert">
                  The draft could not be created. Eligibility or access may have changed.
                </p>
              ) : null}
              {expiryAdvice.length ? (
                <ol className="mt-5 divide-y divide-border-subtle border-y border-border-subtle">
                  {expiryAdvice.map((item) => (
                    <li className="py-5" key={`${item.lotId}:${item.stockLocationId}`}>
                      <article className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-semibold text-text-strong">{item.medicineName}</h3>
                            <StatusPill
                              status={item.classification.replaceAll('_', ' ')}
                              tone={
                                item.classification === 'SELLABLE'
                                  ? 'success'
                                  : item.classification === 'RETURNABLE'
                                    ? 'warning'
                                    : 'neutral'
                              }
                            />
                            {item.coldChain ? (
                              <StatusPill status="Cold chain" tone="warning" />
                            ) : null}
                          </div>
                          <p className="mt-2 text-sm leading-6 text-text-body">
                            {item.explanation}
                          </p>
                          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11px] text-text-muted tabular-nums">
                            <div>
                              <dt className="inline font-semibold text-text-body">Batch: </dt>
                              <dd className="inline">{item.batchNumber}</dd>
                            </div>
                            <div>
                              <dt className="inline font-semibold text-text-body">On hand: </dt>
                              <dd className="inline">{item.onHandUnits} units</dd>
                            </div>
                            <div>
                              <dt className="inline font-semibold text-text-body">
                                Value at risk:{' '}
                              </dt>
                              <dd className="inline">{money(item.valueAtRiskMinor)}</dd>
                            </div>
                            <div>
                              <dt className="inline font-semibold text-text-body">Supplier: </dt>
                              <dd className="inline">{item.supplierName}</dd>
                            </div>
                          </dl>
                        </div>
                        {item.proposalAllowed ? (
                          <form action={proposeReturn}>
                            <input name="branchId" type="hidden" value={item.branchId} />
                            <input name="lotId" type="hidden" value={item.lotId} />
                            <Button className="min-h-11" type="submit" variant="outline">
                              Create draft proposal
                            </Button>
                          </form>
                        ) : null}
                      </article>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-5 text-sm text-text-muted">
                  No future-expiry lots with available stock match this scope.
                </p>
              )}
            </SectionCard>
          ) : expiryAdviceError ? (
            <SectionCard
              eyebrow="Could not load"
              id="expiry-advisor"
              title="Expiry and supplier-return advisor"
              titleLevel={2}
            >
              <p className="text-sm text-text-muted" role="alert">
                Expiry advice could not load. Apply the filters again to retry. No stock or
                supplier-return data was changed.
              </p>
            </SectionCard>
          ) : (
            <SectionCard
              eyebrow="Owner only"
              id="expiry-advisor"
              title="Expiry and supplier-return advisor"
              titleLevel={2}
            >
              <p className="text-sm text-text-muted">
                Financial report and owner permissions are required to view value-at-risk advice.
              </p>
            </SectionCard>
          )}
          {anomalies ? (
            <SectionCard
              eyebrow="Review only"
              title="Anomaly review signals"
              titleLevel={2}
              actions={
                <form action={refreshAnomalies}>
                  <Button type="submit" variant="outline">
                    Refresh signals
                  </Button>
                </form>
              }
            >
              <p className="max-w-3xl text-sm leading-6 text-text-muted">
                Deterministic event checks only. Signals never rank staff, imply misconduct, or
                create orders, stock movements, price changes, or finance postings. A human opens
                and reviews the source evidence.
              </p>
              {anomalyMessage === 'saved' ? (
                <p className="mt-3 text-sm text-success" role="status">
                  Anomaly signal state updated.
                </p>
              ) : anomalyMessage === 'error' ? (
                <p className="mt-3 text-sm text-destructive" role="alert">
                  The anomaly action could not be completed. Check the reason, date, and access.
                </p>
              ) : null}
              {anomalies.length ? (
                <ol className="mt-5 divide-y divide-border-subtle border-y border-border-subtle">
                  {anomalies.map((signal) => {
                    const scope = signal.scope as Record<string, string>;
                    const exactNumbers = signal.exactNumbers as Record<string, number>;
                    const unusable = signal.status === 'STALE';
                    return (
                      <li className="py-5" key={signal.id}>
                        <article>
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <h3 className="font-semibold text-text-strong">
                                {signal.kind.replaceAll('_', ' ').toLowerCase()}
                              </h3>
                              <p className="mt-1 font-mono text-[11px] text-text-muted">
                                Scope ·{' '}
                                {Object.entries(scope)
                                  .map(([key, item]) => `${key}: ${item}`)
                                  .join(' · ')}
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <StatusPill
                                status={signal.severity}
                                tone={signal.severity === 'URGENT' ? 'danger' : 'warning'}
                              />
                              <StatusPill
                                status={unusable ? 'Unusable · stale' : signal.status}
                                tone={unusable ? 'neutral' : undefined}
                              />
                            </div>
                          </div>
                          <p className="mt-3 max-w-4xl text-sm leading-6 text-text-body">
                            {signal.explanation}
                          </p>
                          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11px] text-text-muted tabular-nums">
                            {Object.entries(exactNumbers).map(([key, item]) => (
                              <div key={key}>
                                <dt className="inline font-semibold text-text-body">{key}: </dt>
                                <dd className="inline">{item}</dd>
                              </div>
                            ))}
                          </dl>
                          <p className="mt-3 text-xs leading-5 text-text-muted">
                            Window {new Date(signal.dataWindowStart).toLocaleString()}–
                            {new Date(signal.dataWindowEnd).toLocaleString()} · source observed{' '}
                            {new Date(signal.sourceObservedAt).toLocaleString()} · policy{' '}
                            {signal.policyVersion}
                          </p>
                          <div className="mt-3 flex flex-wrap gap-3 text-xs">
                            {scope.userId ? (
                              <span className="font-mono text-text-body">
                                Staff drill-down · {scope.userId}
                              </span>
                            ) : null}
                            {ctx.session?.user?.role === 'ADMIN' ? (
                              <Link
                                className="font-semibold text-accent-brand underline-offset-4 hover:underline"
                                href={`/audit-logs?${new URLSearchParams(scope.userId ? { actorId: scope.userId } : { search: signal.id })}`}
                              >
                                Open related audit trail
                              </Link>
                            ) : (
                              <span className="text-text-muted">
                                Related audit trail requires an administrator.
                              </span>
                            )}
                          </div>
                          {signal.estimateMethod ? (
                            <dl className="mt-3 grid gap-1 text-xs leading-5 text-text-muted">
                              <div>
                                <dt className="inline font-semibold text-text-body">
                                  Estimate method:{' '}
                                </dt>
                                <dd className="inline">{signal.estimateMethod}</dd>
                              </div>
                              <div>
                                <dt className="inline font-semibold text-text-body">Window: </dt>
                                <dd className="inline">{signal.estimateWindow}</dd>
                              </div>
                              <div>
                                <dt className="inline font-semibold text-text-body">
                                  Exclusions:{' '}
                                </dt>
                                <dd className="inline">{signal.estimateExclusions}</dd>
                              </div>
                              <div>
                                <dt className="inline font-semibold text-text-body">
                                  Confidence:{' '}
                                </dt>
                                <dd className="inline">{signal.estimateConfidence}</dd>
                              </div>
                            </dl>
                          ) : null}
                          {!unusable ? (
                            <div className="mt-4 grid gap-3 lg:grid-cols-2">
                              <form action={acknowledgeAnomaly} className="flex flex-wrap gap-2">
                                <input name="branchId" type="hidden" value={signal.branchId} />
                                <input name="signalId" type="hidden" value={signal.id} />
                                <label className="min-w-52 flex-1 text-xs text-text-body">
                                  Acknowledgement reason
                                  <Input
                                    className="mt-1 min-h-11"
                                    maxLength={500}
                                    minLength={3}
                                    name="reason"
                                    required
                                  />
                                </label>
                                <Button
                                  className="min-h-11 self-end"
                                  type="submit"
                                  variant="outline"
                                >
                                  Acknowledge
                                </Button>
                              </form>
                              <form action={snoozeAnomaly} className="grid gap-2 sm:grid-cols-2">
                                <input name="branchId" type="hidden" value={signal.branchId} />
                                <input name="signalId" type="hidden" value={signal.id} />
                                <label className="text-xs text-text-body">
                                  Snooze until
                                  <Input
                                    className="mt-1 min-h-11"
                                    name="snoozedUntil"
                                    required
                                    type="datetime-local"
                                  />
                                </label>
                                <label className="text-xs text-text-body">
                                  Snooze reason
                                  <Input
                                    className="mt-1 min-h-11"
                                    maxLength={500}
                                    minLength={3}
                                    name="reason"
                                    required
                                  />
                                </label>
                                <Button
                                  className="min-h-11 sm:col-span-2"
                                  type="submit"
                                  variant="outline"
                                >
                                  Snooze with reason
                                </Button>
                              </form>
                            </div>
                          ) : (
                            <p className="mt-4 text-sm font-medium text-text-muted">
                              Refresh source data before reviewing this signal.
                            </p>
                          )}
                        </article>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="mt-5 text-sm text-text-muted">
                  No anomaly signals match these filters. Refresh to evaluate the current ledger
                  window; no operational data will be changed.
                </p>
              )}
            </SectionCard>
          ) : (
            <SectionCard eyebrow="Owner only" title="Anomaly review signals" titleLevel={2}>
              <p className="text-sm text-text-muted">
                Financial report and owner permissions are required to view anomaly evidence.
              </p>
            </SectionCard>
          )}
          {authenticationFlags ? (
            <SectionCard
              eyebrow="SAFE-05 · Advisory"
              title="Pack authentication flags"
              titleLevel={2}
            >
              <p className="max-w-3xl text-sm leading-6 text-text-muted">
                Receiving and dispensing scans compare GTIN, batch, expiry, and serial evidence with
                this workspace. An unverifiable pack is never labelled counterfeit and never blocks
                a sale by itself. Recalled batches remain blocked by the recall path. Ingredient and
                batch filters narrow flags to scans matched to that medicine or batch.
              </p>
              {authenticationMessage === 'saved' ? (
                <p className="mt-3 text-sm text-success" role="status">
                  Authentication flag acknowledged.
                </p>
              ) : authenticationMessage === 'error' ? (
                <p className="mt-3 text-sm text-destructive" role="alert">
                  The flag could not be acknowledged. Check the reason and access.
                </p>
              ) : null}
              {authenticationFlags.length ? (
                <ol className="mt-5 divide-y divide-border-subtle border-y border-border-subtle">
                  {authenticationFlags.map((flag) => (
                    <li className="py-5" key={flag.id}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="font-semibold text-text-strong">
                            {flag.source.toLowerCase()} scan
                          </h3>
                          <p className="mt-1 font-mono text-[11px] text-text-muted">
                            GTIN {flag.gtin ?? 'not available'} · batch{' '}
                            {flag.batchNumber ?? 'not available'} · serial{' '}
                            {flag.serial ?? 'not available'}
                          </p>
                        </div>
                        <StatusPill
                          status={flag.status.replaceAll('_', ' ')}
                          tone={flag.status === 'BLOCKED_RECALL' ? 'danger' : 'warning'}
                        />
                      </div>
                      <p className="mt-3 text-sm leading-6 text-text-body">{flag.explanation}</p>
                      {flag.acknowledgedAt ? (
                        <p className="mt-3 text-sm text-text-muted">
                          Acknowledged: {flag.acknowledgementReason}
                        </p>
                      ) : (
                        <form
                          action={acknowledgeAuthenticationFlag}
                          className="mt-4 flex flex-wrap gap-2"
                        >
                          <input name="branchId" type="hidden" value={flag.branchId} />
                          <input name="scanId" type="hidden" value={flag.id} />
                          <label className="min-w-52 flex-1 text-xs text-text-body">
                            Acknowledgement reason
                            <Input
                              className="mt-1 min-h-11"
                              maxLength={500}
                              minLength={3}
                              name="reason"
                              required
                            />
                          </label>
                          <Button className="min-h-11 self-end" type="submit" variant="outline">
                            Acknowledge flag
                          </Button>
                        </form>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-5 text-sm text-text-muted">
                  No pack authentication flags match these branches.
                </p>
              )}
            </SectionCard>
          ) : authenticationNotFilterable ? (
            <ReportNotice
              title="Pack authentication flags"
              detail="Pack scans record the medicine and batch they matched, not the supplier, so these flags cannot be filtered by supplier. Clear the supplier filter to review them."
            />
          ) : null}
          <SectionCard eyebrow="Report catalog" title="Available reports" titleLevel={2}>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {catalog.reports.map((report) => (
                <div
                  className="rounded-md border border-border-subtle bg-surface-raised p-4"
                  key={report.key}
                >
                  <h3 className="font-medium text-text-strong">{report.label}</h3>
                  <p className="mt-2 text-sm text-text-muted">
                    {report.metrics.length} metric contracts · filters: {report.filters.join(', ')}
                  </p>
                  <div className="mt-4 space-y-3">
                    {report.metrics.map((metricKey) => {
                      const contract = catalog.metrics.find((metric) => metric.key === metricKey);
                      if (!contract) return null;
                      return (
                        <article
                          className="rounded-sm border border-border-subtle p-3"
                          key={metricKey}
                        >
                          <h4 className="text-sm font-semibold text-text-strong">
                            {metricKey === 'safetyQueue'
                              ? 'Organization-wide safety queue'
                              : contract.label.replace(/^Today's /, 'Selected-period ')}
                          </h4>
                          <p className="mt-1 text-xs leading-5 text-text-muted">
                            {contract.definition}
                          </p>
                          <dl className="mt-2 grid gap-1 font-mono text-[11px] text-text-body">
                            <div>
                              <dt className="inline font-semibold">Source: </dt>
                              <dd className="inline">
                                {plainReportSource(contract.source) ?? 'Not recorded'}
                              </dd>
                            </div>
                            <div>
                              <dt className="inline font-semibold">Scope: </dt>
                              <dd className="inline">
                                {metricKey === 'safetyQueue'
                                  ? 'Organization-wide at read time; selected branch does not apply'
                                  : contract.scope}
                              </dd>
                            </div>
                            <div>
                              <dt className="inline font-semibold">Access: </dt>
                              <dd className="inline">
                                {plainReportPermission(contract.permission)}
                              </dd>
                            </div>
                          </dl>
                          {contract.drillThrough ? (
                            <Link
                              className="mt-2 inline-flex text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              href={scopedDrillThrough(contract.drillThrough, branch)}
                            >
                              Drill through
                            </Link>
                          ) : (
                            <p className="mt-2 text-xs text-text-muted">
                              Drill-through unavailable
                            </p>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
          {digest ? (
            <>
              <SectionCard eyebrow="Scheduled delivery" title="Daily owner digest" titleLevel={2}>
                <p className="text-sm text-text-muted">
                  Opt in per branch. Times use your workspace timezone. Capture history is always
                  stored; WhatsApp remains disabled until a provider integration is implemented.
                </p>
                <p className="mt-2 text-sm text-text-muted">
                  Each digest opens with a five-line briefing: sales and cash, estimated lost demand
                  and walk-outs, the top gap with its purchase status, recovered sales, and expiry
                  at risk with khata due. A seven-day summary is added once a week. Item names for
                  the top gap appear only here; the owner WhatsApp version carries figures only.
                </p>
                {digestMessage === 'saved' ? (
                  <p className="mt-3 text-sm text-success" role="status">
                    Digest settings saved.
                  </p>
                ) : digestMessage === 'error' ? (
                  <p className="mt-3 text-sm text-destructive" role="alert">
                    Digest settings could not be saved. Check the time and try again.
                  </p>
                ) : null}
                <div className="mt-5 grid gap-3 md:grid-cols-2">
                  {digest.branches.map((item) => {
                    const setting = digest.settings.find(
                      (candidate) => candidate.branchId === item.id
                    );
                    const timeMinutes = setting?.timeMinutes ?? 480;
                    const time = `${String(Math.floor(timeMinutes / 60)).padStart(2, '0')}:${String(timeMinutes % 60).padStart(2, '0')}`;
                    return (
                      <form
                        action={saveDigestSetting}
                        className="rounded-md border border-border-subtle bg-surface-raised p-4"
                        key={item.id}
                      >
                        <input name="branchId" type="hidden" value={item.id} />
                        <input
                          name="enabled"
                          type="hidden"
                          value={setting?.enabled ? 'false' : 'true'}
                        />
                        <h3 className="font-medium text-text-strong">{item.name}</h3>
                        <label className="mt-3 block text-sm text-text-body">
                          Digest time
                          <Input
                            className="mt-1 min-h-11"
                            defaultValue={time}
                            name="time"
                            required
                            type="time"
                          />
                        </label>
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <Button type="submit" variant={setting?.enabled ? 'outline' : 'default'}>
                            {setting?.enabled ? 'Turn off digest' : 'Turn on digest'}
                          </Button>
                          <StatusPill status={setting?.enabled ? 'Active' : 'Disabled'} />
                        </div>
                      </form>
                    );
                  })}
                </div>
                <div className="mt-5 rounded-md border border-border-subtle p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="font-medium text-text-strong">WhatsApp</h3>
                    <StatusPill status="Disabled" />
                  </div>
                  <p className="mt-2 text-sm text-text-muted">
                    {digest.channels.whatsapp.configured
                      ? 'Provider credentials detected, but this P0-lite stub never sends messages.'
                      : 'No provider configuration detected. No messages are sent.'}
                  </p>
                </div>
              </SectionCard>
              <SectionCard eyebrow="Captured delivery" title="Digest history" titleLevel={2}>
                {digest.history.length ? (
                  <ol className="space-y-3">
                    {digest.history.map((capture) => (
                      <li
                        className="rounded-md border border-border-subtle bg-surface-raised p-4"
                        key={capture.id}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="font-medium text-text-strong">
                            {capture.branch.name} · {capture.businessDate}
                          </h3>
                          <StatusPill status="Captured" tone="success" />
                        </div>
                        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-5 text-text-body">
                          {capture.rendered}
                        </pre>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-text-muted">
                    No digests captured yet. Turn on a branch digest; history appears after its
                    scheduled time.
                  </p>
                )}
              </SectionCard>
            </>
          ) : (
            <SectionCard eyebrow="Owner only" title="Daily owner digest" titleLevel={2}>
              <p className="text-sm text-text-muted">
                Digest settings and history require owner permission. Reports remain available on
                demand.
              </p>
            </SectionCard>
          )}
        </>
      ) : branchResult.branches.length === 0 ? (
        <ReportNotice
          title="No reportable branches"
          detail="An active pharmacy branch is required before reports can be shown. Ask your workspace administrator to activate one."
        />
      ) : null}
    </div>
  );
}
