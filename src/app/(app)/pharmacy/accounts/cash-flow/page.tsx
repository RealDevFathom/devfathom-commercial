import { PHARMACY_COPY } from '@/lib/pharmacy/plain-language';
import { SHOP_SCREEN_COPY as screenCopy } from '@/lib/pharmacy/screen-copy';
import { ReportDetails } from '@/components/pharmacy/report-details';
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
import { financeEntryDescription } from '@/lib/finance/source-labels';
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import { createTRPCContext } from '@/server/trpc';
import {
  formatWorkspaceDateTime,
  workspaceDateOffset,
  workspaceDateRange,
  workspaceZoneLabel,
} from '@/lib/timezone';

export const metadata: Metadata = { title: screenCopy.cashFlow.cashFlow };

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
  // The organization zone is known once the tenant actor resolves; until then (or if it fails)
  // the default window is counted on the UTC clock.
  let timeZone: string | null | undefined;
  const defaults = () => ({
    from: query.from ?? workspaceDateOffset(timeZone, -30, now),
    // Exclusive upper bound defaults to tomorrow so today's postings are included.
    to: query.to ?? workspaceDateOffset(timeZone, 1, now),
  });
  const requestedPage = Number.parseInt(query.page ?? '1', 10);
  let branches: Array<{ id: string; name: string }> = [];
  let projection: Awaited<ReturnType<typeof loadCashFlowProjection>> | null = null;
  let message = query.branch
    ? 'The cash-flow projection could not be read.'
    : 'Choose an active branch to authorize and read its projection.';
  try {
    const actor = await resolveTenantActor();
    if (!actor) throw new TRPCError({ code: 'UNAUTHORIZED' });
    timeZone = actor.organization?.timezone ?? 'UTC';
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
      const { from, to } = defaults();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        throw new TRPCError({ code: 'BAD_REQUEST' });
      }
      if (
        !Number.isFinite(Date.parse(`${from}T00:00:00Z`)) ||
        !Number.isFinite(Date.parse(`${to}T00:00:00Z`))
      ) {
        throw new TRPCError({ code: 'BAD_REQUEST' });
      }
      // The picked days are read on the organization's clock: the window starts at the
      // start of `from` and ends at the start of `to` (exclusive), both in that zone.
      const start = workspaceDateRange(from, from, timeZone).from;
      const end = workspaceDateRange(to, to, timeZone).from;
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
      message = 'Choose an active branch and a valid date window of at most 92 days, then retry.';
    } else {
      message = 'The cash-flow projection could not be read. Please retry.';
    }
  }
  const { from, to } = defaults();
  const zone = timeZone ? workspaceZoneLabel(timeZone) : 'workspace timezone';
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
        eyebrow={screenCopy.cashFlow.pharmacyAccounts}
        heading={screenCopy.cashFlow.cashFlow}
        description={screenCopy.cashFlow.cashComingInAndGoingOutGroupedBy}
      />
      <SectionCard title={`${screenCopy.dateWindow.scopeAndPeriod} (${zone})`}>
        <form className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-64 gap-2 text-sm">
            {screenCopy.cashFlow.activeBranch}
            <select
              className="min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              name="branch"
              defaultValue={query.branch ?? branches[0]?.id ?? ''}
              required
            >
              {!branches.length ? (
                <option value="">{screenCopy.cashFlow.noActiveBranchesAvailable}</option>
              ) : null}
              {branches.map((branch) => (
                <option value={branch.id} key={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm">
            {screenCopy.dateWindow.from} ({zone})
            <Input type="date" name="from" defaultValue={from} required />
          </label>
          <label className="grid gap-2 text-sm">
            {screenCopy.dateWindow.toExclusive} ({zone})
            <Input type="date" name="to" defaultValue={to} required />
          </label>
          <Button type="submit" className="min-h-11">
            {screenCopy.cashFlow.showCashFlow}
          </Button>
        </form>
      </SectionCard>
      {!projection ? (
        <SectionCard title={screenCopy.cashFlow.projectionUnavailable}>
          <p role="alert" className="text-sm text-text-muted">
            {message}
            {screenCopy.cashFlow.noFinancialDataIsShown}
          </p>
        </SectionCard>
      ) : (
        <>
          <SectionCard title={screenCopy.cashFlow.openingAndClosingCash}>
            <ReportDetails>
              <p className="text-sm text-text-muted">
                {screenCopy.cashFlow.recordedCurrencyMinorUnitTotalsFromEveryScoped}{' '}
                {formatWorkspaceDateTime(projection.metadata.retrievedAt, timeZone)}
                {screenCopy.cashFlow.completenessUnknown} {projection.metadata.completenessReason}
                {screenCopy.cashFlow.discrepancyIsCanonicalCashPlusBankAccountClosing}
              </p>
            </ReportDetails>
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
                      'Accounts closing',
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
                {screenCopy.cashFlow.noScopedCashPostingsThisDoesNotProve}
              </p>
            )}
          </SectionCard>
          <SectionCard title={screenCopy.cashFlow.paymentsAndReversals}>
            <ReportDetails>
              <p className="text-sm text-text-muted">
                {
                  screenCopy.cashFlow
                    .classificationRequiresSupportedSourceAndCounterpartEvidenceAmbiguous
                }
              </p>
            </ReportDetails>
            <p className="mt-2 text-sm text-text-muted">
              {screenCopy.cashFlow.showing}
              {evidenceRange.first}–{evidenceRange.last}
              {screenCopy.cashFlow.of}
              {projection.evidence.length}{' '}
              {screenCopy.cashFlow.cashMovingEntriesTotalsAboveIncludeEveryEntry}
            </p>
            {evidencePage.map((entry) => (
              <details className="mt-3 rounded-sm border border-border-default p-3" key={entry.id}>
                <summary className="min-h-11 cursor-pointer">
                  {formatWorkspaceDateTime(entry.occurredAt, timeZone)} ·{' '}
                  {PHARMACY_COPY.account.cashFlowClasses[entry.classification]} · {entry.currency}{' '}
                  {money(entry.netMinor)} · {financeEntryDescription(entry.description)}
                </summary>
                <p className="break-all text-xs text-text-muted">
                  {screenCopy.cashFlow.entry}
                  {entry.id}
                  {screenCopy.cashFlow.sourceLabel}
                  {entry.sourceKind}/{entry.sourceId}
                  {entry.sourceDetail ? `/${entry.sourceDetail}` : ''}
                  {entry.reversesEntryId ? ` · reverses ${entry.reversesEntryId}` : ''} ·{' '}
                  {entry.reason}
                </p>
                <ul
                  aria-label={screenCopy.cashFlow.classificationJournalLines}
                  className="mt-3 space-y-1 text-sm"
                >
                  {entry.lines.map((line, index) => (
                    <li key={`${line.accountCode}:${line.side}:${index}`} className="font-mono">
                      {line.accountCode} · {line.side} · {entry.currency} {money(line.amountMinor)}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
            {evidenceRange.pages > 1 && (
              <nav
                aria-label={screenCopy.cashFlow.evidencePages}
                className="mt-4 flex flex-wrap gap-3"
              >
                {evidenceRange.page > 1 && (
                  <Link
                    className={buttonVariants({ variant: 'secondary', className: 'min-h-11' })}
                    href={pageHref(evidenceRange.page - 1)}
                  >
                    {screenCopy.cashFlow.previousEvidence}
                  </Link>
                )}
                {evidenceRange.page < evidenceRange.pages && (
                  <Link
                    className={buttonVariants({ variant: 'secondary', className: 'min-h-11' })}
                    href={pageHref(evidenceRange.page + 1)}
                  >
                    {screenCopy.cashFlow.nextEvidence}
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
