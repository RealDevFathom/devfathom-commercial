import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { loadCashFlowProjection } from '@/lib/pharmacy/accounts/cash-flow';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Classified cash-flow projection' };

const money = (minor: bigint) => {
  const absolute = minor < 0n ? -minor : minor;
  return `${minor < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
};

export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; from?: string; to?: string }>;
}) {
  const query = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const from = query.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const to = query.to ?? today;
  let projection: Awaited<ReturnType<typeof loadCashFlowProjection>> | null = null;
  let message = query.branch
    ? 'The cash-flow projection could not be read.'
    : 'Enter an active branch identifier to authorize and read its projection.';
  if (query.branch) {
    try {
      const actor = await resolveTenantActor();
      if (!actor) throw new TRPCError({ code: 'UNAUTHORIZED' });
      const ctx = await createTRPCContext({
        session: actor.session,
        organization: actor.organization,
        support: actor.support,
      });
      const start = new Date(`${from}T00:00:00Z`),
        end = new Date(`${to}T00:00:00Z`);
      // This existing caller is intentionally the sole authorization, entitlement, capability,
      // tenant and active-branch gate. Only its returned scope reaches the all-entry loader.
      const authorized = await pharmacyFinanceRouter
        .createCaller(ctx)
        .financialStatements({
          branchId: query.branch,
          from: start.toISOString(),
          to: end.toISOString(),
          page: 1,
        });
      projection = await loadCashFlowProjection(ctx.db, authorized.scope, { from: start, to: end });
    } catch (error) {
      message =
        error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code)
          ? 'Owner Pharmacy Reports access and operational plus financial report capabilities are required.'
          : 'Choose a valid UTC window of at most 92 days and retry.';
    }
  }
  return (
    <main className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Classified cash-flow projection"
        description="A conservative posted-ledger projection with transfer netting and visible unclassified evidence."
      />
      <SectionCard title="Scope and UTC period">
        <form className="flex flex-wrap items-end gap-3">
          <label className="grid gap-2 text-sm">
            Active branch ID
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
          <Button className="min-h-11">Read projection</Button>
        </form>
      </SectionCard>
      {!projection ? (
        <SectionCard title="Projection unavailable">
          <p role="alert" className="text-sm text-text-muted">
            {message} No financial data is shown.
          </p>
        </SectionCard>
      ) : (
        <>
          <SectionCard title="Opening-to-closing reconciliation">
            <p className="text-sm text-text-muted">
              Recorded currency minor-unit totals from every scoped posted cash/bank line. Retrieved{' '}
              {projection.metadata.retrievedAt.toISOString()}. Completeness: unknown —{' '}
              {projection.metadata.completenessReason}
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
                      'Net movement',
                      'Closing',
                      'Discrepancy',
                    ].map((x) => (
                      <th className="p-3 text-left" key={x}>
                        {x}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {projection.totals.map((row) => (
                    <tr className="border-t border-border-subtle" key={row.currency}>
                      {[
                        row.currency,
                        row.opening,
                        row.operating,
                        row.investing,
                        row.financing,
                        row.unclassified,
                        row.netMovement,
                        row.closing,
                        row.discrepancy,
                      ].map((value, i) => (
                        <td className={`p-3 ${i ? 'text-right font-mono' : ''}`} key={i}>
                          {typeof value === 'bigint' ? money(value) : value}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!projection.totals.length && (
              <p className="mt-4 text-sm">
                No scoped cash postings; this does not prove zero activity.
              </p>
            )}
          </SectionCard>
          <SectionCard title="Source and reversal evidence">
            <p className="text-sm text-text-muted">
              Classification requires supported source and counterpart evidence. Ambiguous, mixed,
              and future policies remain unclassified; this is not a statutory or audited statement.
            </p>
            {projection.evidence.map((entry) => (
              <details className="mt-3 rounded-sm border border-border-default p-3" key={entry.id}>
                <summary className="min-h-11 cursor-pointer">
                  {entry.occurredAt.toISOString()} · {entry.classification} · {entry.currency}{' '}
                  {money(entry.netMinor)} · {entry.description}
                </summary>
                <p className="break-all text-xs text-text-muted">
                  Entry {entry.id} · source {entry.sourceKind}/{entry.sourceId}
                  {entry.sourceDetail ? `/${entry.sourceDetail}` : ''}
                  {entry.reversesEntryId ? ` · reverses ${entry.reversesEntryId}` : ''} ·{' '}
                  {entry.reason}
                </p>
              </details>
            ))}
          </SectionCard>
        </>
      )}
    </main>
  );
}
