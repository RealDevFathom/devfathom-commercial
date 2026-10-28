import Link from 'next/link';
import { TRPCError } from '@trpc/server';
import { unstable_rethrow } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import {
  AccountActivityBridgeError,
  accountActivityBridgeCsv,
  projectAccountActivityBridge,
  validAccountActivityQuery,
} from '@/lib/pharmacy/accounts/account-activity-bridge';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';

export const metadata = { title: 'Account activity bridge · Pharmacy' };

type Caller = ReturnType<typeof pharmacyFinanceRouter.createCaller>;
type Params = Record<string, string | string[] | undefined>;
const route = '/pharmacy/accounts/account-activity-bridge';
const linkClass =
  'inline-flex min-h-11 items-center rounded-sm underline hover:text-text-strong focus-visible:outline-2 focus-visible:outline-ring';

const text = (params: Params, key: string) =>
  typeof params[key] === 'string' ? (params[key] as string).trim() : '';

const money = (minor: string) => {
  const value = BigInt(minor);
  const zero = BigInt(0);
  const hundred = BigInt(100);
  const absolute = value < zero ? -value : value;
  return `${value < zero ? '-' : ''}${absolute / hundred}.${String(absolute % hundred).padStart(2, '0')}`;
};

function Header() {
  return (
    <PageHeader
      eyebrow="Pharmacy / accounts / evidence"
      heading="Account activity bridge"
      description="Trace one exact account and recorded currency from opening balance through posted debits and credits to closing balance."
    />
  );
}

async function AccountActivityBridgeReport({
  caller,
  params,
  now = new Date(),
}: {
  caller: Caller;
  params: Params;
  now?: Date;
}) {
  const branchId = text(params, 'branchId');
  const accountCode = text(params, 'accountCode');
  const currency = text(params, 'currency');
  const from =
    params.from === undefined
      ? new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
      : text(params, 'from');
  const to =
    params.to === undefined
      ? new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)
      : text(params, 'to');

  if (!validAccountActivityQuery(params, from, to))
    return (
      <main className="min-w-0 space-y-6">
        <Header />
        <SectionCard title="Invalid report selection" titleLevel={2}>
          <p role="alert">
            No financial data was displayed. Use single non-empty values and a valid UTC half-open
            period no longer than 92 days.
          </p>
        </SectionCard>
      </main>
    );

  if (!branchId)
    return (
      <main className="min-w-0 space-y-6">
        <Header />
        <SectionCard title="Choose an active branch" titleLevel={2}>
          <p className="mb-4 text-sm text-text-muted">
            Enter the exact active branch identifier. No report data is read until a branch is
            supplied and authorized.
          </p>
          <form action={route} method="get" className="flex flex-wrap items-end gap-3">
            <label className="grid w-full gap-2 text-sm sm:w-auto">
              Branch ID
              <Input name="branchId" required maxLength={128} className="min-h-11" />
            </label>
            <Button type="submit" className="min-h-11">
              Continue
            </Button>
          </form>
        </SectionCard>
      </main>
    );

  let report: Awaited<ReturnType<Caller['financialStatements']>>;
  try {
    report = await caller.financialStatements({
      branchId,
      from: `${from}T00:00:00Z`,
      to: `${to}T00:00:00Z`,
      page: 1,
    });
  } catch (error) {
    unstable_rethrow(error);
    const denied = error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code);
    return (
      <main className="min-w-0 space-y-6">
        <Header />
        <SectionCard
          title={denied ? 'Financial report access required' : 'Report unavailable'}
          titleLevel={2}
        >
          <p role="alert">
            {denied
              ? 'The branch or report is outside your authorized active-branch and financial Reports scope.'
              : 'No financial data was displayed. Check the exact branch and a half-open date window no longer than 92 days, then retry.'}
          </p>
          <Link href={route} className={linkClass}>
            Reset selection and retry
          </Link>
        </SectionCard>
      </main>
    );
  }

  const accounts = [...new Set(report.accounts.map((row) => row.accountCode))].sort();
  const currencies = [
    ...new Set(
      report.accounts
        .filter((row) => !accountCode || row.accountCode === accountCode)
        .map((row) => row.currency)
    ),
  ].sort();
  let outcome;
  try {
    outcome =
      accountCode && currency
        ? projectAccountActivityBridge(report.accounts, { accountCode, currency })
        : null;
  } catch (error) {
    if (!(error instanceof AccountActivityBridgeError)) throw error;
    return (
      <main className="min-w-0 space-y-6">
        <Header />
        <SectionCard title="Aggregate evidence refused" titleLevel={2}>
          <p role="alert">
            The authorized aggregate response was duplicate, malformed, or arithmetically
            inconsistent. No bridge or export was produced.
          </p>
        </SectionCard>
      </main>
    );
  }

  return (
    <main className="min-w-0 space-y-6">
      <Header />
      <SectionCard title="Report selection" titleLevel={2}>
        <form action={route} method="get" className="flex flex-wrap items-end gap-3">
          <label className="grid w-full gap-2 text-sm sm:w-auto">
            Branch ID
            <Input
              name="branchId"
              required
              maxLength={128}
              defaultValue={branchId}
              className="min-h-11"
            />
          </label>
          <label className="grid w-full gap-2 text-sm sm:w-auto">
            From (UTC)
            <Input type="date" name="from" required defaultValue={from} className="min-h-11" />
          </label>
          <label className="grid w-full gap-2 text-sm sm:w-auto">
            To, exclusive (UTC)
            <Input type="date" name="to" required defaultValue={to} className="min-h-11" />
          </label>
          <label className="grid w-full gap-2 text-sm sm:w-auto">
            Exact account
            <select
              name="accountCode"
              required
              defaultValue={accountCode}
              className="min-h-11 rounded-sm border border-border bg-surface-card px-3 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <option value="" disabled>
                Select account
              </option>
              {accounts.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="grid w-full gap-2 text-sm sm:w-auto">
            Exact currency
            <select
              name="currency"
              required
              defaultValue={currency}
              className="min-h-11 rounded-sm border border-border bg-surface-card px-3 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <option value="" disabled>
                Select currency
              </option>
              {currencies.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" className="min-h-11">
            Read bridge
          </Button>
        </form>
        {!report.accounts.length && (
          <p className="mt-4" role="status">
            No account aggregates were returned. This is not evidence of zero activity.
          </p>
        )}
      </SectionCard>

      {outcome && outcome.status !== 'ready' && (
        <SectionCard title="Selection not found" titleLevel={2}>
          <p role="alert">
            {outcome.status === 'account-not-found'
              ? 'The exact account is absent from the authorized aggregates; no zero balance was inferred.'
              : 'The exact currency is absent for this account; no zero balance was inferred.'}
          </p>
        </SectionCard>
      )}
      {outcome?.status === 'ready' && (
        <SectionCard
          title={`${outcome.bridge.accountCode} / ${outcome.bridge.currency}`}
          titleLevel={2}
        >
          <p className="mb-4 text-sm text-text-muted">
            Half-open window [{from}, {to}) in UTC. Posted ledger coverage and source completeness
            remain unknown. This is not a trial balance, running open-item statement, AP aging, or
            classified financial statement.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="font-mono text-xs uppercase">
                <tr>
                  {['Opening (Dr−Cr)', 'Debits', 'Credits', 'Closing (Dr−Cr)'].map((label) => (
                    <th key={label} className="p-3 text-right">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border-subtle">
                  {[
                    outcome.bridge.openingMinor,
                    outcome.bridge.debitMinor,
                    outcome.bridge.creditMinor,
                    outcome.bridge.closingMinor,
                  ].map((value, index) => (
                    <td key={index} className="p-3 text-right font-mono tabular-nums">
                      {money(value)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <a
            className={`${linkClass} mt-4`}
            download="account-activity-bridge.csv"
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(accountActivityBridgeCsv(outcome.bridge))}`}
          >
            Download evidence CSV
          </a>
        </SectionCard>
      )}
    </main>
  );
}

export default async function AccountActivityBridgePage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const caller = pharmacyFinanceRouter.createCaller(await createTRPCContext());
  return AccountActivityBridgeReport({ caller, params: await searchParams });
}
