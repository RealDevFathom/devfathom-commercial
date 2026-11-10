import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  const ctx = await createTRPCContext();
  const caller = pharmacyReportsRouter.createCaller(ctx);
  let comparison: Awaited<ReturnType<typeof caller.branchComparison>> | null = null;
  let errorMessage: string | null = null;
  let invalidRange = false;
  try {
    comparison = await caller.branchComparison({ from, to });
  } catch (error) {
    invalidRange = error instanceof TRPCError && error.code === 'BAD_REQUEST';
    errorMessage =
      error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code)
        ? 'Owner access and financial-report permission are required.'
        : invalidRange
          ? 'Check that the report dates are valid, then try again.'
          : 'The comparison could not be loaded. Try again or contact support if the problem continues.';
  }
  // Match the reports overview: the current tenant setting is not historical currency evidence.
  const organizationCurrency =
    ctx.organization && ctx.organization.id === ctx.entitlements.organizationId
      ? ctx.organization.currency
      : null;
  const currency =
    organizationCurrency && /^[A-Z]{3}$/.test(organizationCurrency) ? organizationCurrency : null;
  const money = (value: number | null) => {
    if (value == null || !Number.isSafeInteger(value)) return '—';
    const amount = formatMinor(value).replace(/\B(?=(\d{3})+\.)/g, ',');
    return currency ? `${currency} ${amount}` : `${amount} (currency unknown)`;
  };

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Owner only"
        heading="Branch comparison"
        description="Compare sales, margin, recorded lost-demand estimates, expiry exposure and overdue khata across active branches."
      />
      <SectionCard title="Comparison dates" titleLevel={2}>
        <form
          action="/pharmacy/reports/branch-comparison"
          method="get"
          aria-label="Branch comparison dates"
          className="flex flex-wrap items-end gap-4"
        >
          <label
            className="min-w-0 flex-1 basis-48 text-sm text-text-body"
            htmlFor="comparison-from"
          >
            From
            <Input
              id="comparison-from"
              name="from"
              type="date"
              defaultValue={from}
              required
              aria-invalid={invalidRange}
              aria-describedby={invalidRange ? 'comparison-date-error' : undefined}
              className="mt-1 min-h-11"
            />
          </label>
          <label className="min-w-0 flex-1 basis-48 text-sm text-text-body" htmlFor="comparison-to">
            To
            <Input
              id="comparison-to"
              name="to"
              type="date"
              defaultValue={to}
              required
              aria-invalid={invalidRange}
              aria-describedby={invalidRange ? 'comparison-date-error' : undefined}
              className="mt-1 min-h-11"
            />
          </label>
          <Button type="submit" size="touch">
            Apply dates
          </Button>
        </form>
      </SectionCard>
      {!comparison ? (
        <SectionCard title="Comparison unavailable">
          <p id="comparison-date-error" className="text-sm text-text-muted" role="alert">
            {errorMessage}
          </p>
        </SectionCard>
      ) : (
        <SectionCard title="Branch performance" titleLevel={2}>
          <p className="mb-4 text-sm text-text-muted">
            {from} to {to}, inclusive.{' '}
            {currency
              ? `Currency basis: current organization setting (${currency}); historical transaction currency is not verified.`
              : 'Currency unknown: an authoritative currency for this organization is unavailable; historical transaction currency is not verified.'}{' '}
            Money uses minor-unit values shown to two decimal places; — means unavailable, not zero.
            Expiry at risk is available stock expiring in 30 days and is not realized loss. Lost
            demand is an <strong>Estimate</strong>:{' '}
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
