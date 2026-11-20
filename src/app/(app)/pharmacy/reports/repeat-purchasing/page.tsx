import { SelectField as StudioSelect } from '@/components/ui/select-field';import type { Metadata } from 'next';
import Link from 'next/link';
import { TRPCError } from '@trpc/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { REPEAT_DEFINITION, REPEAT_LIMITS } from '@/lib/pharmacy/repeat-purchasing';
import {
  formatWorkspaceDateTime,
  workspaceInstantFromInput,
  workspaceMinuteInput,
  workspaceZoneLabel,
} from '@/lib/timezone';
import { pharmacyCalendarDayOffset } from '@/lib/pharmacy/business-day';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Repeat purchasing · Pharmacy reports' };
const percent = (n: number | null) => (n === null ? 'Unavailable' : `${n.toFixed(1)}%`);
const scalar = (s: string | string[] | undefined) => (typeof s === 'string' ? s : undefined);

export default async function RepeatPurchasingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const now = new Date();
  const ctx = await createTRPCContext();
  const timeZone = ctx.organization?.timezone;
  const zone = workspaceZoneLabel(timeZone);
  const rawAsOf = scalar(query.asOf);
  // The picker is minute precision and read on the organization's clock; default
  // to the current minute so the frozen cutoff round-trips through the form.
  const asOf = rawAsOf
    ? workspaceInstantFromInput(rawAsOf, timeZone)
    : `${now.toISOString().slice(0, 16)}:00Z`;
  const from = scalar(query.from) ?? pharmacyCalendarDayOffset(timeZone, -179, now);
  const to = scalar(query.to) ?? pharmacyCalendarDayOffset(timeZone, -90, now);
  const branchId = scalar(query.branch);
  let branches: { id: string; name: string }[] = [];
  let result: Awaited<
    ReturnType<ReturnType<typeof pharmacyReportsRouter.createCaller>['repeatPurchasing']>
  > | null = null;
  let error: string | null = null;
  try {
    const caller = pharmacyReportsRouter.createCaller(ctx);
    branches = (await caller.branches()).branches;
    result = await caller.repeatPurchasing({ from, to, asOf, ...(branchId ? { branchId } : {}) });
  } catch (cause) {
    result = null;
    error =
      cause instanceof TRPCError && cause.code === 'FORBIDDEN'
        ? 'Owner financial-report access, an enabled pharmacy reports module and an authorized active branch are required. Contact your workspace administrator.'
        : cause instanceof TRPCError && cause.code === 'BAD_REQUEST'
          ? 'Check the enrollment dates (maximum 90 days) and a cutoff that is not in the future, then apply again.'
          : 'Report unavailable. The complete report could not be generated. Retry or select a single branch using the filters; no partial rates are shown.';
  }
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy reports"
        heading="Repeat purchasing"
        description="First-observed commercial customer cohorts in selected authorized branches."
      />
      <Link
        className="text-sm underline focus-visible:outline-2 focus-visible:outline-ring"
        href="/pharmacy/reports"
      >
        Back to reports
      </Link>
      <SectionCard title="Enrollment and observation" titleLevel={2}>
        <form className="grid gap-4 md:grid-cols-2" action="/pharmacy/reports/repeat-purchasing">
          <label className="text-sm text-text-body">
            Enrollment from ({zone})
            <Input className="mt-1 min-h-11" type="date" name="from" defaultValue={from} required />
          </label>
          <label className="text-sm text-text-body">
            Enrollment through ({zone})
            <Input className="mt-1 min-h-11" type="date" name="to" defaultValue={to} required />
          </label>
          <label className="text-sm text-text-body">
            As-of cutoff ({zone})
            <Input
              className="mt-1 min-h-11"
              type="datetime-local"
              name="asOf"
              defaultValue={workspaceMinuteInput(asOf, timeZone)}
              required
              aria-describedby="repeat-window-help"
            />
          </label>
          <label className="text-sm text-text-body">
            Selected authorized branches
            <StudioSelect
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
            </StudioSelect>
          </label>
          <p id="repeat-window-help" className="text-sm text-text-muted md:col-span-2">
            Up to 90 inclusive enrollment days. Cutoff stays fixed when filters change. Today is
            included only through that instant. Item and supplier filters do not apply to person
            cohorts.
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
              cutoff: {formatWorkspaceDateTime(result.asOf, timeZone)}.
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
              {result.earliestObservedAt
                ? formatWorkspaceDateTime(result.earliestObservedAt, timeZone)
                : 'Unavailable'}
              . This is not a verified data-start date.
            </p>
          </SectionCard>
        </>
      ) : null}
      <SectionCard title="Definition and limits" titleLevel={2}>
        <p className="text-sm text-text-body">{REPEAT_DEFINITION}</p>
        <p className="mt-3 text-sm text-text-muted">{REPEAT_LIMITS}</p>
      </SectionCard>
    </div>
  );
}
