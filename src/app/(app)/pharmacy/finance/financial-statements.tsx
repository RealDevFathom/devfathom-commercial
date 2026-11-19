import Link from 'next/link';
import { ProfitAndLossReport } from '../accounts/profit-loss/report';
import { TRPCError } from '@trpc/server';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { financeAccountLabel } from '@/lib/finance/account-labels';
import { financeEntryDescription, financeSourceLabel } from '@/lib/finance/source-labels';
import { SHOP_SCREEN_COPY as screenCopy } from '@/lib/pharmacy/plain-language';
import { pharmacyBusinessDayOffset, pharmacyBusinessDayRange } from '@/lib/pharmacy/business-day';
import { formatWorkspaceDateTime, workspaceZoneLabel } from '@/lib/timezone';
import type { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';

const money = (value: string | number) => {
  const n = BigInt(value),
    absolute = n < BigInt(0) ? -n : n;
  return `${n < BigInt(0) ? '-' : ''}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, '0')}`;
};
/**
 * The instant a picked day starts on the organisation's clock, in the reader's existing
 * `YYYY-MM-DDTHH:MM:SSZ` form: for a UTC organisation, `${day}T00:00:00Z` exactly as before. A
 * malformed day passes through as before, so the reader still refuses it.
 */
export function statementDayStart(
  day: string,
  timeZone: string | null | undefined,
  dayEndsAtHour?: number | null
): string {
  const utc = new Date(`${day}T00:00:00.000Z`);
  // Only a real calendar day is moved: 2026-02-30 would otherwise roll over to 2 March.
  const real =
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(utc.getTime()) &&
    utc.toISOString().slice(0, 10) === day;
  if (!real) return `${day}T00:00:00Z`;
  // DEV-958A: the branch's business day, which starts at its "day ends at" hour.
  return pharmacyBusinessDayRange(day, day, { timeZone, dayEndsAtHour })
    .from.toISOString()
    .replace('.000Z', 'Z');
}

export async function FinancialStatements({
  caller,
  branchId,
  from,
  to,
  page,
  timeZone,
  dayEndsAtHour,
}: {
  caller: ReturnType<typeof pharmacyFinanceRouter.createCaller>;
  branchId: string;
  from?: string;
  to?: string;
  page?: string;
  /** Workspace IANA zone: picked days are the organisation's days (UTC when absent). */
  timeZone?: string | null;
  /** DEV-958A: the hour the branch's business day ends at (midnight when absent). */
  dayEndsAtHour?: number | null;
}) {
  const now = new Date();
  const clock = { timeZone, dayEndsAtHour };
  const start = from || pharmacyBusinessDayOffset(clock, -30, now);
  const end = to || pharmacyBusinessDayOffset(clock, 1, now);
  const zone = workspaceZoneLabel(timeZone);
  let result;
  try {
    result = await caller.financialStatements({
      branchId,
      from: statementDayStart(start, timeZone, dayEndsAtHour),
      to: statementDayStart(end, timeZone, dayEndsAtHour),
      page: Number(page || 1),
    });
  } catch (error) {
    const denied = error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code);
    return (
      <SectionCard title="Journals and financial statements" titleLevel={2}>
        <p role="alert">
          {denied
            ? 'Owner financial-report permission and Pharmacy Reports access are required.'
            : 'Statements could not be read. Choose a valid date window of up to 92 days and retry.'}
        </p>
      </SectionCard>
    );
  }

  const positions = result.accounts.filter((a) =>
    [
      'ACCOUNTS_RECEIVABLE',
      'ACCOUNTS_PAYABLE',
      'GOODS_RECEIVED_ACCRUAL',
      'SUPPLIER_CLAIM_RECEIVABLE',
      'CASH',
      'BANK',
      'SALES_CLEARING',
    ].includes(a.accountCode)
  );
  const href = (p: number) =>
    `/pharmacy/finance?${new URLSearchParams({ branch: branchId, ledgerFrom: start, ledgerTo: end, journalPage: String(p) })}`;
  return (
    <SectionCard title="Journals and financial statements" titleLevel={2}>
      <form className="mb-4 flex flex-wrap items-end gap-3">
        <input type="hidden" name="branch" value={branchId} />
        <label className="grid gap-2 text-sm">
          {screenCopy.marginComparison.fromMidnight}
          {zone}
          {screenCopy.marginComparison.closeZone}
          <Input type="date" name="ledgerFrom" defaultValue={start} required />
        </label>
        <label className="grid gap-2 text-sm">
          {screenCopy.marginComparison.untilMidnight}
          {zone}
          {screenCopy.marginComparison.closeZoneNotIncluded}
          <Input type="date" name="ledgerTo" defaultValue={end} required />
        </label>
        <Button className="min-h-11">Read statements</Button>
      </form>
      <p className="text-sm text-text-muted">
        {result.definition} Amounts shown in the recorded currency. Retrieved{' '}
        {formatWorkspaceDateTime(result.freshness.retrievedAt, timeZone)}.
      </p>
      <ProfitAndLossReport statements={result.profitAndLoss} />
      <h3 className="mt-6 font-semibold">Receivables, payables and cash at cutoff</h3>
      <p className="mt-2 text-sm text-text-muted">
        Recorded ledger balances only. Goods received accrual is shown separately from invoiced
        payables; supplier claims are separate from customer receivables. Customer/supplier due-date
        aging is not available from these postings.
      </p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {positions.map((a) => (
          <li
            key={`${a.currency}-${a.accountCode}`}
            className="flex flex-wrap justify-between gap-3 border-b border-border-subtle py-2"
          >
            <span title={a.accountCode}>{financeAccountLabel(a.accountCode)}</span>
            <span className="font-mono">
              {a.currency}{' '}
              {money(
                ['ACCOUNTS_PAYABLE', 'GOODS_RECEIVED_ACCRUAL'].includes(a.accountCode)
                  ? (-BigInt(a.closingMinor)).toString()
                  : a.closingMinor
              )}
            </span>
          </li>
        ))}
      </ul>
      {!positions.length && (
        <p className="mt-3 text-sm">No recorded balance postings; completeness unknown.</p>
      )}
      <h3 className="mt-6 font-semibold">Trial balance</h3>
      <div className="overflow-x-auto">
        <table className="mt-3 w-full text-sm">
          <thead className="font-mono text-xs uppercase">
            <tr>
              {[
                'Account / currency',
                'Opening (Dr−Cr)',
                'Debits',
                'Credits',
                'Closing (Dr−Cr)',
              ].map((v) => (
                <th key={v} className="p-3 text-left">
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.accounts.map((a) => (
              <tr key={`${a.currency}-${a.accountCode}`} className="border-t border-border-subtle">
                <td className="p-3" title={a.accountCode}>
                  {financeAccountLabel(a.accountCode)} / {a.currency}
                </td>
                {[a.openingMinor, a.debitMinor, a.creditMinor, a.closingMinor].map((v, i) => (
                  <td key={i} className="p-3 text-right font-mono">
                    {money(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="mt-6 font-semibold">Cash flow · posted cash and bank movements</h3>
      <p className="mt-2 text-sm text-text-muted">
        Net cash and bank movement per journal event; internal cash-to-bank transfers contribute
        zero. This is not a classified statutory cash-flow statement.
      </p>
      <div className="overflow-x-auto">
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr>
              {['Source / currency', 'Inflow', 'Outflow', 'Net'].map((v) => (
                <th key={v} className="p-3 text-left">
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.cashflow.map((a) => (
              <tr key={`${a.currency}-${a.sourceKind}`} className="border-t border-border-subtle">
                <td className="p-3" title={a.sourceKind}>
                  {financeSourceLabel(a.sourceKind)} / {a.currency}
                </td>
                {[a.inflowMinor, a.outflowMinor, a.netMinor].map((v, i) => (
                  <td key={i} className="p-3 text-right font-mono">
                    {money(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!result.cashflow.length && (
        <p className="mt-3 text-sm">
          No matching cash postings; unposted activity remains unknown.
        </p>
      )}
      <h3 className="mt-6 font-semibold">Journal · {result.journalCount} entries in window</h3>
      <Link
        className="mt-3 inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:outline-ring"
        href={`/pharmacy/accounts/journal-evidence-export?${new URLSearchParams({
          branch: branchId,
          from: start,
          to: end,
          page: String(result.page),
        })}`}
      >
        Export this journal page as evidence
      </Link>
      {result.journal.map((e) => (
        <details key={e.id} className="mt-3 rounded-sm border border-border p-3">
          <summary className="min-h-11 cursor-pointer break-words focus-visible:outline-2 focus-visible:outline-ring">
            {formatWorkspaceDateTime(e.occurredAt, timeZone)} · {financeSourceLabel(e.sourceKind)}
            {result.journalLabels?.paymentMethods[e.id]
              ? ` · ${result.journalLabels.paymentMethods[e.id]}`
              : ''}{' '}
            · {e.billNumber == null ? 'Bill unavailable' : `Bill ${e.billNumber}`} · User:{' '}
            {e.userName ?? 'Unavailable'}
            {e.reversesEntryId ? ' · reversal' : ''}
            <span className="mt-1 block font-mono text-sm tabular-nums">
              Debits {e.currency}{' '}
              {money(
                e.lines
                  .reduce(
                    (total, line) =>
                      total + (line.side === 'DEBIT' ? BigInt(line.amountMinor) : BigInt(0)),
                    BigInt(0)
                  )
                  .toString()
              )}
              {' · '}Credits {e.currency}{' '}
              {money(
                e.lines
                  .reduce(
                    (total, line) =>
                      total + (line.side === 'CREDIT' ? BigInt(line.amountMinor) : BigInt(0)),
                    BigInt(0)
                  )
                  .toString()
              )}
            </span>
          </summary>
          <p className="my-2 break-all text-xs text-text-muted">
            Entry {e.id} · source {e.sourceId} · {e.sourceKind} · user {e.actorId}
            {' · '}
            {financeEntryDescription(e.description)}
          </p>
          <ul>
            {e.lines.map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap justify-between gap-3 border-t border-border-subtle py-2 text-sm"
              >
                <span title={l.accountCode}>
                  {financeAccountLabel(l.accountCode)} · {l.side === 'DEBIT' ? 'Debit' : 'Credit'}
                  {l.lotId ? ` · ${result.journalLabels?.lots[l.lotId] ?? `lot ${l.lotId}`}` : ''}
                </span>
                <span className="font-mono">
                  {e.currency} {money(l.amountMinor)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ))}
      {!result.journal.length && (
        <p className="mt-3 text-sm text-text-muted">No journal entries on this page.</p>
      )}
      <nav aria-label="Journal pages" className="mt-3 flex gap-4">
        {result.page > 1 && (
          <Link className="min-h-11 underline" href={href(result.page - 1)}>
            Previous
          </Link>
        )}
        {result.page * 25 < result.journalCount && (
          <Link className="min-h-11 underline" href={href(result.page + 1)}>
            Next
          </Link>
        )}
      </nav>
    </SectionCard>
  );
}
