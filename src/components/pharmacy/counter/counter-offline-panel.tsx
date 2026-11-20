'use client';

import { useId, useState } from 'react';
import Link from 'next/link';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { searchOfflineCatalogue } from '@/lib/pharmacy/counter-offline-catalogue';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';

import type { CounterOfflineView } from './use-counter-offline';
import { CounterSalesToReconcile } from './counter-sales-to-reconcile';
import {
  CounterOfflineSale,
  OfflinePaidCard,
  OfflineQueue,
  type OfflinePaid,
} from './counter-offline-sale';

/** Whole hours (rounded down) between two instants, never negative. */
function wholeHours(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / 3_600_000));
}

function ago(iso: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min ago`;
}

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? 'unknown'
    : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const SETTINGS_HREF = '/pharmacy/settings/counters';

/**
 * DEV-957 phase 1: what the counter can still do with no connection, inside the
 * counter's Offline banner. Plain words for every state: not set up, set up for
 * another branch, opening, unsupported browser, price list expired, not
 * prepared, and ready (with the offline price check).
 */
export function CounterOfflinePanel({ offline }: { offline: CounterOfflineView }) {
  const { status, readiness, nowMs } = offline;
  // DEV-957 phase 2: the last offline sale's receipt and change stay on screen even when
  // that sale used the last receipt number or unit and no further sale can be taken.
  const [paid, setPaid] = useState<OfflinePaid | null>(null);
  if (status === 'unenrolled' && offline.revokedNotice)
    return (
      <p className="text-text-body" role="alert" data-counter-offline-mode="revoked">
        A manager revoked this counter, so it can no longer sell offline. Its price lists,
        receipt numbers and unfinished bills were removed from this computer.{' '}
        {offline.revokedNotice.kept > 0
          ? `${offline.revokedNotice.kept} offline sale${offline.revokedNotice.kept === 1 ? ' was' : 's were'} never sent. ${offline.revokedNotice.kept === 1 ? 'It is' : 'They are'} kept on this computer, read-only, under Sales to reconcile, for a manager to export and record. `
          : ''}
        A manager can enrol it again in{' '}
        <Link className="font-medium text-text-strong underline" href={SETTINGS_HREF}>
          Settings, Counter computers
        </Link>
        .
      </p>
    );
  if (status === 'unenrolled')
    return (
      <p className="text-text-body" data-counter-offline-mode="unenrolled">
        This computer is not set up for offline mode. While the connection is up, a manager can set
        it up in{' '}
        <Link className="font-medium text-text-strong underline" href={SETTINGS_HREF}>
          Settings, Counter computers
        </Link>
        .
      </p>
    );
  if (status === 'other-branch')
    return (
      <p className="text-text-body" data-counter-offline-mode="other-branch">
        This computer is set up as the offline counter {offline.enrolment?.name} of another branch.
        Choose that branch to use offline mode.
      </p>
    );
  if (status === 'opening')
    return (
      <p className="text-text-muted" role="status" data-counter-offline-mode="opening">
        Opening the last price list this counter checked…
      </p>
    );
  if (status === 'unsupported' || status === 'unavailable' || !readiness)
    return (
      <p className="text-text-body" data-counter-offline-mode={status}>
        {offline.message ?? 'Offline mode is not available on this computer.'}
      </p>
    );
  const selling =
    offline.sellingOn &&
    readiness.snapshotsReady &&
    readiness.prepared &&
    offline.actions !== null &&
    offline.rows.length > 0;
  return (
    <div className="space-y-3" data-counter-offline-mode="ready">
      {readiness.snapshotsReady ? (
        <>
          <p className="text-text-body">
            <span className="font-medium text-text-strong">Still works: </span>
            {selling
              ? `cash sales of the ${readiness.itemsAvailable} medicine${readiness.itemsAvailable === 1 ? '' : 's'} this counter holds offline stock for. Each sale is saved and sealed on this computer and waits there: this version does not send offline sales to the server yet.`
              : `price check of the ${readiness.itemsAvailable} medicine${readiness.itemsAvailable === 1 ? '' : 's'} this counter holds offline stock for.`}
          </p>
          {!offline.sellingOn ? (
            <p className="text-text-body" data-counter-offline-selling="off">
              <span className="font-medium text-text-strong">Offline cash selling is off: </span>
              it becomes available when sending offline sales to the server is ready. Take cash
              sales online, or write them by hand until the connection returns.
            </p>
          ) : null}
          <p className="text-text-body">
            <span className="font-medium text-text-strong">Never offline: </span>
            prescription-only, controlled and restricted medicines, card, wallet and khata
            payments, and refunds.
          </p>
        </>
      ) : (
        <p className="text-text-body">
          The signed price list on this computer has expired or is incomplete, so offline price
          check is off until the connection returns.
        </p>
      )}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
        <div>
          <dt className="eyebrow">Price list checked</dt>
          <dd className="text-text-strong tabular-nums">
            {readiness.priceListIssuedAt ? ago(readiness.priceListIssuedAt, nowMs) : 'never'}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Offline mode ends</dt>
          <dd className="text-text-strong tabular-nums">
            {readiness.offlineUntil && Date.parse(readiness.offlineUntil) > nowMs
              ? `${clock(readiness.offlineUntil)} (${wholeHours(nowMs, Date.parse(readiness.offlineUntil))} h left)`
              : 'ended'}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">Receipt numbers left</dt>
          <dd className="text-text-strong tabular-nums">{readiness.receiptNumbersLeft}</dd>
        </div>
      </dl>
      {!readiness.prepared ? (
        <p className="text-text-body">
          This counter is not prepared for offline selling: it holds no receipt numbers or no
          stock. While the connection is up, a manager can prepare it in{' '}
          <Link className="font-medium text-text-strong underline" href={SETTINGS_HREF}>
            Settings, Counter computers
          </Link>
          .
        </p>
      ) : null}
      {offline.message ? <p className="text-text-body">{offline.message}</p> : null}
      {selling ? (
        <CounterOfflineSale offline={offline} paid={paid} onPaid={setPaid} />
      ) : (
        <>
          {paid ? <OfflinePaidCard paid={paid} onNext={() => setPaid(null)} /> : null}
          {readiness.snapshotsReady && offline.rows.length > 0 ? (
            <OfflinePriceCheck offline={offline} />
          ) : null}
          {offline.queued.length > 0 ? <OfflineQueue queued={offline.queued} /> : null}
        </>
      )}
    </div>
  );
}

function OfflinePriceCheck({ offline }: { offline: CounterOfflineView }) {
  const inputId = useId();
  const [query, setQuery] = useState('');
  const results = searchOfflineCatalogue(offline.rows, query);
  const searching = query.trim().length >= 2;
  return (
    <div className="space-y-2 border-t border-border-subtle pt-3">
      <Label htmlFor={inputId}>Offline price check</Label>
      <Input
        id={inputId}
        type="search"
        className="min-h-11 max-w-md bg-surface-raised"
        value={query}
        autoComplete="off"
        placeholder="Type two letters of a medicine name"
        aria-describedby={`${inputId}-help`}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setQuery('');
        }}
      />
      <p id={`${inputId}-help`} className="text-xs text-text-muted">
        From the signed price list on this computer. Prices are the printed price of one sealed
        pack.
      </p>
      {searching ? (
        results.length ? (
          <ul aria-label="Offline price check results" className="divide-y divide-border-subtle">
            {results.map((row) => (
              <li
                key={`${row.inventoryLotId}:${row.stockLocationId}`}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
              >
                <div className="min-w-0">
                  <p className="break-words font-medium text-text-strong">{row.medicineName}</p>
                  <p className="text-xs text-text-muted">
                    {row.presentation} · {row.unitsPerPack} per pack · expires{' '}
                    {row.expiresAt.slice(0, 10)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-text-strong tabular-nums">
                    Rs {formatMinor(row.packPriceMinor)} a pack
                  </span>
                  <StatusPill
                    status="quota"
                    tone="neutral"
                    label={`${row.unitsLeft} unit${row.unitsLeft === 1 ? '' : 's'} offline`}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-body" role="status">
            No medicine this counter holds offline matches “{query.trim()}”. Prescription-only,
            controlled and restricted medicines are never listed offline.
          </p>
        )
      ) : null}
    </div>
  );
}

/**
 * DEV-957: the whole counter page when it opened with no connection and the
 * server never answered (for example, the stored page opened offline after the
 * browser was closed). Without this the counter would read "no branch".
 */
export function CounterOfflineOnly({ offline }: { offline: CounterOfflineView }) {
  return (
    <div className="space-y-6" data-counter-offline-only="">
      <PageHeader
        eyebrow="Pharmacy"
        heading="Counter"
        description="Offline: this counter cannot reach the server right now."
      />
      <section
        role="status"
        aria-live="polite"
        data-counter-offline=""
        aria-label="Offline"
        className="flex flex-wrap items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm"
      >
        <StatusPill status="offline" tone="warning" label="Offline" />
        <div className="min-w-0 flex-1 space-y-3">
          <p className="font-medium text-text-strong">
            Offline — this counter cannot reach the server.
          </p>
          <p className="text-text-body">
            Online bills, card and khata payments and the full search come back when the
            connection returns. This page checks again by itself.
          </p>
          <CounterOfflinePanel offline={offline} />
        </div>
      </section>
      {offline.enrolment ? (
        <CounterSalesToReconcile
          organizationId={offline.enrolment.organizationId}
          branchId={offline.enrolment.branchId}
          online={false}
        />
      ) : null}
    </div>
  );
}
