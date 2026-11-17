'use client';

import { useState } from 'react';

import { StatusPill } from '@/components/ui/status-pill';
import type { CounterCart } from '@/lib/pharmacy/counter';
import type { CounterAlert } from '@/lib/pharmacy/counter-alerts';
import { formatMinor, formatShortExpiry } from '@/lib/pharmacy/counter-receipt';

export type CounterCartPanelProps = {
  cart: CounterCart | null;
  state: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | null;
  onRetry: () => void;
  alerts?: readonly CounterAlert[];
  /** The instant near-expiry is measured from; injectable for tests. */
  now?: Date;
};

/** PH-A4: a batch this close to expiry is flagged at the counter. */
export const NEAR_EXPIRY_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until `expiresAt` when under {@link NEAR_EXPIRY_DAYS}; otherwise null. */
export function nearExpiryDays(expiresAt: string, now: Date): number | null {
  const days = Math.floor((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS);
  return days >= 0 && days < NEAR_EXPIRY_DAYS ? days : null;
}

function NearExpiryPill({ expiresAt, now }: { expiresAt: string; now: Date }) {
  const days = nearExpiryDays(expiresAt, now);
  return days === null ? null : (
    <StatusPill status="near-expiry" tone="warning" label={`Near expiry · ${days} d`} />
  );
}

/**
 * POS-03 — the cart, showing the FEFO allocation each line actually drew.
 *
 * The allocation is not decoration. A line filled from two batches, or from a
 * batch that is not the earliest-expiring one, is a fact the operator has to be
 * able to read off the screen before handing the medicine over — and it is what
 * makes an override visible instead of silent.
 */
export function CounterCartPanel({
  cart,
  state,
  error,
  onRetry,
  alerts = [],
  now = new Date(),
}: CounterCartPanelProps) {
  if (state === 'idle' || (state === 'ready' && cart === null)) {
    return (
      <p className="p-4 text-sm text-text-muted">
        No bill is open. Search for a medicine and add a line to start one.
      </p>
    );
  }

  if (state === 'loading') {
    return (
      <p className="p-4 text-sm text-text-muted" role="status">
        Loading the bill…
      </p>
    );
  }

  if (state === 'error' || cart === null) {
    return (
      <div className="space-y-2 p-4" role="alert">
        <p className="text-sm text-destructive">{error ?? 'The bill could not be loaded.'}</p>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-11 items-center rounded-md border border-border-subtle bg-surface-card px-4 text-sm font-semibold text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Retry
        </button>
      </div>
    );
  }

  if (cart.lines.length === 0) {
    // UX rules 1 and 9: name no identifier the operator cannot act on, and say
    // how to populate the empty state rather than only that it is empty.
    return (
      <p className="p-4 text-sm text-text-muted">
        This bill is open with no lines yet. Scan or search a medicine, choose its sale unit, then
        add it to the cart.
      </p>
    );
  }

  return (
    <div className="min-w-0 overflow-x-auto">
      <table role="table" className="block w-full lg:table" aria-label="Cart lines">
        <thead className="sr-only bg-surface-sunken lg:not-sr-only lg:table-header-group">
          <tr
            role="row"
            className="font-mono text-xs tracking-wide text-text-muted uppercase"
          >
            {['#', 'Medicine', 'Unit × qty', 'Batch · Expiry', 'Amount'].map((heading) => (
              <th
                key={heading}
                scope="col"
                role="columnheader"
                className="py-2 pr-4 text-left font-medium first:pl-4 last:text-right"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        {cart.lines.map((line, index) => {
          const lineAlerts = alerts.filter((alert) => alert.saleLineRef === line.saleLineId);
          return (
            <tbody
              key={line.saleLineId}
              role="rowgroup"
              className="block border-t border-border-subtle lg:table-row-group"
            >
              <tr
                role="row"
                className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-3 gap-y-1 p-4 align-top hover:bg-surface-sunken/50 lg:table-row"
              >
                <td
                  role="cell"
                  className="row-span-3 font-mono text-xs tabular-nums text-text-muted lg:px-4 lg:py-3"
                >
                  {index + 1}
                </td>
                <th
                  scope="row"
                  role="rowheader"
                  className="min-w-0 text-left font-normal lg:w-2/5 lg:py-3 lg:pr-4"
                >
                  <p className="text-sm font-semibold text-text-strong">
                    {line.medicineName}
                    {line.strength ? (
                      <span className="ml-1 font-normal text-text-body">{line.strength}</span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-xs text-text-muted">
                    {line.presentation} · {line.saleUnit.toLowerCase()} · {line.canonicalUnits}{' '}
                    units @ {formatMinor(line.unitPriceMinor)}
                    {line.discountMinor > 0 ? ` · less ${formatMinor(line.discountMinor)}` : ''}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {line.controlled ? (
                      <StatusPill status="controlled" tone="danger" label="Controlled" />
                    ) : null}
                    {line.rx ? (
                      <StatusPill status="prescription" tone="warning" label="Prescription only" />
                    ) : null}
                    {line.restricted ? (
                      <StatusPill status="restricted" tone="warning" label="Restricted" />
                    ) : null}
                    {line.highAlert ? (
                      <StatusPill status="high-alert" tone="danger" label="High alert" />
                    ) : null}
                    {line.lasa ? (
                      <StatusPill status="look-alike" tone="warning" label="Look-alike" />
                    ) : null}
                    {line.coldChain ? (
                      <StatusPill status="cold-chain" tone="info" label="Cold chain" />
                    ) : null}
                  </div>
                </th>
                <td role="cell" className="col-span-2 col-start-2 row-start-2 lg:py-3 lg:pr-4">
                  <p className="font-mono text-sm font-semibold tabular-nums text-text-strong">
                    {line.quantity} × {line.saleUnit.toLowerCase()}
                  </p>
                  <p className="text-xs text-text-muted">{line.canonicalUnits} units</p>
                </td>
                <td role="cell" className="col-span-2 col-start-2 row-start-3 lg:py-3 lg:pr-4">
                  <ul
                    className="space-y-2"
                    aria-label={`Batch allocation for ${line.medicineName}`}
                  >
                    {line.allocations.map((allocation) => (
                      <li
                        key={allocation.inventoryLotId}
                        className="space-y-1 text-xs text-text-muted"
                      >
                        <div className="flex flex-wrap gap-x-2 font-mono tabular-nums">
                          <span className="font-semibold text-text-strong">
                            Batch {allocation.batchNumber}
                          </span>
                          <span>{formatShortExpiry(allocation.expiresAt)}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {allocation.stockLocationCode ? (
                            <span className="font-mono">Rack {allocation.stockLocationCode}</span>
                          ) : null}
                          <span className="font-mono tabular-nums">
                            {allocation.canonicalUnits} units
                          </span>
                          {allocation.overridden ? (
                            <StatusPill status="override" tone="warning" label="Batch override" />
                          ) : allocation.overridden === false ? (
                            <StatusPill status="fefo" tone="neutral" label="Earliest expiry" />
                          ) : null}
                          <NearExpiryPill expiresAt={allocation.expiresAt} now={now} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </td>
                <td
                  role="cell"
                  className="col-start-3 row-start-1 text-right font-mono text-sm font-semibold tabular-nums text-text-strong lg:py-3 lg:pr-4"
                >
                  {formatMinor(line.lineTotalMinor)}
                </td>
              </tr>
              {lineAlerts.length > 0 ? (
                <tr role="row" className="block lg:table-row">
                  <td role="cell" className="hidden lg:table-cell" />
                  <td role="cell" colSpan={4} className="block px-4 pb-3 lg:table-cell lg:pl-0">
                    <div className="space-y-2">
                      {lineAlerts.map((alert) => (
                        <div
                          key={alert.key}
                          role={alert.severity === 'SAFETY_BLOCK' ? 'alert' : undefined}
                          className={
                            alert.severity === 'SAFETY_BLOCK'
                              ? 'rounded-md bg-destructive/10 p-3 text-xs text-destructive'
                              : 'rounded-md bg-surface-sunken p-3 text-xs text-text-body'
                          }
                        >
                          <div className="flex flex-wrap items-center gap-2 font-semibold">
                            <StatusPill
                              status={alert.severity}
                              tone={
                                alert.severity === 'SAFETY_BLOCK'
                                  ? 'danger'
                                  : alert.severity === 'CLINICAL_ADVICE'
                                    ? 'warning'
                                    : 'neutral'
                              }
                              label={
                                alert.severity === 'SAFETY_BLOCK'
                                  ? 'Safety block'
                                  : alert.severity === 'CLINICAL_ADVICE'
                                    ? 'Clinical advice'
                                    : 'Commercial'
                              }
                            />
                            <span>{alert.message}</span>
                          </div>
                          {alert.remedy ? <p className="mt-1">{alert.remedy}</p> : null}
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

/** One lot a counter batch override may choose, as `counterLotOptions` returns it. */
export type CounterLotOption = {
  inventoryLotId: string;
  batchNumber: string;
  expiresAt: string;
  sellableUnits: number;
  blockedBy: string | null;
};

/**
 * An open override. `inventoryLotId` is null while the FEFO lot is selected —
 * choosing the recommended lot is not an override and records nothing.
 */
export type CounterLotOverrideValue = { inventoryLotId: string | null; reason: string };

const BLOCK_LABEL: Record<string, string> = {
  EXPIRED: 'Expired',
  RECALLED: 'Recalled',
  QUARANTINED: 'Quarantined',
  DAMAGED: 'Damaged',
  DESTROYED: 'Destroyed',
  IN_TRANSIT: 'In transit',
  RETURNED_TO_SUPPLIER: 'Returned to supplier',
  UNRECEIVED: 'Not yet received',
  EMPTY: 'No stock',
};

export type CounterLotOverrideProps = {
  value: CounterLotOverrideValue | null;
  lots: readonly CounterLotOption[];
  state: 'loading' | 'ready' | 'error';
  error?: string | null;
  disabled?: boolean;
  now?: Date;
  onChange: (value: CounterLotOverrideValue | null) => void;
  onRetry: () => void;
};

/**
 * PH-A4 — sell a batch other than the one FEFO recommends.
 *
 * The earliest-expiring sellable lot is preselected and labelled FEFO; picking
 * any other lot requires a reason, which the server records as an override row
 * and a labelled audit entry. Blocked lots stay listed, disabled, with why.
 * Native radios and a textarea, so the whole flow works from the keyboard.
 */
export function CounterLotOverride({
  value,
  lots,
  state,
  error,
  disabled = false,
  now = new Date(),
  onChange,
  onRetry,
}: CounterLotOverrideProps) {
  const [applied, setApplied] = useState(false);
  const buttonClass =
    'inline-flex h-11 items-center rounded-md border border-border-subtle bg-surface-card px-4 text-sm font-semibold text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50';

  if (value === null) {
    return (
      <button
        type="button"
        className={buttonClass}
        aria-expanded={false}
        disabled={disabled}
        onClick={() => {
          setApplied(false);
          onChange({ inventoryLotId: null, reason: '' });
        }}
      >
        Sell a different batch
      </button>
    );
  }

  const fefoLotId = lots.find(
    (lot) => lot.blockedBy === null && lot.sellableUnits > 0
  )?.inventoryLotId;
  const reasonMissing = value.inventoryLotId !== null && value.reason.trim() === '';
  const chosenLot =
    value.inventoryLotId === null
      ? undefined
      : lots.find((lot) => lot.inventoryLotId === value.inventoryLotId);

  if (applied && chosenLot && !reasonMissing) {
    return (
      <div className="space-y-2" role="status" data-testid="counter-lot-override-applied">
        <p className="text-sm font-semibold text-text-strong">
          Batch {chosenLot.batchNumber} will be sold on this line (not the earliest-expiry batch).
        </p>
        <p className="text-xs text-text-muted">Reason: {value.reason.trim()}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={disabled}
            onClick={() => setApplied(false)}
          >
            Change batch
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={disabled}
            onClick={() => {
              setApplied(false);
              onChange(null);
            }}
          >
            Use earliest-expiry batch
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {state === 'loading' ? (
        <p className="text-sm text-text-muted" role="status">
          Loading batches…
        </p>
      ) : state === 'error' ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-destructive">{error ?? 'Batches could not be loaded.'}</p>
          <button type="button" className={buttonClass} onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : lots.length === 0 ? (
        <p className="text-sm text-text-muted">No batch of this medicine is on hand here.</p>
      ) : (
        <fieldset disabled={disabled} className="space-y-1">
          <legend className="text-sm font-semibold text-text-strong">Batch to sell</legend>
          {lots.map((lot) => {
            const fefo = lot.inventoryLotId === fefoLotId;
            const checked = fefo
              ? value.inventoryLotId === null
              : value.inventoryLotId === lot.inventoryLotId;
            const blocked = lot.blockedBy !== null || lot.sellableUnits <= 0;
            return (
              <label
                key={lot.inventoryLotId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-surface-sunken px-3 py-1.5 font-mono text-xs tabular-nums text-text-body"
              >
                <input
                  type="radio"
                  name="counter-lot-override"
                  value={lot.inventoryLotId}
                  checked={checked}
                  disabled={blocked}
                  onChange={() =>
                    onChange({ ...value, inventoryLotId: fefo ? null : lot.inventoryLotId })
                  }
                />
                <span>Batch {lot.batchNumber}</span>
                <span>{formatShortExpiry(lot.expiresAt)}</span>
                <span>{lot.sellableUnits} units</span>
                {fefo ? <StatusPill status="fefo" tone="neutral" label="Earliest expiry" /> : null}
                {blocked ? (
                  <StatusPill
                    status="blocked"
                    tone="danger"
                    label={BLOCK_LABEL[lot.blockedBy ?? 'EMPTY'] ?? 'Not sellable'}
                  />
                ) : (
                  <NearExpiryPill expiresAt={lot.expiresAt} now={now} />
                )}
              </label>
            );
          })}
        </fieldset>
      )}

      {value.inventoryLotId !== null ? (
        <div className="space-y-1">
          <label
            htmlFor="counter-lot-override-reason"
            className="block text-sm font-semibold text-text-strong"
          >
            Override reason
          </label>
          <textarea
            id="counter-lot-override-reason"
            required
            maxLength={500}
            rows={2}
            disabled={disabled}
            aria-invalid={reasonMissing}
            aria-describedby="counter-lot-override-hint"
            value={value.reason}
            onChange={(event) => onChange({ ...value, reason: event.target.value })}
            className="w-full rounded-md border border-border-subtle bg-surface-card px-3 py-2 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <p id="counter-lot-override-hint" className="text-xs text-text-muted">
            Required. Recorded with your name against this bill.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {value.inventoryLotId !== null ? (
          <button
            type="button"
            className={buttonClass}
            disabled={disabled || reasonMissing}
            onClick={() => setApplied(true)}
          >
            Use batch {chosenLot?.batchNumber ?? ''}
          </button>
        ) : null}
        <button
          type="button"
          className={buttonClass}
          aria-expanded={true}
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          Use earliest-expiry batch
        </button>
      </div>
    </div>
  );
}
