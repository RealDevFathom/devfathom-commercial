import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { cn } from '@/lib/utils';
import { liquidityKpiCsv, projectLiquidityKpi } from '@/lib/pharmacy/accounts/liquidity-kpi';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Posted cash coverage · Pharmacy accounts' };
const ROUTE = '/pharmacy/accounts/liquidity-kpi';
const scalar = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;
const validDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
type Query = Partial<Record<'branch' | 'from' | 'to', string | string[]>>;

export default async function LiquidityKpiPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const now = new Date();
  const branchId = scalar(query.branch)?.trim() ?? '';
  const from =
    query.from === undefined
      ? new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
      : (scalar(query.from) ?? '');
  const to =
    query.to === undefined
      ? new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)
      : (scalar(query.to) ?? '');
  let result: Awaited<
    ReturnType<ReturnType<typeof pharmacyFinanceRouter.createCaller>['financialStatements']>
  > | null = null;
  let error: string | null = null;

  const fromInstant = validDate(from) ? new Date(`${from}T00:00:00.000Z`) : null;
  const toInstant = validDate(to) ? new Date(`${to}T00:00:00.000Z`) : null;
  const duration = fromInstant && toInstant ? toInstant.getTime() - fromInstant.getTime() : 0;
  const validWindow = duration > 0 && duration <= 92 * 86_400_000;
  if (!branchId) {
    error = 'Enter an explicit active branch ID. This report never falls back to another branch.';
  } else if (!fromInstant || !toInstant || !validWindow) {
    error = 'Choose valid UTC dates forming a half-open window of no more than 92 days.';
  } else {
    try {
      const caller = pharmacyFinanceRouter.createCaller(await createTRPCContext());
      result = await caller.financialStatements({
        branchId,
        from: fromInstant.toISOString(),
        to: toInstant.toISOString(),
        page: 1,
      });
    } catch (cause) {
      error =
        cause instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(cause.code)
          ? 'ADMIN plus authorized operational and financial Reports access, the Pharmacy Reports module, and an explicit active branch are required.'
          : cause instanceof TRPCError && cause.code === 'BAD_REQUEST'
            ? 'Choose valid UTC dates forming a half-open window of no more than 92 days.'
            : 'Posted cash coverage could not be read. No financial evidence is available to export; retry.';
    }
  }

  const report = result ? projectLiquidityKpi(result.accounts) : null;
  const csv = report ? liquidityKpiCsv(report) : null;
  const href = csv ? `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${csv}`)}` : null;

  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Posted cash coverage"
        description="Recorded CASH and BANK compared with recorded payables and goods-received accrual, independently by currency."
      />
      <SectionCard title="Report scope" titleLevel={2}>
        <form action={ROUTE} className="grid gap-4 md:grid-cols-3">
          <label className="text-sm text-text-body">
            Active branch ID
            <Input className="mt-1 min-h-11" name="branch" defaultValue={branchId} required />
          </label>
          <label className="text-sm text-text-body">
            From (UTC)
            <Input className="mt-1 min-h-11" type="date" name="from" defaultValue={from} required />
          </label>
          <label className="text-sm text-text-body">
            To, exclusive (UTC)
            <Input className="mt-1 min-h-11" type="date" name="to" defaultValue={to} required />
          </label>
          <p className="text-sm text-text-muted md:col-span-3">
            The supported window is half-open [from, to) and at most 92 days. An invalid or inactive
            branch is denied; another branch is never substituted.
          </p>
          <Button type="submit" className="min-h-11">
            Read posted coverage
          </Button>
        </form>
      </SectionCard>

      {error ? (
        <SectionCard title="Report unavailable" titleLevel={2}>
          <p role="alert" className="text-sm text-text-muted">
            {error}
          </p>
        </SectionCard>
      ) : null}

      {report && result ? (
        <>
          <SectionCard title="Cash-coverage evidence" titleLevel={2}>
            <p className="text-sm text-text-muted">{report.definition}</p>
            <p className="mt-2 text-sm text-text-muted">
              Window: {from} through {to} exclusive, UTC. Retrieved{' '}
              {result.freshness.retrievedAt.toISOString()}. Money is exact integer minor units from
              the recorded ledger currency; no currencies are combined.
            </p>
            {href ? (
              <a
                className={cn(buttonVariants({ variant: 'outline' }), 'mt-4 min-h-11')}
                href={href}
                download={`posted-cash-coverage-${branchId}-${from}-${to}.csv`}
              >
                Download evidence CSV
              </a>
            ) : null}
            {report.rows.length ? (
              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                {report.rows.map((row) => (
                  <article
                    key={row.currency}
                    className="rounded-[var(--radius-md)] border border-border-default bg-surface-raised p-5"
                  >
                    <h3 className="font-semibold text-text-strong">{row.currency}</h3>
                    <div className="mt-4 grid gap-5 sm:grid-cols-2">
                      <Stat
                        label="Cash + bank"
                        value={
                          row.availableFundsMinor === null
                            ? 'Unknown'
                            : `${row.availableFundsMinor} minor`
                        }
                        sub={`${row.currency} recorded balances`}
                      />
                      <Stat
                        label="AP + received accrual"
                        value={
                          row.recordedLiabilitiesMinor === null
                            ? 'Unknown'
                            : `${row.recordedLiabilitiesMinor} minor`
                        }
                        sub="Credit-positive recorded liabilities"
                      />
                      <Stat
                        label="Exact cash coverage"
                        value={
                          row.ratio
                            ? `${row.ratio.numerator} / ${row.ratio.denominator}`
                            : 'Unavailable'
                        }
                        sub="Cash and bank / recorded liabilities"
                      />
                    </div>
                    <dl className="mt-5 grid grid-cols-2 gap-2 text-sm">
                      <dt className="text-text-muted">CASH</dt>
                      <dd className="text-right font-mono">{row.cashMinor ?? 'Unknown'}</dd>
                      <dt className="text-text-muted">BANK</dt>
                      <dd className="text-right font-mono">{row.bankMinor ?? 'Unknown'}</dd>
                      <dt className="text-text-muted">Accounts payable</dt>
                      <dd className="text-right font-mono">
                        {row.accountsPayableMinor ?? 'Unknown'}
                      </dd>
                      <dt className="text-text-muted">Goods received accrual</dt>
                      <dd className="text-right font-mono">
                        {row.goodsReceivedAccrualMinor ?? 'Unknown'}
                      </dd>
                    </dl>
                    {row.missingComponents.length ? (
                      <p role="status" className="mt-4 text-sm text-warning">
                        Missing posting components: {row.missingComponents.join(', ')}. Missing is
                        unknown, not zero.
                      </p>
                    ) : null}
                    {row.flags.map((flag) => (
                      <p role="status" className="mt-2 text-sm text-warning" key={flag}>
                        {flag}.
                      </p>
                    ))}
                  </article>
                ))}
              </div>
            ) : (
              <p className="mt-4 text-sm">
                No matching posted components. Coverage and balances remain unknown.
              </p>
            )}
          </SectionCard>
          <SectionCard title="Coverage and limitations" titleLevel={2}>
            <ul className="list-disc space-y-2 pl-5 text-sm text-text-muted">
              {report.disclosures.map((item) => (
                <li key={item}>{item}</li>
              ))}
              <li>
                Source coverage reported by the authorized reader: {result.coverage.completeness}.
                The authorized source also reads a paginated journal excerpt; this KPI neither
                consumes nor exports that excerpt, and never treats it as complete ledger coverage.
              </li>
              {report.unknownAccountCodes.length ? (
                <li>
                  Other posted account codes were not classified into this KPI:{' '}
                  {report.unknownAccountCodes.join(', ')}.
                </li>
              ) : null}
            </ul>
          </SectionCard>
        </>
      ) : null}
    </main>
  );
}
