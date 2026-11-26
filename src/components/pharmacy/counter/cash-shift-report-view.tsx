'use client';

import { useApprovalSecretKind } from '@/components/pharmacy/own-approval-copy';
import { StatusPill } from '@/components/ui/status-pill';
import type { CashShiftReport, CashShiftTypeTotal } from '@/lib/pharmacy/cash-shift-report';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { tenderTypeLabel } from '@/lib/pharmacy/finance-labels';
import { workspaceTimezone } from '@/lib/timezone';

/** "09:12", read in the workspace's zone, never the viewer's browser's. */
export function shiftClockTime(at: string | Date | null, timeZone: string): string {
  if (!at) return '';
  return new Date(at).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: workspaceTimezone(timeZone),
  });
}

/** "Over 0.50", "Short 1.20" or "Balanced", so the sign is never the only cue. */
export function shiftVarianceLabel(varianceMinor: number, currency: string): string {
  if (varianceMinor === 0) return 'Balanced';
  return `${varianceMinor > 0 ? 'Over' : 'Short'} ${currency} ${formatMinor(Math.abs(varianceMinor))}`;
}

function TypeTable({
  caption,
  rows,
  currency,
  empty,
}: {
  caption: string;
  rows: readonly CashShiftTypeTotal[];
  currency: string;
  empty: string;
}) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="pb-1 text-left font-mono text-xs uppercase tracking-[0.08em] text-text-muted">
          {caption}
        </caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Method</th>
            <th scope="col">Count</th>
            <th scope="col">Amount ({currency})</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row) => (
              <tr key={row.type} className="border-t border-border-subtle">
                <th scope="row" className="py-1.5 pe-2 text-left font-normal text-text-body">
                  {tenderTypeLabel(row.type)}
                </th>
                <td className="py-1.5 pe-2 text-right font-mono tabular-nums text-text-muted">
                  {row.count}
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums text-text-strong">
                  {formatMinor(row.amountMinor)}
                </td>
              </tr>
            ))
          ) : (
            <tr className="border-t border-border-subtle">
              <td colSpan={3} className="py-1.5 text-text-muted">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function VarianceApproval({
  approver,
  closedById,
}: {
  approver: NonNullable<CashShiftReport['varianceApprovedBy']>;
  closedById?: string;
}) {
  const secret = useApprovalSecretKind() === 'CODE' ? 'authenticator code' : 'PIN';
  return (
    <p className="text-sm text-text-muted">
      Over or short approved by {approver.name ?? 'a former team member'}
      {approver.id === closedById
        ? ` (their own close, with their ${secret})`
        : ` with their ${secret}`}
      .
    </p>
  );
}

/**
 * DEV-958B: one cash shift's report: sales by payment method, refunds, cash in and out, the
 * cash expected and counted, the over or short, and who opened and closed it, when. The figures
 * come from the server (frozen on the shift at its close); nothing is worked out here.
 */
export function CashShiftReportView({
  report,
  status,
  currency,
  timeZone,
  headingLevel = 3,
}: {
  report: CashShiftReport;
  status: 'OPEN' | 'CLOSED';
  currency: string;
  timeZone: string;
  headingLevel?: 2 | 3 | 4;
}) {
  const Heading = `h${headingLevel}` as const;
  const cashLines: [string, number, boolean?][] = [
    [report.sequence === 1 ? 'Opening float' : 'Opening count', report.cash.openingFloatMinor],
    ['Cash sales', report.cash.cashSalesMinor],
    ['Cash refunds', -report.cash.cashRefundsMinor],
    ['Paid in', report.cash.paidInMinor],
    ['Paid out', -report.cash.paidOutMinor],
    ['Cash expected', report.cash.expectedMinor, true],
  ];
  const variance = report.varianceMinor;
  return (
    <section
      aria-labelledby={`shift-report-${report.shiftId}`}
      className="space-y-3 rounded-[var(--radius-sm)] border border-border-subtle bg-surface-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <Heading
            id={`shift-report-${report.shiftId}`}
            className="text-sm font-semibold text-text-strong"
          >
            Shift {report.sequence} · {report.cashier.name ?? 'Former team member'}
          </Heading>
          <p className="text-sm text-text-muted">
            Opened {shiftClockTime(report.openedAt, timeZone)} by{' '}
            {report.openedBy.name ?? 'a former team member'}
            {report.closedAt
              ? ` · closed ${shiftClockTime(report.closedAt, timeZone)} by ${report.closedBy?.name ?? 'a former team member'}`
              : ''}
          </p>
        </div>
        {status === 'OPEN' ? (
          <StatusPill status="shift-open" tone="success" label="Open" />
        ) : variance === null || variance === 0 ? (
          <StatusPill status="shift-closed" tone="neutral" label="Closed · balanced" />
        ) : (
          <StatusPill
            status="shift-closed"
            tone="warning"
            label={`Closed · ${shiftVarianceLabel(variance, currency)}`}
          />
        )}
      </div>
      <div className="grid gap-4">
        <TypeTable
          caption={`Sales by payment (${report.salesCount} ${report.salesCount === 1 ? 'bill' : 'bills'})`}
          rows={report.tenders}
          currency={currency}
          empty="No payments in this shift."
        />
        <TypeTable
          caption="Refunds"
          rows={report.refunds}
          currency={currency}
          empty="No refunds in this shift."
        />
      </div>
      {/* DEV-977B: lines changed to fewer units or removed on open bills; no cash moved. */}
      {report.lineVoids ? (
        <dl className="text-sm" aria-label={`Shift ${report.sequence} lines taken off bills`}>
          <div className="flex justify-between gap-3 border-t border-border-subtle py-1.5">
            <dt className="text-text-body">Lines taken off bills ({report.lineVoids.count})</dt>
            <dd className="font-mono tabular-nums text-text-strong">
              {currency} {formatMinor(report.lineVoids.valueMinor)}
            </dd>
          </div>
        </dl>
      ) : null}
      <dl className="text-sm" aria-label={`Shift ${report.sequence} cash`}>
        {cashLines.map(([term, value, strong]) => (
          <div
            key={term}
            className="flex justify-between gap-3 border-t border-border-subtle py-1.5"
          >
            <dt className={strong ? 'font-semibold text-text-strong' : 'text-text-body'}>{term}</dt>
            <dd className="font-mono tabular-nums text-text-strong">
              {currency} {formatMinor(value)}
            </dd>
          </div>
        ))}
        {report.countedMinor !== null ? (
          <div className="flex justify-between gap-3 border-t border-border-subtle py-1.5">
            <dt className="font-semibold text-text-strong">Cash counted</dt>
            <dd className="font-mono tabular-nums text-text-strong">
              {currency} {formatMinor(report.countedMinor)}
            </dd>
          </div>
        ) : null}
        {variance !== null ? (
          <div className="flex justify-between gap-3 border-t border-border-subtle py-1.5">
            <dt className="font-semibold text-text-strong">Over or short</dt>
            <dd
              className={`font-mono tabular-nums ${variance === 0 ? 'text-success' : 'text-warning'}`}
            >
              {shiftVarianceLabel(variance, currency)}
            </dd>
          </div>
        ) : null}
      </dl>
      {report.openingDifferenceMinor !== 0 ? (
        <p className="text-sm text-text-body">
          Opened {report.openingDifferenceMinor > 0 ? 'with' : 'short by'} {currency}{' '}
          {formatMinor(Math.abs(report.openingDifferenceMinor))}{' '}
          {report.openingDifferenceMinor > 0 ? 'more than' : 'against'} the last shift left
          {report.openingNote ? `: ${report.openingNote}` : '.'}
        </p>
      ) : null}
      {report.varianceNote ? (
        <p className="text-sm text-text-body">Note: {report.varianceNote}</p>
      ) : null}
      {report.varianceApprovedBy ? (
        <VarianceApproval approver={report.varianceApprovedBy} closedById={report.closedBy?.id} />
      ) : null}
    </section>
  );
}
