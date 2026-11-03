import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { reportMoney } from '@/lib/pharmacy/report-presentation';
import { workspaceToday } from '@/lib/timezone';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Branch comparison · Pharmacy reports' };

export default async function BranchComparisonPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const query = await searchParams;
  const ctx = await createTRPCContext();
  const today = workspaceToday(ctx.organization?.timezone);
  const from = query.from ?? today;
  const to = query.to ?? today;
  const caller = pharmacyReportsRouter.createCaller(ctx);
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
    reportMoney(value, ctx.organization?.currency);

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Owner only"
        heading="Branch comparison"
        description="Compare sales, margin, recorded lost-demand estimates, expiry exposure and overdue khata across active branches."
      />
      {!comparison ? (
        <SectionCard title="Comparison unavailable">
          <p className="text-sm text-text-muted" role="alert">
            {errorMessage}
          </p>
        </SectionCard>
      ) : (
        <SectionCard title="Branch performance" titleLevel={2}>
          <p className="mb-4 text-sm text-text-muted">
            {from} to {to}, inclusive. Currency: {ctx.organization?.currency ?? 'not configured'} (organization setting). Amounts use two decimals. Expiry at risk is available stock expiring in 30
            days and is not realized loss. Lost demand is an <strong>Estimate</strong>:{' '}
            {comparison.estimateMethod} Excludes {comparison.estimateExclusions.join(' and ')}.
          </p>
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
                  <th className="p-3 text-right">Sales</th>
                  <th className="p-3 text-right">Margin</th>
                  <th className="p-3 text-right">Lost demand estimate</th>
                  <th className="p-3 text-right">Expiry at risk</th>
                  <th className="p-3 text-right">Khata overdue</th>
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
