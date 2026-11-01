import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { pharmacySalesRouter } from '@/server/routers/pharmacy-sales';
import { createTRPCContext } from '@/server/trpc';
import { DailyWorkPack, DailyWorkPackLoading } from './daily-work-pack';
import { MarketingSummary } from './marketing-summary';
import { ObservedDemand } from './observed-demand';
import { loadReportFilterOptions } from './report-filter-options';
import {
  expiryBoardHref,
  formatReportPeriod,
  formatReportTimestamp,
  metricDrillThroughHref,
  pickerOptions,
  withBranch,
  type ReportFilterOption,
} from './report-helpers';

export const metadata: Metadata = { title: 'Pharmacy reports' };

type SearchParams = Promise<
  Partial<
    Record<
      | 'branch'
      | 'from'
      | 'to'
      | 'supplier'
      | 'ingredient'
      | 'batch'
      | 'digest'
      | 'anomaly'
      | 'advisor'
      | 'authentication',
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
const selectClass =
  'mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
function NamePicker({
  label,
  name,
  allLabel,
  noun,
  options,
  selected,
}: {
  label: string;
  name: string;
  allLabel: string;
  noun: string;
  options: readonly ReportFilterOption[];
  selected: string | undefined;
}) {
  return (
    <label className="text-sm text-text-body">
      {label}
      <select className={selectClass} defaultValue={selected ?? ''} name={name}>
        <option value="">{allLabel}</option>
        {pickerOptions(options, selected, noun).map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
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
  const caller = pharmacyReportsRouter.createCaller(ctx);
  let branchResult: Awaited<ReturnType<typeof caller.branches>>;
  let catalog: Awaited<ReturnType<typeof caller.catalog>>;
  try {
    [branchResult, catalog] = await Promise.all([caller.branches(), caller.catalog()]);
  } catch {
    return (
      <main className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Pharmacy operations"
          heading="Reports"
          description="Bounded, permission-scoped command centre and report catalog."
        />
        <ReportNotice
          title="Reports unavailable"
          detail="Your pharmacy reports permission or license is not available. Contact your workspace administrator."
        />
      </main>
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
  const today = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(`${today}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 6);
  const from = value(query.from) ?? fromDate.toISOString().slice(0, 10);
  const to = value(query.to) ?? today;
  const invalidRange = !validDate(from) || !validDate(to) || from > to;
  const branch = value(query.branch);
  // With one branch, "all available" is that branch: show its name instead of a picker and use
  // it wherever a single branch is required (demand, drill-throughs, sub-report links).
  const soleBranch = branchResult.branches.length === 1 ? branchResult.branches[0] : undefined;
  const focusBranch = branch ?? soleBranch?.id;
  const supplier = value(query.supplier);
  const ingredient = value(query.ingredient);
  const batch = value(query.batch);
  let result: Awaited<ReturnType<typeof caller.commandCentre>> | null = null;
  let digest: Awaited<ReturnType<typeof caller.digestOverview>> | null = null;
  let anomalies: Awaited<ReturnType<typeof caller.anomalySignals>> | null = null;
  let expiryAdvice: Awaited<ReturnType<typeof caller.expiryAdvice>> | null = null;
  let authenticationFlags: Awaited<ReturnType<typeof caller.packAuthenticationFlags>> | null = null;
  let reportError = false;
  let marketing: Awaited<ReturnType<typeof caller.marketing>> | null = null;
  let demand: Awaited<
    ReturnType<ReturnType<typeof pharmacySalesRouter.createCaller>['demandAggregate']>
  > | null = null;
  let demandError = false;
  const filterOptions = await loadReportFilterOptions(ctx.db, ctx.entitlements?.organizationId);
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
    ] = await Promise.allSettled([
      caller.commandCentre(reportFilters),
      caller.digestOverview(),
      caller.anomalySignals(reportFilters),
      caller.expiryAdvice(reportFilters),
      caller.packAuthenticationFlags(reportFilters),
      Promise.resolve().then(() =>
        caller.marketing({ ...(branch ? { branchId: branch } : {}), from, to })
      ),
    ]);
    if (marketingResult.status === 'fulfilled') marketing = marketingResult.value;
    if (reportResult.status === 'fulfilled') result = reportResult.value;
    else reportError = true;
    if (digestResult.status === 'fulfilled') digest = digestResult.value;
    if (anomalyResult.status === 'fulfilled') anomalies = anomalyResult.value;
    if (expiryResult.status === 'fulfilled') expiryAdvice = expiryResult.value;
    if (authenticationResult.status === 'fulfilled')
      authenticationFlags = authenticationResult.value;
  }
  const demandScopeValid =
    !invalidRange &&
    ![query.branch, query.from, query.to].some(Array.isArray) &&
    (Date.parse(to) - Date.parse(from)) / 86_400_000 < 90;
  if (
    demandScopeValid &&
    focusBranch &&
    branchResult.branches.some((item) => item.id === focusBranch)
  ) {
    try {
      demand = await pharmacySalesRouter.createCaller(ctx).demandAggregate({
        branchId: focusBranch,
        from: new Date(`${from}T00:00:00.000Z`),
        to: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000),
      });
    } catch {
      demandError = true;
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
  const cards: [string, string | number, { href: string; label: string }?][] = metrics
    ? [
        ['Sales', money(metrics.salesMinor)],
        ['Gross margin', money(metrics.marginMinor)],
        ['Cash', money(metrics.cashMinor)],
        ['Cash variance', money(metrics.cashVarianceMinor)],
        ['Refunds', money(metrics.refundsMinor)],
        ['Open stock signals', metrics.openStockSignals],
        ['Recommended orders', metrics.recommendedOrders],
        [
          'Expiry ≤30d',
          money(metrics.expiryValueMinor30),
          { href: expiryBoardHref(30, focusBranch), label: 'Open 30-day expiry board' },
        ],
        [
          'Expiry ≤90d',
          money(metrics.expiryValueMinor90),
          { href: expiryBoardHref(90, focusBranch), label: 'Open 90-day expiry board' },
        ],
      ]
    : [];
  const branchScopeName = branch
    ? (branchResult.branches.find((item) => item.id === branch)?.name ?? 'Selected branch')
    : soleBranch
      ? soleBranch.name
      : 'All available branches';
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Reports"
        description="Your pharmacy's sales, stock and expiry for the period you choose, with the reports behind each figure."
        actions={
          // The sub-reports are the page's secondary actions, so they sit in the
          // header's action slot as Studio controls rather than as bare links.
          <nav aria-label="Sub-reports" className="flex flex-wrap gap-2">
            <Link
              href={withBranch('/pharmacy/reports/replenishment', focusBranch)}
              className={buttonVariants({ variant: 'outline', size: 'lg' })}
            >
              Replenishment
            </Link>
            <Link
              href={withBranch('/pharmacy/reports/repeat-purchasing', focusBranch)}
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
      <SectionCard eyebrow="Choose what to see" title="Report filters" titleLevel={2}>
        <form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" method="get">
          {soleBranch ? (
            <div className="text-sm text-text-body">
              <span>Branch</span>
              <p className="mt-1 flex min-h-11 items-center font-medium text-text-strong">
                {soleBranch.name}
              </p>
            </div>
          ) : (
            <label className="text-sm text-text-body">
              Branch
              <select className={selectClass} defaultValue={branch ?? ''} name="branch">
                <option value="">All available</option>
                {branchResult.branches.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <NamePicker
            label="Supplier"
            name="supplier"
            allLabel="All suppliers"
            noun="supplier"
            options={filterOptions.suppliers}
            selected={supplier}
          />
          <NamePicker
            label="Ingredient"
            name="ingredient"
            allLabel="All ingredients"
            noun="ingredient"
            options={filterOptions.ingredients}
            selected={ingredient}
          />
          <NamePicker
            label="Batch"
            name="batch"
            allLabel="All batches"
            noun="batch"
            options={filterOptions.batches}
            selected={batch}
          />
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
          <SectionCard
            eyebrow="Owner command centre"
            title="Selected period at a glance"
            titleLevel={2}
          >
            <p className="text-sm text-text-body">
              {formatReportPeriod(from, to)} · {branchScopeName} ·{' '}
              {currency ? `Amounts in ${currency}` : 'Currency unknown'}
            </p>
            <div className="mt-2 mb-4 flex flex-wrap items-center gap-3 text-sm text-text-muted">
              <StatusPill
                status={result.freshness.status === 'CURRENT' ? 'Current' : result.freshness.status}
                tone={result.freshness.status === 'CURRENT' ? 'success' : 'warning'}
              />
              <span>Updated {formatReportTimestamp(result.freshness.asOf)}</span>
            </div>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {cards.map(([label, figure, link]) => (
                <Stat
                  key={label}
                  label={label}
                  value={figure}
                  className="min-w-0"
                  valueClassName="break-words"
                  sub={
                    link ? (
                      <Link
                        className="text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        href={link.href}
                      >
                        {link.label}
                      </Link>
                    ) : (
                      branchScopeName
                    )
                  }
                />
              ))}
            </div>
            <p className="mt-4 text-sm text-text-muted">
              Sales, margin, cash and refunds cover the selected dates. Stock, orders and expiry are
              as of now. — means the figure is unavailable, not zero.
            </p>
            <details className="mt-2 text-sm">
              <summary className="min-h-11 cursor-pointer py-3 font-medium text-text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                How these figures are calculated
              </summary>
              <p className="text-text-muted">
                Report period: {from} to {to} (inclusive business dates). Source:{' '}
                {result.freshness.source}.{' '}
                {currency
                  ? `Currency basis: current organization setting (${currency}); historical transaction currency is not verified.`
                  : 'Currency unknown: an authoritative currency for this organization is unavailable; historical transaction currency is not verified.'}{' '}
                Amounts use the pharmacy minor-unit scale, shown to two decimal places. Stock
                signals, recommended orders and expiry exposure are current snapshots; expiry
                exposure is not realized loss. Gross margin is not cash flow. Gross margin uses the
                same exact posted journal as Finance, including returns and reversals, on UTC
                posting dates (start inclusive, next-day end exclusive). It may differ from sales
                grouped by business date. Missing journal evidence is unavailable; posted totals do
                not establish complete source or cost coverage. Supplier, ingredient and batch
                filters do not apply to these KPI totals, the daily work pack or observed demand.
                Those panels use branch/date scope only; current snapshots use branch scope only.
              </p>
            </details>
            <div className="mt-6">
              <Stat
                label="Organization-wide safety queue"
                value={metrics?.safetyQueue ?? '—'}
                sub="Current snapshot · organization-wide"
              />
              <p className="mt-2 text-sm text-text-muted">
                Unsigned pharmacist reviews plus open controlled-register incidents, across the
                whole organization right now. Branch, date, supplier, ingredient and batch filters
                do not apply.
              </p>
            </div>
          </SectionCard>
          {expiryAdvice ? (
            <SectionCard
              eyebrow="AI-02 · Advisory only"
              title="Expiry and supplier-return advisor"
              titleLevel={2}
            >
              <p className="max-w-3xl text-sm leading-6 text-text-muted">
                Ranked by projected stock value left at expiry, using only each branch&apos;s recent
                completed dispensing and sales. Draft proposals do not reserve, move, quarantine,
                write off, or return stock; a human must review and submit them.
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
          ) : (
            <SectionCard
              eyebrow="AI-02 · Owner only"
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
              eyebrow="AI-04 / RPT-03 · Review only"
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
                            Window {formatReportTimestamp(signal.dataWindowStart)} –{' '}
                            {formatReportTimestamp(signal.dataWindowEnd)} · source observed{' '}
                            {formatReportTimestamp(signal.sourceObservedAt)} · policy{' '}
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
            <SectionCard
              eyebrow="AI-04 / RPT-03 · Owner only"
              title="Anomaly review signals"
              titleLevel={2}
            >
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
                a sale by itself. Recalled batches remain blocked by the recall path.
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
          ) : null}
        </>
      ) : branchResult.branches.length === 0 ? (
        <ReportNotice
          title="No reportable branches"
          detail="An active pharmacy branch is required before reports can be shown. Ask your workspace administrator to activate one."
        />
      ) : null}
      <ObservedDemand
        report={demand}
        failed={demandError}
        selected={!!focusBranch}
        financial={catalog.permissions.financial}
      />
      <MarketingSummary
        report={marketing}
        money={money}
        branch={focusBranch}
        financial={catalog.permissions.financial}
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
      {result ? (
        <>
          <SectionCard eyebrow="Report catalog" title="Available reports" titleLevel={2}>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {catalog.reports.map((report) => (
                <div
                  className="rounded-md border border-border-subtle bg-surface-raised p-4"
                  key={report.key}
                >
                  <h3 className="font-medium text-text-strong">{report.label}</h3>
                  <p className="mt-2 text-sm text-text-muted">
                    {report.metrics.length} measures · filter by {report.filters.join(', ')}
                  </p>
                  <div className="mt-4 space-y-3">
                    {report.metrics.map((metricKey) => {
                      const contract = catalog.metrics.find((metric) => metric.key === metricKey);
                      if (!contract) return null;
                      const drillThrough = metricDrillThroughHref(
                        metricKey,
                        contract.drillThrough,
                        focusBranch
                      );
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
                          <details className="mt-1">
                            <summary className="cursor-pointer py-1 text-xs font-medium text-text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                              Technical detail
                            </summary>
                            <dl className="mt-1 grid gap-1 font-mono text-[11px] text-text-body">
                              <div>
                                <dt className="inline font-semibold">Source: </dt>
                                <dd className="inline">{contract.source ?? 'Not available'}</dd>
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
                                <dt className="inline font-semibold">Permission: </dt>
                                <dd className="inline">{contract.permission}</dd>
                              </div>
                            </dl>
                          </details>
                          {drillThrough ? (
                            <Link
                              className="mt-2 inline-flex min-h-11 items-center text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              href={drillThrough}
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
              <SectionCard
                eyebrow="RPT-03 · Scheduled delivery"
                title="Daily owner digest"
                titleLevel={2}
              >
                <p className="text-sm text-text-muted">
                  Opt in per branch. Times use your workspace timezone. Capture history is always
                  stored; WhatsApp remains disabled until a provider integration is implemented.
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
            <SectionCard eyebrow="RPT-03 · Owner only" title="Daily owner digest" titleLevel={2}>
              <p className="text-sm text-text-muted">
                Digest settings and history require owner permission. Reports remain available on
                demand.
              </p>
            </SectionCard>
          )}
        </>
      ) : null}
    </main>
  );
}
