import type { Metadata } from 'next';
import { TRPCError } from '@trpc/server';
import { unstable_rethrow } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { loadCashFlowProjection } from '@/lib/pharmacy/accounts/cash-flow';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';

export const metadata: Metadata = { title: 'Classified cash-flow projection' };

const EVIDENCE_PAGE_SIZE = 50;

const money = (minor: bigint) => {
  const absolute = minor < BigInt(0) ? -minor : minor;
  return `${minor < BigInt(0) ? '-' : ''}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, '0')}`;
};

export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; from?: string; to?: string; page?: string }>;
}) {
  const query = await searchParams;
  const now = new Date();
  const from = query.from ?? new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  // Exclusive UTC upper bound defaults to tomorrow so today's postings are included.
  const to = query.to ?? new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const requestedPage = Number.parseInt(query.page ?? '1', 10);
  let branches: Array<{ id: string; name: string }> = [];
  let projection: Awaited<ReturnType<typeof loadCashFlowProjection>> | null = null;
  let message = query.branch
    ? 'The cash-flow projection could not be read.'
    : 'Choose an active branch to authorize and read its projection.';
  try {
    const actor = await resolveTenantActor();
    if (!actor) throw new TRPCError({ code: 'UNAUTHORIZED' });
    const ctx = await createTRPCContext({
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
    branches = await ctx.db.pharmacyBranch.findMany({
      where: { organizationId: ctx.entitlements.organizationId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    if (query.branch) {
      const start = new Date(`${from}T00:00:00Z`),
        end = new Date(`${to}T00:00:00Z`);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
        throw new TRPCError({ code: 'BAD_REQUEST' });
      }
      const branchId = query.branch;
      // One repeatable-read transaction: authorization, canonical controls and the projection
      // share a snapshot, so a concurrent posting cannot surface as a false discrepancy.
      projection = await ctx.db.$transaction(
        async (transaction) => {
          const tx = transaction as ScopedDb;
          // This existing caller is intentionally the sole authorization, entitlement, capability,
          // tenant and active-branch gate. Only its returned scope reaches the loader, and its
          // CASH/BANK account balances are the canonical reconciliation control.
          const authorized = await pharmacyFinanceRouter
            .createCaller({ ...ctx, db: tx })
            .financialStatements({
              branchId,
              from: start.toISOString(),
              to: end.toISOString(),
              page: 1,
            });
          return loadCashFlowProjection(
            tx,
            authorized.scope,
            { from: start, to: end },
            authorized.accounts
          );
        },
        { isolationLevel: 'RepeatableRead' }
      );
    }
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code)) {
      message =
        'Owner Pharmacy Reports access and operational plus financial report capabilities are required.';
    } else if (error instanceof TRPCError && error.code === 'BAD_REQUEST') {
      message = 'Choose an active branch and a valid UTC window of at most 92 days, then retry.';
    } else {
      message = 'The cash-flow projection could not be read. Please retry.';
    }
  }
  const pages = Math.max(1, Math.ceil((projection?.evidence.length ?? 0) / EVIDENCE_PAGE_SIZE));
  const page = Number.isFinite(requestedPage) ? Math.min(Math.max(requestedPage, 1), pages) : 1;
  const evidencePage =
    projection?.evidence.slice((page - 1) * EVIDENCE_PAGE_SIZE, page * EVIDENCE_PAGE_SIZE) ?? [];
  const evidenceRange = {
    page,
    pages,
    first: evidencePage.length ? (page - 1) * EVIDENCE_PAGE_SIZE + 1 : 0,
    last: (page - 1) * EVIDENCE_PAGE_SIZE + evidencePage.length,
  };
  const pageHref = (target: number) =>
    `?${new URLSearchParams({ branch: query.branch ?? '', from, to, page: String(target) })}`;
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Classified cash-flow projection"
        description="A conservative posted-ledger projection with transfer netting and visible unclassified evidence."
      />
      <SectionCard title="Scope and UTC period">
        <form className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-64 gap-2 text-sm">
            Active branch
            <select
              className="min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              name="branch"
              defaultValue={query.branch ?? branches[0]?.id ?? ''}
              required
            >
              {!branches.length ? <option value="">No active branches available</option> : null}
              {branches.map((branch) => (
                <option value={branch.id} key={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm">
            From (inclusive)
            <Input type="date" name="from" defaultValue={from} required />
          </label>
          <label className="grid gap-2 text-sm">
            To (exclusive)
            <Input type="date" name="to" defaultValue={to} required />
          </label>
          <Button type="submit" className="min-h-11">
            Read projection
          </Button>
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
              {projection.metadata.completenessReason} Discrepancy is canonical CASH plus BANK
              account closing from the financial statements, read in the same snapshot, minus the
              projected closing.
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
                      'Canonical closing',
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
                        row.canonicalClosing,
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
            <p className="mt-2 text-sm text-text-muted">
              Showing {evidenceRange.first}–{evidenceRange.last} of {projection.evidence.length}{' '}
              cash-moving entries; totals above include every entry in the period.
            </p>
            {evidencePage.map((entry) => (
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
                <ul aria-label="Classification journal lines" className="mt-3 space-y-1 text-sm">
                  {entry.lines.map((line, index) => (
                    <li key={`${line.accountCode}:${line.side}:${index}`} className="font-mono">
                      {line.accountCode} · {line.side} · {entry.currency} {money(line.amountMinor)}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
            {evidenceRange.pages > 1 && (
              <nav aria-label="Evidence pages" className="mt-4 flex flex-wrap gap-3">
                {evidenceRange.page > 1 && (
                  <Link
                    className={buttonVariants({ variant: 'secondary', className: 'min-h-11' })}
                    href={pageHref(evidenceRange.page - 1)}
                  >
                    Previous evidence
                  </Link>
                )}
                {evidenceRange.page < evidenceRange.pages && (
                  <Link
                    className={buttonVariants({ variant: 'secondary', className: 'min-h-11' })}
                    href={pageHref(evidenceRange.page + 1)}
                  >
                    Next evidence
                  </Link>
                )}
              </nav>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
