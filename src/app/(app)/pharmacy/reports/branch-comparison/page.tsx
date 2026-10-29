import type { Metadata } from 'next';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { createTRPCContext } from '@/server/trpc';

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
  const caller = pharmacyReportsRouter.createCaller(await createTRPCContext());
  let comparison: Awaited<ReturnType<typeof caller.branchComparison>> | null = null;
  try {
    comparison = await caller.branchComparison({ from, to });
  } catch {
    // The same state intentionally covers non-owners without disclosing financial availability.
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
      {!comparison ? (
        <SectionCard title="Comparison unavailable">
          <p className="text-sm text-text-muted" role="alert">
            Owner access and financial-report permission are required.
          </p>
        </SectionCard>
      ) : (
        <SectionCard title="Branch performance" titleLevel={2}>
          <p className="mb-4 text-sm text-text-muted">
            {from} to {to}, inclusive. Money uses minor-unit values shown to two decimal places; the
            organization currency is not asserted. Expiry at risk is available stock expiring in 30
            days and is not realized loss. Lost demand is an <strong>Estimate</strong>:{' '}
            {comparison.estimateMethod} Excludes {comparison.estimateExclusions.join(' and ')}.
          </p>
          <div className="overflow-x-auto rounded-md border border-border-subtle">
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
