import type { Metadata } from 'next';
import Link from 'next/link';
import { TRPCError } from '@trpc/server';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { createTRPCContext } from '@/server/trpc';
import { formatReportPeriod, reportsBackHref } from '../report-helpers';

export const metadata: Metadata = { title: 'Branch comparison · Pharmacy reports' };

export default async function BranchComparisonPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const query = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const from = query.from ?? today;
  const to = query.to ?? today;
  const ctx = await createTRPCContext();
  const caller = pharmacyReportsRouter.createCaller(ctx);
  // Same basis as the reports page: the authenticated organization's current currency setting.
  const organizationCurrency =
    ctx?.organization?.id && ctx.organization.id === ctx.entitlements?.organizationId
      ? ctx.organization.currency
      : null;
  const currency =
    organizationCurrency && /^[A-Z]{3}$/.test(organizationCurrency) ? organizationCurrency : null;
  const unit = currency ?? 'currency unknown';
  let comparison: Awaited<ReturnType<typeof caller.branchComparison>> | null = null;
  let errorMessage: string | null = null;
  try {
    comparison = await caller.branchComparison({ from, to });
  } catch (error) {
    errorMessage =
      error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code)
        ? 'Owner access and financial-report permission are required.'
        : error instanceof TRPCError && error.code === 'BAD_REQUEST'
          ? 'Check that the report dates are valid, then try again.'
          : 'The comparison could not be loaded. Try again or contact support if the problem continues.';
  }
  const money = (value: number | null) =>
    value == null ? '—' : formatMinor(value).replace(/\B(?=(\d{3})+\.)/g, ',');

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Owner only"
        heading="Branch comparison"
        description="Compare sales, margin, recorded lost-demand estimates, expiry exposure and overdue khata across active branches."
      />
      <Link
        href={reportsBackHref({ from, to })}
        className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        Back to reports
      </Link>
      {!comparison ? (
        <SectionCard title="Comparison unavailable">
          <p className="text-sm text-text-muted" role="alert">
            {errorMessage}
          </p>
        </SectionCard>
      ) : (
        <SectionCard title="Branch performance" titleLevel={2}>
          <p className="text-sm text-text-body">
            Figures cover {formatReportPeriod(from, to)} (inclusive) ·{' '}
            {currency ? `Amounts in ${currency}` : 'Currency unknown'}
          </p>
          <details className="mb-4 text-sm">
            <summary className="min-h-11 cursor-pointer py-3 font-medium text-text-body focus-visible:outline-2 focus-visible:outline-ring">
              How these figures are calculated
            </summary>
            <p className="text-text-muted">
              Sales, margin and lost demand cover {from} to {to}, inclusive. Expiry at risk and
              khata overdue are as of now. Money uses minor-unit values shown to two decimal places,
              in the organization&apos;s current currency setting
              {currency ? ` (${currency})` : ''}; historical transaction currency is not verified.
              Expiry at risk is available stock expiring in 30 days and is not realized loss. Lost
              demand is an <strong>Estimate</strong>: {comparison.estimateMethod} Excludes{' '}
              {comparison.estimateExclusions.join(' and ')}.
            </p>
          </details>
          <div
            role="region"
            aria-label="Branch performance"
            tabIndex={0}
            className="overflow-x-auto rounded-md border border-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full min-w-[760px] text-sm tabular-nums">
              <thead className="bg-surface-sunken font-mono text-xs uppercase text-text-muted">
                <tr>
                  <th className="p-3 text-left">Branch</th>
                  <th className="p-3 text-right">
                    Sales <span className="normal-case">({unit})</span>
                  </th>
                  <th className="p-3 text-right">
                    Margin <span className="normal-case">({unit})</span>
                  </th>
                  <th className="p-3 text-right">
                    Lost demand estimate <span className="normal-case">({unit})</span>
                  </th>
                  <th className="p-3 text-right">
                    Expiry at risk <span className="normal-case">({unit})</span>
                  </th>
                  <th className="p-3 text-right">
                    Khata overdue <span className="normal-case">({unit})</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {comparison.rows.map((row) => (
                  <tr className="hover:bg-surface-sunken" key={row.branchId}>
                    <th className="p-3 text-left font-medium text-text-strong">{row.branchName}</th>
                    <td className="p-3 text-right">{money(row.salesMinor)}</td>
                    <td className="p-3 text-right">{money(row.marginMinor)}</td>
                    <td className="p-3 text-right">
                      {money(row.lostDemandEstimateMinor)} ({row.lostDemandRecordedEvents} events)
                    </td>
                    <td className="p-3 text-right">{money(row.expiryAtRiskMinor)}</td>
                    <td className="p-3 text-right">{money(row.khataAgingMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!comparison.rows.length ? (
            <p className="mt-4 text-sm text-text-muted">No active branches are available.</p>
          ) : null}
        </SectionCard>
      )}
    </main>
  );
}
