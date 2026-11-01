import type { Metadata } from 'next';
import Link from 'next/link';
import { TRPCError } from '@trpc/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { REPEAT_DEFINITION, REPEAT_LIMITS } from '@/lib/pharmacy/repeat-purchasing';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { createTRPCContext } from '@/server/trpc';
import {
  defaultRepeatWindow,
  formatReportTimestamp,
  pickerValueFromInstant,
  reportsBackHref,
  utcInstantFromPicker,
} from '../report-helpers';

export const metadata: Metadata = { title: 'Repeat purchasing · Pharmacy reports' };
const percent = (n: number | null) => (n === null ? 'Unavailable' : `${n.toFixed(1)}%`);
const scalar = (s: string | string[] | undefined) => (typeof s === 'string' ? s : undefined);

export default async function RepeatPurchasingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  // Default to the last 90 days ending today; the picker submits a UTC wall-clock cutoff.
  const defaults = defaultRepeatWindow(new Date());
  const requestedAsOf = scalar(query.asOf);
  const asOf = requestedAsOf ? utcInstantFromPicker(requestedAsOf) : defaults.asOf;
  const from = scalar(query.from) ?? defaults.from;
  const to = scalar(query.to) ?? defaults.to;
  const branchId = scalar(query.branch);
  let branches: { id: string; name: string }[] = [];
  let result: Awaited<
    ReturnType<ReturnType<typeof pharmacyReportsRouter.createCaller>['repeatPurchasing']>
  > | null = null;
  let error: string | null = null;
  try {
    const caller = pharmacyReportsRouter.createCaller(await createTRPCContext());
    branches = (await caller.branches()).branches;
    result = await caller.repeatPurchasing({ from, to, asOf, ...(branchId ? { branchId } : {}) });
  } catch (cause) {
    result = null;
    error =
      cause instanceof TRPCError && cause.code === 'FORBIDDEN'
        ? 'Owner financial-report access, an enabled pharmacy reports module and an authorized active branch are required. Contact your workspace administrator.'
        : cause instanceof TRPCError && cause.code === 'BAD_REQUEST'
          ? 'Check the enrollment dates (maximum 90 days, ending on or before the cutoff) and choose a cutoff that is not in the future, then apply again.'
          : 'Report unavailable. The complete report could not be generated. Retry or select a single branch using the filters; no partial rates are shown.';
  }
  const soleBranch = branches.length === 1 ? branches[0] : undefined;
  const showBranchName = !!soleBranch && (!branchId || branchId === soleBranch.id);
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy reports"
        heading="Repeat purchasing"
        description="First-observed commercial customer cohorts in selected authorized branches."
      />
      <Link
        className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-2 focus-visible:outline-ring"
        href={reportsBackHref({ branch: branchId })}
      >
        Back to reports
      </Link>
      <SectionCard title="Enrollment and observation" titleLevel={2}>
        <form className="grid gap-4 md:grid-cols-2" action="/pharmacy/reports/repeat-purchasing">
          <label className="text-sm text-text-body">
            Enrollment from (UTC)
            <Input className="mt-1 min-h-11" type="date" name="from" defaultValue={from} required />
          </label>
          <label className="text-sm text-text-body">
            Enrollment through (UTC)
            <Input className="mt-1 min-h-11" type="date" name="to" defaultValue={to} required />
          </label>
          <label className="text-sm text-text-body">
            As-of cutoff (UTC)
            <Input
              className="mt-1 min-h-11"
              name="asOf"
              type="datetime-local"
              defaultValue={pickerValueFromInstant(asOf)}
              required
              aria-describedby="repeat-window-help"
            />
          </label>
          {soleBranch && showBranchName ? (
            <div className="text-sm text-text-body">
              <span>Branch</span>
              <p className="mt-1 flex min-h-11 items-center font-medium text-text-strong">
                {soleBranch.name}
              </p>
            </div>
          ) : (
            <label className="text-sm text-text-body">
              Selected authorized branches
              <select
                name="branch"
                defaultValue={branchId ?? ''}
                className="mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-ring"
              >
                <option value="">All authorized active branches</option>
                {branchId && !branches.some((b) => b.id === branchId) ? (
                  <option value={branchId}>Requested branch (scope unverified)</option>
                ) : null}
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p id="repeat-window-help" className="text-sm text-text-muted md:col-span-2">
            Up to 90 inclusive enrollment days, ending on or before the cutoff. Customers first seen
            recently have not had 30, 60 or 90 days to come back yet, so those rates fill in as time
            passes. The cutoff stays fixed when filters change. Item and supplier filters do not
            apply to person cohorts.
          </p>
          <Button type="submit" className="min-h-11">
            Apply cohort window
          </Button>
        </form>
      </SectionCard>
      {error ? (
        <SectionCard title="Repeat report unavailable" titleLevel={2}>
          <p role="alert" className="text-sm text-text-muted">
            {error}
          </p>
        </SectionCard>
      ) : null}
      {result ? (
        <>
          <SectionCard title="Identity coverage" titleLevel={2}>
            <p className="mb-4 text-sm text-text-muted">
              Completed original receipts in enrollment window, before purchase exclusions. Frozen
              cutoff: {formatReportTimestamp(result.asOf)}.
            </p>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Identified receipt coverage"
                value={percent(result.identificationCoveragePercent)}
              />
              <Stat label="Completed receipts" value={result.completedReceipts} />
              <Stat label="Identified receipts" value={result.identifiedReceipts} />
              <Stat label="Anonymous receipts" value={result.anonymousReceipts} />
            </div>
          </SectionCard>
          <SectionCard title="Fully elapsed follow-up" titleLevel={2}>
            {result.enrolledCustomers === 0 ? (
              <p className="mb-4 text-sm text-text-muted">
                No identified customers first observed in this enrollment window. Rates are
                unavailable; adjust the window or branch scope.
              </p>
            ) : null}
            <div className="grid gap-6 lg:grid-cols-3">
              {result.horizons.map((h) => (
                <Stat
                  key={h.days}
                  label={`${h.days}-day repeat purchasing`}
                  value={percent(h.ratePercent)}
                  sub={`${h.repeated} repeat / ${h.eligible} eligible customers · ${h.immature} immature, excluded from denominator`}
                />
              ))}
            </div>
            <p className="mt-4 text-sm text-text-muted">
              {result.enrolledCustomers} enrolled customers. {result.firstObservedBeforeEnrollment}{' '}
              identified customers first observed before enrollment, excluded.{' '}
              {result.excludedPurchases} receipts in enrollment excluded for missing receipt
              identity or purchase qualification.
            </p>
          </SectionCard>
          <SectionCard title="Observation gaps" titleLevel={2}>
            <p className="text-sm text-text-muted">
              Across all selected data through cutoff: {result.missingTimestamp} completed originals
              missing completion timestamps; {result.missingReceipt} timestamped originals missing
              receipt numbers. Earliest available completion:{' '}
              {formatReportTimestamp(result.earliestObservedAt)}. This is not a verified data-start
              date.
            </p>
          </SectionCard>
        </>
      ) : null}
      <SectionCard title="Definition and limits" titleLevel={2}>
        <p className="text-sm text-text-body">{REPEAT_DEFINITION}</p>
        <p className="mt-3 text-sm text-text-muted">{REPEAT_LIMITS}</p>
      </SectionCard>
    </main>
  );
}
