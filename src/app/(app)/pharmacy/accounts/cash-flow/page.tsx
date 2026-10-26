import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { loadCashFlowProjection } from '@/lib/pharmacy/accounts/cash-flow';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Cash-flow projection' };

const formatMoney = (minor: string) => {
  const amount = BigInt(minor);
  const absolute = amount < 0 ? -amount : amount;
  return `${amount < 0 ? '-' : ''}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, '0')}`;
};

export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; from?: string; to?: string }>;
}) {
  const query = await searchParams;
  const now = new Date();
  const from = query.from ?? new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const to = query.to ?? new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const actor = await resolveTenantActor();
  let report: Awaited<
    ReturnType<ReturnType<typeof pharmacyFinanceRouter.createCaller>['financialStatements']>
  > | null = null;
  let projection: Awaited<ReturnType<typeof loadCashFlowProjection>> = [];
  let denied = Boolean(query.branch && !actor);

  if (actor && query.branch) {
    const ctx = await createTRPCContext({
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
    try {
      // This existing procedure is the sole authorization, entitlement, active-branch, and period gate.
      report = await pharmacyFinanceRouter.createCaller(ctx).financialStatements({
        branchId: query.branch,
        from: `${from}T00:00:00Z`,
        to: `${to}T00:00:00Z`,
        page: 1,
      });
      const controlCurrencies = new Set([
        ...report.accounts.map((a) => a.currency),
        ...report.cashflow.map((a) => a.currency),
      ]);
      const controls = [...controlCurrencies].map((currency) => {
        const accounts = report!.accounts.filter(
          (a) => a.currency === currency && ['CASH', 'BANK'].includes(a.accountCode)
        );
        const flows = report!.cashflow.filter((a) => a.currency === currency);
        return {
          currency,
          openingMinor: accounts
            .reduce((sum, a) => sum + BigInt(a.openingMinor), BigInt(0))
            .toString(),
          closingMinor: accounts
            .reduce((sum, a) => sum + BigInt(a.closingMinor), BigInt(0))
            .toString(),
          movementMinor: flows.reduce((sum, a) => sum + BigInt(a.netMinor), BigInt(0)).toString(),
        };
      });
      projection = await loadCashFlowProjection(
        ctx.db,
        report.scope,
        { from: report.from, to: report.to },
        controls
      );
    } catch (error) {
      denied = error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code);
    }
  }

  return (
    <main className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Classified cash-flow projection"
        description="Read-only posted-ledger projection with transfer netting and visible unclassified evidence."
      />
      <SectionCard title="Branch and UTC period" titleLevel={2}>
        <form className="flex flex-wrap items-end gap-3">
          <label className="grid gap-2 text-sm">
            Branch ID
            <Input name="branch" defaultValue={query.branch} required />
          </label>
          <label className="grid gap-2 text-sm">
            From (inclusive)
            <Input type="date" name="from" defaultValue={from} required />
          </label>
          <label className="grid gap-2 text-sm">
            To (exclusive)
            <Input type="date" name="to" defaultValue={to} required />
          </label>
          <Button>Read projection</Button>
        </form>
        {!query.branch && (
          <p className="mt-4 text-sm text-text-muted">
            Choose an active branch by its ID. No financial data has been read.
          </p>
        )}
        {query.branch && !report && (
          <p role="alert" className="mt-4 text-sm">
            {denied
              ? 'Owner financial-report permission, Pharmacy Reports access, and an active in-scope branch are required.'
              : 'The projection could not be read. Choose a valid UTC window of at most 92 days.'}
          </p>
        )}
      </SectionCard>
      {report && (
        <>
          <SectionCard title="Opening-to-closing reconciliation" titleLevel={2}>
            <p className="text-sm text-text-muted">
              Amounts are integer minor units in each recorded currency. Opening + net movement =
              closing. This projection is not statutory or audited, and completeness is never
              claimed from posted entries alone.
            </p>
            <div className="overflow-x-auto">
              <table className="mt-4 w-full text-sm">
                <thead className="font-mono text-xs uppercase">
                  <tr>
                    {[
                      'Currency',
                      'Opening',
                      'Operating',
                      'Investing',
                      'Financing',
                      'Unclassified',
                      'Net',
                      'Closing',
                      'Control',
                    ].map((x) => (
                      <th key={x} className="p-3 text-left">
                        {x}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {projection.map((row) => (
                    <tr key={row.currency} className="border-t border-border-subtle">
                      <td className="p-3 font-semibold">{row.currency}</td>
                      {[
                        row.openingMinor,
                        row.operatingMinor,
                        row.investingMinor,
                        row.financingMinor,
                        row.unclassifiedMinor,
                        row.movementMinor,
                        row.closingMinor,
                      ].map((value, i) => (
                        <td key={i} className="p-3 text-right font-mono">
                          {formatMoney(String(value))}
                        </td>
                      ))}
                      <td className="p-3">
                        <StatusPill
                          status={row.canonicalControlMatches ? 'Matched' : 'Discrepancy'}
                          tone={row.canonicalControlMatches ? 'success' : 'warning'}
                          label={
                            row.canonicalControlMatches
                              ? 'Matched'
                              : row.canonicalClosingDiscrepancyMinor === null
                                ? 'Control unavailable'
                                : `Opening ${row.canonicalOpeningDiscrepancyMinor}; movement ${row.canonicalMovementDiscrepancyMinor}; closing ${row.canonicalClosingDiscrepancyMinor}`
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!projection.length && (
              <p className="mt-4 text-sm">
                No scoped cash or bank postings before the cutoff; this is not proof of zero
                activity.
              </p>
            )}
          </SectionCard>
          <SectionCard title="Source and reversal evidence" titleLevel={2}>
            <p className="text-sm text-text-muted">
              Source: finance journal entries and branch-scoped lines. Retrieved{' '}
              {report.freshness.retrievedAt.toISOString()}.
            </p>
            {projection.map((row) => (
              <div key={row.currency} className="mt-3 text-sm">
                <strong>{row.currency} source status</strong>
                <p className="text-text-muted">
                  Latest posting:{' '}
                  {row.metadata.latestPostingAt?.toISOString() ?? 'No in-period cash posting'} ·
                  Classified completeness: {row.metadata.classifiedCompleteness}.{' '}
                  {row.metadata.completenessReason}
                </p>
              </div>
            ))}
            {projection.flatMap((row) =>
              row.evidence.map((item) => (
                <article
                  key={`${row.currency}-${item.entryId}`}
                  className="border-b border-border-subtle py-4 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong>
                      {item.sourceKind} · {item.sourceId}
                    </strong>
                    <StatusPill
                      status={item.category}
                      tone={item.category === 'UNCLASSIFIED' ? 'warning' : 'neutral'}
                    />
                  </div>
                  <p className="mt-1 text-text-muted">{item.description}</p>
                  <p className="mt-1 font-mono">
                    {row.currency} {formatMoney(item.netMinor)} · {item.occurredAt.toISOString()} ·
                    counterparts: {item.counterpartAccounts.join(', ') || 'none'}
                  </p>
                  {item.reversesEntryId && (
                    <p className="mt-1">
                      Reverses entry: <span className="font-mono">{item.reversesEntryId}</span>
                    </p>
                  )}
                </article>
              ))
            )}
          </SectionCard>
        </>
      )}
    </main>
  );
}
