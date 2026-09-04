import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy reports' };

type SearchParams = Promise<
  Partial<
    Record<
      'branch' | 'from' | 'to' | 'supplier' | 'ingredient' | 'batch' | 'digest',
      string | string[] | undefined
    >
  >
>;
const value = (input: string | string[] | undefined) =>
  typeof input === 'string' ? input : undefined;
const date = (input: string | undefined, fallback: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(input ?? '') ? input! : fallback;
const money = (minor: number | null) =>
  minor == null
    ? '—'
    : `PKR ${(minor / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

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
  const today = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(`${today}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 6);
  const from = date(value(query.from), fromDate.toISOString().slice(0, 10));
  const to = date(value(query.to), today);
  const branch = value(query.branch);
  const supplier = value(query.supplier);
  const ingredient = value(query.ingredient);
  const batch = value(query.batch);
  let result: Awaited<ReturnType<typeof caller.commandCentre>> | null = null;
  let digest: Awaited<ReturnType<typeof caller.digestOverview>> | null = null;
  let reportError = false;
  const [reportResult, digestResult] = await Promise.allSettled([
    caller.commandCentre({
      ...(branch ? { branchId: branch } : {}),
      ...(supplier ? { supplierId: supplier } : {}),
      ...(ingredient ? { ingredientId: ingredient } : {}),
      ...(batch ? { batchId: batch } : {}),
      from,
      to,
    }),
    caller.digestOverview(),
  ]);
  if (reportResult.status === 'fulfilled') result = reportResult.value;
  else reportError = true;
  if (digestResult.status === 'fulfilled') digest = digestResult.value;
  const digestMessage = value(query.digest);

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
  const metrics = result?.metrics;
  const cards = metrics
    ? [
        ['Sales', money(metrics.salesMinor)],
        ['Gross margin', money(metrics.marginMinor)],
        ['Cash', money(metrics.cashMinor)],
        ['Cash variance', money(metrics.cashVarianceMinor)],
        ['Refunds', money(metrics.refundsMinor)],
        ['Open stock signals', metrics.openStockSignals],
        ['Recommended orders', metrics.recommendedOrders],
        ['Expiry ≤30d', money(metrics.expiryValueMinor30)],
        ['Expiry ≤90d', money(metrics.expiryValueMinor90)],
      ]
    : [];
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy operations"
        heading="Reports"
        description="Bounded, permission-scoped command centre and report catalog. Values are ledger-derived and freshness-labelled."
      />
      <SectionCard eyebrow="RPT-01 / RPT-02" title="Report filters" titleLevel={2}>
        <form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" method="get">
          <label className="text-sm text-text-body">
            Branch
            <select
              className="mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-2.5 text-sm"
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
          <label className="text-sm text-text-body">
            Supplier ID
            <Input className="mt-1 min-h-11" defaultValue={supplier} name="supplier" />
          </label>
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
            <Input className="mt-1 min-h-11" defaultValue={from} name="from" type="date" />
          </label>
          <label className="text-sm text-text-body">
            To
            <Input className="mt-1 min-h-11" defaultValue={to} name="to" type="date" />
          </label>
          <button
            className="min-h-11 self-end rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            type="submit"
          >
            Apply filters
          </button>
        </form>
      </SectionCard>
      {reportError ? (
        <ReportNotice
          title="Report could not load"
          detail="Check the date range and branch scope, then apply the filters again. No data was changed."
        />
      ) : result ? (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm text-text-muted">
            <StatusPill status="Current" tone="success" />
            <span>As of {new Date(result.freshness.asOf).toLocaleString()}</span>
          </div>
          <SectionCard eyebrow="Owner command centre" title="Today at a glance" titleLevel={2}>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {cards.map(([label, figure]) => (
                <Stat
                  key={label}
                  label={label}
                  value={figure}
                  sub="Selected branch · ledger source"
                />
              ))}
            </div>
          </SectionCard>
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
                            {contract.label}
                          </h4>
                          <p className="mt-1 text-xs leading-5 text-text-muted">
                            {contract.definition}
                          </p>
                          <dl className="mt-2 grid gap-1 font-mono text-[11px] text-text-body">
                            <div>
                              <dt className="inline font-semibold">Source: </dt>
                              <dd className="inline">{contract.source ?? 'Not available'}</dd>
                            </div>
                            <div>
                              <dt className="inline font-semibold">Scope: </dt>
                              <dd className="inline">{contract.scope}</dd>
                            </div>
                            <div>
                              <dt className="inline font-semibold">Permission: </dt>
                              <dd className="inline">{contract.permission}</dd>
                            </div>
                          </dl>
                          {contract.drillThrough ? (
                            <Link
                              className="mt-2 inline-flex text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              href={contract.drillThrough}
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
      ) : branchResult.branches.length === 0 ? (
        <ReportNotice
          title="No reportable branches"
          detail="An active pharmacy branch is required before reports can be shown. Ask your workspace administrator to activate one."
        />
      ) : null}
    </main>
  );
}
