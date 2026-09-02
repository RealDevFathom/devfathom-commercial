import type { Metadata } from 'next';

import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { StatusPill } from '@/components/ui/status-pill';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Pharmacy reports' };

type SearchParams = Promise<Record<'branch' | 'from' | 'to', string | string[] | undefined>>;
const value = (input: string | string[] | undefined) =>
  typeof input === 'string' ? input : undefined;
const date = (input: string | undefined, fallback: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(input ?? '') ? input! : fallback;
const money = (minor: number | null) =>
  minor == null
    ? '—'
    : `PKR ${(minor / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default async function PharmacyReportsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const ctx = await createTRPCContext();
  const caller = pharmacyReportsRouter.createCaller(ctx);
  const branchResult = await caller.branches();
  const today = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(`${today}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 6);
  const from = date(value(query.from), fromDate.toISOString().slice(0, 10));
  const to = date(value(query.to), today);
  const branch = value(query.branch) || branchResult.branches[0]?.id;
  const result = branch ? await caller.commandCentre({ branchId: branch, from, to }) : null;
  const metrics = result?.metrics;
  const cards = metrics
    ? [
        ['Sales', money(metrics.salesMinor)],
        ['Gross margin', money(metrics.marginMinor)],
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
              defaultValue={branch}
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
      {result ? (
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
              {(await caller.catalog()).reports.map((report) => (
                <div
                  className="rounded-md border border-border-subtle bg-surface-raised p-4"
                  key={report.key}
                >
                  <h3 className="font-medium text-text-strong">{report.label}</h3>
                  <p className="mt-2 text-sm text-text-muted">
                    {report.metrics.length} metric contracts · filters: {report.filters.join(', ')}
                  </p>
                </div>
              ))}
            </div>
          </SectionCard>
        </>
      ) : (
        <SectionCard title="No reportable branches">
          <p className="text-sm text-text-muted">
            An active pharmacy branch is required before reports can be shown.
          </p>
        </SectionCard>
      )}
    </main>
  );
}
