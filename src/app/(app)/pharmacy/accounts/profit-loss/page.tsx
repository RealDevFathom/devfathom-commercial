import { operationalReportsHref } from '@/lib/pharmacy/operational-reports-href';
import { SelectField as StudioSelect } from '@/components/ui/select-field';
import type { Metadata } from 'next';
import Link from 'next/link';
import { TRPCError } from '@trpc/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { createTRPCContext } from '@/server/trpc';
import { ProfitAndLossReport } from './report';
import { formatWorkspaceDateTime, workspaceZoneLabel } from '@/lib/timezone';
import { pharmacyCalendarDayOffset, pharmacyCalendarDayRange } from '@/lib/pharmacy/business-day';
import { plainReportSource } from '@/lib/pharmacy/report-labels';

export const metadata: Metadata = { title: 'Profit and loss · Pharmacy accounts' };
const scalar = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

export default async function ProfitAndLossPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const now = new Date();
  // The organization zone is known once the context resolves; until then (or if it fails) the
  // default window is counted on the UTC clock.
  let timeZone: string | null | undefined;
  const fromQuery = scalar(query.from);
  const toQuery = scalar(query.to);
  const defaults = () => ({
    from: fromQuery ?? pharmacyCalendarDayOffset(timeZone, -30, now),
    to: toQuery ?? pharmacyCalendarDayOffset(timeZone, 1, now),
  });
  let branchId = scalar(query.branch);
  let branches: { id: string; name: string }[] = [];
  let result: Awaited<
    ReturnType<ReturnType<typeof pharmacyFinanceRouter.createCaller>['financialStatements']>
  > | null = null;
  let error: string | null = null;
  try {
    const ctx = await createTRPCContext();
    timeZone = ctx.organization?.timezone ?? 'UTC';
    branches = (await pharmacyReportsRouter.createCaller(ctx).branches()).branches;
    if ([query.branch, query.from, query.to].some(Array.isArray)) {
      throw new TRPCError({ code: 'BAD_REQUEST' });
    }
    branchId ??= branches[0]?.id;
    if (branchId === undefined) {
      error = 'Create an active pharmacy branch before reading this report.';
    } else {
      // The report caller enforces admin, reports licensing/capabilities, tenant,
      // active branch and UTC period validation. No bookkeeping workspace call.
      const picked = defaults();
      // `to` is exclusive: the start of that day on the organization's clock.
      const window = {
        from: pharmacyCalendarDayRange(picked.from, picked.from, timeZone).from,
        to: pharmacyCalendarDayRange(picked.to, picked.to, timeZone).from,
      };
      result = await pharmacyFinanceRouter.createCaller(ctx).financialStatements({
        branchId,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        page: 1,
      });
    }
  } catch (cause) {
    error =
      cause instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND'].includes(cause.code)
        ? 'Owner financial-report permission, Pharmacy Reports access and an authorized active branch are required.'
        : cause instanceof TRPCError && cause.code === 'BAD_REQUEST'
          ? 'Choose one branch and a valid date window of up to 92 days, with the exclusive end after the start, then retry.'
          : 'Profit and loss could not be read. Retry the report.';
  }
  const { from, to } = defaults();
  const zone = timeZone ? workspaceZoneLabel(timeZone) : 'workspace timezone';
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Profit and loss"
        description="Posted-ledger result by recorded currency, before unrecorded tax and other sources."
      />
      <Link
        className="text-sm underline focus-visible:outline-2 focus-visible:outline-ring"
        href={operationalReportsHref(query)}
      >
        Back to reports
      </Link>
      <SectionCard title="Branch and posting window">
        <form action="/pharmacy/accounts/profit-loss" className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-0 max-w-full gap-2 text-sm">
            Branch
            <StudioSelect
              name="branch"
              defaultValue={branchId ?? ''}
              required
              disabled={!branches.length}
              className="min-h-11 w-full max-w-full rounded-sm border border-border-default bg-surface-raised px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
            >
              {!branches.length && <option value="">No available branches</option>}
              {branchId !== undefined && !branches.some((branch) => branch.id === branchId) && (
                <option value={branchId}>Requested branch (scope unverified)</option>
              )}
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </StudioSelect>
          </label>
          <label className="grid gap-2 text-sm">
            From ({zone})
            <Input className="min-h-11" name="from" type="date" defaultValue={from} required />
          </label>
          <label className="grid gap-2 text-sm">
            To, exclusive ({zone})
            <Input className="min-h-11" name="to" type="date" defaultValue={to} required />
          </label>
          <Button className="min-h-11" disabled={!branches.length}>
            Read profit and loss
          </Button>
        </form>
      </SectionCard>
      {error && (
        <SectionCard title="Report unavailable">
          <p role="alert" className="text-sm text-text-muted">
            {error}
          </p>
        </SectionCard>
      )}
      {result && (
        <SectionCard title="Posted profit and loss">
          <p className="break-words text-sm text-text-muted">
            {formatWorkspaceDateTime(result.from, timeZone)} to{' '}
            {formatWorkspaceDateTime(result.to, timeZone)} (end exclusive). Source:{' '}
            {plainReportSource(result.source) ?? 'posted accounts'}. Coverage: posted entries only;
            completeness and cost coverage unknown. Amounts use each recorded currency. Retrieved{' '}
            {formatWorkspaceDateTime(result.freshness.retrievedAt, timeZone)}.
          </p>
          <ProfitAndLossReport statements={result.profitAndLoss} />
        </SectionCard>
      )}
    </div>
  );
}
