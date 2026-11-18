'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { formulaSafeCell } from '@/lib/pharmacy/reference-connectors';

type Credit = { id: string; supplierId: string; reference: string; unallocatedMinor: number };
export type FollowUpPacketData = {
  branch: { id: string; name: string };
  from: string;
  to: string;
  preparedAt: string;
  currency: string | null;
  coverage: 'complete' | 'partial';
  excluded: number;
  rows: {
    id: string;
    supplierId: string;
    supplier: string;
    returnId: string;
    returnReference: string;
    debitReference: string | null;
    status: 'DISPATCHED' | 'SUBMITTED';
    dispatchedAt: string | null;
    deadline: string | null;
    window: 'review' | 'closed' | 'unknown' | null;
    ageDays: number | null;
    outstandingMinor: number | null;
    allocatedMinor: number | null;
    credits: Credit[];
  }[];
};

const DEFINITION =
  'Outstanding = issued debit expectation less recorded allocations. Candidate credit is not settlement, cash recovered or revenue. Do not add repeated credit across claims.';
const COVERAGE =
  'Partial coverage: selected return creation dates and records visible to existing readers; not branch totals. Reads are not an atomic or historical snapshot. Missing records or credit do not prove zero debt.';
const FRESHNESS =
  'Prepared from current records. Allocations can change; prepare again before reconciliation. Copy and export retain this draft snapshot.';
const SOURCE = 'pharmacyPurchasing.purchaseReturns + pharmacyPurchasing.supplierCredits';
const amount = (value: number | null) =>
  value !== null && Number.isSafeInteger(value) && value >= 0 ? formatMinor(value) : 'Unknown';
const currencyLabel = (packet: FollowUpPacketData) => packet.currency ?? 'Currency unknown';
const currencyBasis =
  'Currency is the current organization setting; source records do not establish historical currency. Amounts are shown in rupees with two decimals.';
const uniqueCredits = (rows: FollowUpPacketData['rows']) => [
  ...new Map(rows.flatMap((row) => row.credits).map((credit) => [credit.id, credit])).values(),
];

// Reuse Pharmacy formula neutralization and the existing report CSV quoting pattern.
// Normalize control characters first so whitespace-prefixed formulas cannot bypass it.
function cell(value: unknown) {
  const text = formulaSafeCell(
    String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trimStart()
  );
  return `"${text.replaceAll('"', '""')}"`;
}

export function packetCsv(packet: FollowUpPacketData, supplierId: string) {
  const rows = packet.rows.filter((row) => row.supplierId === supplierId);
  const metadata = [
    'DRAFT',
    packet.branch.id,
    packet.branch.name,
    packet.from,
    packet.to,
    'Return created date, inclusive UTC; allocations current at preparation',
    currencyLabel(packet),
    currencyBasis,
    packet.preparedAt,
    packet.coverage,
    packet.excluded,
    SOURCE,
    DEFINITION,
    COVERAGE,
    FRESHNESS,
  ];
  const columns = [
    'pack_status',
    'branch_id',
    'branch',
    'from',
    'to',
    'period_definition',
    'currency',
    'currency_basis',
    'prepared_at',
    'coverage',
    'excluded_records',
    'source',
    'definition',
    'coverage_limit',
    'freshness',
    'supplier_id',
    'supplier',
    'kind',
    'return_reference',
    'debit_reference',
    'dispatch_status',
    'dispatched_at',
    'recorded_return_window_ends_at',
    'window_state',
    'issue_age_days',
    'outstanding_major',
    'allocated_major',
    'candidate_credit_reference',
    'unallocated_major',
  ];
  const evidence = rows.map((row) => [
    ...metadata,
    supplierId,
    row.supplier,
    'return/debit',
    row.returnReference,
    row.debitReference ?? 'No qualifying issued debit note',
    row.status,
    row.dispatchedAt ?? 'Not recorded',
    row.deadline ?? 'Unknown / not a credit due date',
    row.window ?? 'Not applicable',
    row.ageDays ?? 'Unknown',
    amount(row.outstandingMinor),
    amount(row.allocatedMinor),
    '',
    '',
  ]);
  for (const credit of uniqueCredits(rows)) {
    evidence.push([
      ...metadata,
      supplierId,
      rows[0]!.supplier,
      'candidate credit',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      credit.reference,
      amount(credit.unallocatedMinor),
    ]);
  }
  return [columns, ...evidence].map((row) => row.map(cell).join(',')).join('\r\n');
}

function PacketActions({ packet, supplierId }: { packet: FollowUpPacketData; supplierId: string }) {
  const [message, setMessage] = useState('');
  const [copying, setCopying] = useState(false);
  async function copy() {
    setCopying(true);
    setMessage('Copying draft…');
    try {
      await navigator.clipboard.writeText(packetCsv(packet, supplierId));
      setMessage('Draft CSV copied. Review before sharing.');
    } catch {
      setMessage('Copy unavailable. Use Export draft CSV to save this evidence pack.');
    } finally {
      setCopying(false);
    }
  }
  function download() {
    let url: string | undefined;
    try {
      url = URL.createObjectURL(
        new Blob([packetCsv(packet, supplierId)], { type: 'text/csv;charset=utf-8' })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `supplier-credit-draft-${packet.from}-${packet.to}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setMessage('Draft CSV exported. Review before sharing.');
    } catch {
      setMessage('Export unavailable. Try Copy draft CSV.');
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }
  return (
    <div className="mt-4 space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="min-h-11" onClick={copy} disabled={copying}>
          {copying ? 'Copying draft…' : 'Copy draft CSV'}
        </Button>
        <Button variant="outline" className="min-h-11" onClick={download}>
          Export draft CSV
        </Button>
      </div>
      <p role="status" aria-live="polite" className="text-sm text-text-muted">
        {message}
      </p>
    </div>
  );
}

export function FollowUpPacket({ packet }: { packet: FollowUpPacketData }) {
  const suppliers = [
    ...new Map(packet.rows.map((row) => [row.supplierId, row.supplier])).entries(),
  ];
  const money = (minor: number | null) =>
    minor === null ? 'No qualifying issued note' : `${currencyLabel(packet)} ${amount(minor)}`;
  return (
    <div className="min-w-0 space-y-6">
      <SectionCard title="Draft evidence scope" titleLevel={2}>
        <StatusPill status="draft" label="Draft · read-only" />
        <p className="mt-3 text-sm text-text-body">
          Branch: {packet.branch.name}. Return creation period: {packet.from} to {packet.to},
          inclusive UTC. Prepared at: {packet.preparedAt}. Currency: {currencyLabel(packet)}.
        </p>
        <p className="mt-2 text-sm text-text-muted">{currencyBasis}</p>
        <p className="mt-2 text-sm text-text-muted">{DEFINITION}</p>
        <p role="status" className="mt-2 text-sm text-warning">
          {COVERAGE}
        </p>
        <p className="mt-2 text-sm text-text-muted">{FRESHNESS}</p>
        <p className="mt-2 text-sm text-text-muted">
          Age is time since debit issue, not a contractual overdue deadline. Return windows apply to
          undispatched returns only. No supplier message, allocation or posting is performed.
        </p>
        <p className="mt-2 break-words text-xs text-text-muted">Source: {SOURCE}.</p>
        {packet.excluded > 0 ? (
          <p role="status" className="mt-2 text-sm text-warning">
            {packet.excluded} records excluded because scope, date or financial data could not be
            validated.
          </p>
        ) : null}
      </SectionCard>
      {!suppliers.length ? (
        <SectionCard title="No qualifying follow-up records" titleLevel={2}>
          <p className="text-sm text-text-muted">
            No open issued debit notes on dispatched returns or submitted, undispatched returns were
            found in the selected records. Broaden the date range or review Returns &amp; claims.
            This does not confirm a zero supplier balance.
          </p>
        </SectionCard>
      ) : (
        suppliers.map(([supplierId, supplier]) => {
          const rows = packet.rows.filter((row) => row.supplierId === supplierId);
          const credits = uniqueCredits(rows);
          return (
            <SectionCard key={supplierId} title={supplier} titleLevel={2}>
              <div
                role="region"
                aria-label={`${supplier} return evidence`}
                tabIndex={0}
                className="overflow-x-auto rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
              >
                <table className="w-full text-sm">
                  <caption className="sr-only">{supplier} draft return and debit evidence</caption>
                  <thead className="text-left font-mono text-xs uppercase text-text-muted">
                    <tr>
                      <th scope="col" className="p-3">
                        Return / debit
                      </th>
                      <th scope="col" className="p-3">
                        Dispatch / window
                      </th>
                      <th scope="col" className="p-3 text-right">
                        Outstanding / allocated
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {rows.map((row) => (
                      <tr
                        key={`${row.status}-${row.id}`}
                        className="align-top hover:bg-surface-sunken"
                      >
                        <td className="p-3 break-words">
                          <a
                            className="inline-flex min-h-11 items-center rounded-sm underline underline-offset-4 hover:text-text-muted focus-visible:outline-2 focus-visible:outline-ring"
                            href={`/pharmacy/purchasing/returns?${new URLSearchParams({ branch: packet.branch.id, return: row.returnId })}`}
                          >
                            {row.returnReference}
                          </a>
                          <p>{row.debitReference ?? 'No qualifying issued debit note'}</p>
                          {row.debitReference ? (
                            <p className="text-xs text-text-muted">
                              {row.ageDays === null
                                ? 'Issue age unknown'
                                : `${row.ageDays} full days since issue`}
                            </p>
                          ) : null}
                        </td>
                        <td className="p-3">
                          <StatusPill
                            status={row.status}
                            label={
                              row.status === 'DISPATCHED'
                                ? 'Dispatched'
                                : 'Submitted · undispatched'
                            }
                          />
                          {row.status === 'DISPATCHED' ? (
                            <p className="mt-2 text-xs">
                              {row.dispatchedAt ?? 'Dispatch timestamp not recorded'}
                            </p>
                          ) : (
                            <>
                              <p className="mt-2">
                                {row.window === 'closed'
                                  ? 'Return window closed — do not dispatch.'
                                  : row.window === 'review'
                                    ? 'Review recorded return window before dispatch.'
                                    : 'Return window unknown — verify source records.'}
                              </p>
                              {row.deadline ? (
                                <p className="text-xs">
                                  Earliest recorded return deadline: {row.deadline}
                                </p>
                              ) : null}
                            </>
                          )}
                        </td>
                        <td className="p-3 text-right tabular-nums">
                          <p>{money(row.outstandingMinor)}</p>
                          {row.allocatedMinor !== null ? (
                            <p className="text-xs text-text-muted">
                              {money(row.allocatedMinor)} allocated
                            </p>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3 className="mt-4 font-medium text-text-strong">
                Same-supplier unallocated credit · candidates only
              </h3>
              {credits.length ? (
                <ul className="mt-2 divide-y divide-border-subtle">
                  {credits.map((credit) => (
                    <li
                      key={credit.id}
                      className="flex flex-wrap justify-between gap-2 py-2 text-sm"
                    >
                      <span className="break-words">{credit.reference}</span>
                      <span className="tabular-nums">
                        {money(credit.unallocatedMinor)} unallocated
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-text-muted">
                  No matching unallocated credit in validated loaded claim records; this does not
                  prove none exists.
                </p>
              )}
              <PacketActions key={packet.preparedAt} packet={packet} supplierId={supplierId} />
            </SectionCard>
          );
        })
      )}
    </div>
  );
}
