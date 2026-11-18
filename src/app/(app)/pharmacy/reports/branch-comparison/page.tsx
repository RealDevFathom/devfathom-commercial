import { SHOP_SCREEN_COPY as screenCopy } from '@/lib/pharmacy/plain-language';
import { ReportDetails } from '@/components/pharmacy/report-details';
import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { workspaceToday } from '@/lib/timezone';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = {
  title: screenCopy.branchComparison.branchComparisonPharmacyReports,
};

export default async function BranchComparisonPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const query = await searchParams;
  const ctx = await createTRPCContext();
  // The owner's business day, not the UTC one (00:00–04:59 PKT is still "today").
  const today = workspaceToday(ctx.organization?.timezone);
  const from = query.from ?? today;
  const to = query.to ?? today;
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
    return currency ? `${currency} ${amount}` : `${amount} (currency not confirmed)`;
  };

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow={screenCopy.branchComparison.ownerOnly}
        heading={screenCopy.branchComparison.branchComparison}
        description={
          screenCopy.branchComparison.compareSalesMarginRecordedLostDemandEstimatesExpiry
        }
      />
      <SectionCard title={screenCopy.branchComparison.comparisonDates} titleLevel={2}>
        <form
          action="/pharmacy/reports/branch-comparison"
          method="get"
          aria-label={screenCopy.branchComparison.branchComparisonDates}
          className="flex flex-wrap items-end gap-4"
        >
          <label
            className="min-w-0 flex-1 basis-48 text-sm text-text-body"
            htmlFor="comparison-from"
          >
            {screenCopy.branchComparison.from}
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
            {screenCopy.branchComparison.to}
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
            {screenCopy.branchComparison.applyDates}
          </Button>
        </form>
      </SectionCard>
      {!comparison ? (
        <SectionCard title={screenCopy.branchComparison.comparisonUnavailable}>
          <p id="comparison-date-error" className="text-sm text-text-muted" role="alert">
            {errorMessage}
          </p>
        </SectionCard>
      ) : (
        <SectionCard title={screenCopy.branchComparison.branchPerformance} titleLevel={2}>
          <ReportDetails>
            <p className="mb-4 text-sm text-text-muted">
              {from}
              {screenCopy.branchComparison.to2}
              {to}
              {screenCopy.branchComparison.inclusive}{' '}
              {currency
                ? `Currency basis: current organization setting (${currency}); historical transaction currency is not verified.`
                : 'Currency unknown: an authoritative currency for this organization is unavailable; historical transaction currency is not verified.'}{' '}
              {screenCopy.branchComparison.moneyUsesMinorUnitValuesShownToTwo}
              <strong>{screenCopy.branchComparison.estimate}</strong>: {comparison.estimateMethod}
              {screenCopy.branchComparison.excludes} {comparison.estimateExclusions.join(' and ')}.
            </p>
          </ReportDetails>
          <div
            role="region"
            aria-label={screenCopy.branchComparison.branchPerformance}
            tabIndex={0}
            className="overflow-x-auto rounded-md border border-border-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full min-w-[760px] text-sm tabular-nums">
              <thead className="bg-surface-sunken font-mono text-xs uppercase text-text-muted">
                <tr>
                  <th className="p-3 text-left">{screenCopy.branchComparison.branch}</th>
                  <th className="p-3 text-right">{screenCopy.branchComparison.sales}</th>
                  <th className="p-3 text-right">{screenCopy.branchComparison.margin}</th>
                  <th className="p-3 text-right">
                    {screenCopy.branchComparison.lostDemandEstimate}
                  </th>
                  <th className="p-3 text-right">{screenCopy.branchComparison.expiryAtRisk}</th>
                  <th className="p-3 text-right">{screenCopy.branchComparison.khataOverdue}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {comparison.rows.map((row) => (
                  <tr className="hover:bg-surface-sunken" key={row.branchId}>
                    <th className="p-3 text-left font-medium text-text-strong">{row.branchName}</th>
                    <td className="p-3 text-right">{money(row.salesMinor)}</td>
                    <td className="p-3 text-right">{money(row.marginMinor)}</td>
                    <td className="p-3 text-right">
                      {money(row.lostDemandEstimateMinor)} ({row.lostDemandRecordedEvents}
                      {screenCopy.branchComparison.events}
                    </td>
                    <td className="p-3 text-right">{money(row.expiryAtRiskMinor)}</td>
                    <td className="p-3 text-right">{money(row.khataAgingMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!comparison.rows.length ? (
            <p className="mt-4 text-sm text-text-muted">
              {screenCopy.branchComparison.noActiveBranchesAreAvailable}
            </p>
          ) : null}
        </SectionCard>
      )}
    </div>
  );
}
