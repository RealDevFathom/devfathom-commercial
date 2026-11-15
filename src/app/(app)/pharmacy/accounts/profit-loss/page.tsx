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
import { formatUtcInstant } from '@/lib/utc-instant';
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
  const from =
    scalar(query.from) ?? new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const to = scalar(query.to) ?? new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  let branchId = scalar(query.branch);
  let branches: { id: string; name: string }[] = [];
  let result: Awaited<
    ReturnType<ReturnType<typeof pharmacyFinanceRouter.createCaller>['financialStatements']>
  > | null = null;
  let error: string | null = null;
  try {
    const ctx = await createTRPCContext();
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
      result = await pharmacyFinanceRouter.createCaller(ctx).financialStatements({
        branchId,
        from: `${from}T00:00:00Z`,
        to: `${to}T00:00:00Z`,
        page: 1,
      });
    }
  } catch (cause) {
    error =
      cause instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND'].includes(cause.code)
        ? 'Owner financial-report permission, Pharmacy Reports access and an authorized active branch are required.'
        : cause instanceof TRPCError && cause.code === 'BAD_REQUEST'
          ? 'Choose one branch and a valid UTC date window of up to 92 days, with the exclusive end after the start, then retry.'
          : 'Profit and loss could not be read. Retry the report.';
  }
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Profit and loss"
        description="Posted-ledger result by recorded currency, before unrecorded tax and other sources."
      />
      <Link
        className="text-sm underline focus-visible:outline-2 focus-visible:outline-ring"
        href="/pharmacy/reports"
      >
        Back to reports
      </Link>
      <SectionCard title="Branch and posting window">
        <form action="/pharmacy/accounts/profit-loss" className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-0 max-w-full gap-2 text-sm">
            Branch
            <select
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
            </select>
          </label>
          <label className="grid gap-2 text-sm">
            From (UTC)
            <Input className="min-h-11" name="from" type="date" defaultValue={from} required />
          </label>
          <label className="grid gap-2 text-sm">
            To, exclusive (UTC)
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
            {formatUtcInstant(result.from)} to {formatUtcInstant(result.to)} (end exclusive).
            Source: {plainReportSource(result.source) ?? 'posted accounts'}. Coverage: posted
            entries only; completeness and cost coverage unknown. Amounts use each recorded
            currency. Retrieved {formatUtcInstant(result.freshness.retrievedAt)}.
          </p>
          <ProfitAndLossReport statements={result.profitAndLoss} />
        </SectionCard>
      )}
    </main>
  );
}
