import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import {
  formatCoverageRatio,
  postedCashCoverage,
  postedCashCoverageCsv,
  POSTED_CASH_COVERAGE_DEFINITION,
} from '@/lib/pharmacy/accounts/liquidity-kpi';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
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
const money = (minor: string) => {
  const value = BigInt(minor);
  const absolute = value < BigInt(0) ? -value : value;
  return `${value < BigInt(0) ? '-' : ''}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, '0')}`;
};

export default async function LiquidityKpiPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = scalar(query.cutoff) ?? today;
  const requestedBranch = scalar(query.branch);
  const invalidQuery =
    Object.values(query).some(Array.isArray) || !validDate(cutoff) || cutoff > today;
  let state:
    | {
        kind: 'ready';
        branches: { id: string; name: string }[];
        branchId: string;
        accounts: readonly { accountCode: string; currency: string; closingMinor: string }[];
        retrievedAt: Date;
      }
    | { kind: 'denied' | 'error'; branches: { id: string; name: string }[] };
  try {
    if (invalidQuery) throw new TRPCError({ code: 'BAD_REQUEST' });
    const context = await createTRPCContext();
    const reports = pharmacyReportsRouter.createCaller(context);
    const branches = (await reports.branches()).branches;
    const branchId = requestedBranch ?? (branches.length === 1 ? branches[0]!.id : '');
    if (!branchId || !branches.some((branch) => branch.id === branchId)) {
      state = { kind: 'error', branches };
    } else {
      const to = new Date(`${cutoff}T00:00:00.000Z`);
      to.setUTCDate(to.getUTCDate() + 1);
      const from = new Date(to);
      from.setUTCDate(from.getUTCDate() - 1);
      const result = await pharmacyFinanceRouter.createCaller(context).financialStatements({
        branchId,
        from: from.toISOString(),
        to: to.toISOString(),
        page: 1,
      });
      state = {
        kind: 'ready',
        branches,
        branchId,
        accounts: result.accounts,
        retrievedAt: result.freshness.retrievedAt,
      };
    }
  } catch (error) {
    state = {
      kind:
        error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code)
          ? 'denied'
          : 'error',
      branches: [],
    };
  }

  const rows = state.kind === 'ready' ? postedCashCoverage(state.accounts) : [];
  const csv = state.kind === 'ready' ? postedCashCoverageCsv(rows) : null;
  return (
    <main className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Posted cash coverage"
        description="A recorded-currency liquidity indicator from posted account balances."
      />
      <SectionCard title="Cutoff and branch" titleLevel={2}>
        <form action={ROUTE} className="grid gap-4 md:grid-cols-2">
          <label className="text-sm text-text-body">
            Branch
            <select
              name="branch"
              defaultValue={state.kind === 'ready' ? state.branchId : (requestedBranch ?? '')}
              className="mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-ring"
              required
            >
              <option value="">Select an authorized branch</option>
              {state.branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-text-body">
            Posted through (UTC)
            <Input
              className="mt-1 min-h-11"
              type="date"
              name="cutoff"
              defaultValue={cutoff}
              max={today}
              required
            />
          </label>
          <Button type="submit" className="min-h-11">
            Read posted coverage
          </Button>
        </form>
      </SectionCard>

      {state.kind !== 'ready' ? (
        <SectionCard
          title={
            state.kind === 'denied' ? 'Financial report access required' : 'Coverage unavailable'
          }
          titleLevel={2}
        >
          <p role="alert" className="text-sm text-text-muted">
            {state.kind === 'denied'
              ? 'Owner financial-report permission, Pharmacy reports access, and an authorized active branch are required.'
              : 'The cutoff or branch could not be verified, or posted balances could not be read. No financial data was changed.'}
          </p>
        </SectionCard>
      ) : (
        <SectionCard
          title="Coverage by recorded currency"
          titleLevel={2}
          actions={
            csv ? (
              <a
                className="text-sm underline focus-visible:outline-2 focus-visible:outline-ring"
                download={`posted-cash-coverage-${cutoff}.csv`}
                href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}
              >
                Export safe CSV
              </a>
            ) : undefined
          }
        >
          <p className="text-sm text-text-muted">
            {POSTED_CASH_COVERAGE_DEFINITION} Credit balances are positive for liabilities.
            Retrieved {state.retrievedAt.toISOString()}.
          </p>
          <p className="mt-2 text-sm text-text-muted">
            Posted coverage and completeness remain unknown. This is not a solvency, current, or
            quick ratio certification and does not rebuild a balance sheet or cash-flow statement.
          </p>
          {rows.length ? (
            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              {rows.map((row) => (
                <article
                  key={row.currency}
                  className="rounded-[var(--radius-md)] border border-border-default bg-surface-raised p-5"
                >
                  <Stat
                    label={`${row.currency} · posted cash coverage`}
                    value={formatCoverageRatio(row)}
                    sub={
                      row.ratio
                        ? `Exact ratio ${row.numeratorMinor}/${row.denominatorMinor}`
                        : 'Denominator is missing, zero, or negative.'
                    }
                  />
                  <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
                    {(
                      [
                        ['Cash', row.cashMinor],
                        ['Bank', row.bankMinor],
                        ['Accounts payable', row.accountsPayableMinor],
                        ['Goods received accrual', row.goodsReceivedAccrualMinor],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-text-muted">{label}</dt>
                        <dd className="font-mono tabular-nums">
                          {row.currency} {money(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {row.flags.length ? (
                    <p role="status" className="mt-4 text-sm text-warning">
                      Review unusual posting:{' '}
                      {row.flags
                        .map((flag) =>
                          flag === 'NEGATIVE_CASH' ? 'negative cash/bank' : 'debit liability'
                        )
                        .join('; ')}
                      .
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm">
              No posted CASH, BANK, ACCOUNTS_PAYABLE, or GOODS_RECEIVED_ACCRUAL balances were
              returned. Coverage is unavailable, not zero.
            </p>
          )}
        </SectionCard>
      )}
    </main>
  );
}
