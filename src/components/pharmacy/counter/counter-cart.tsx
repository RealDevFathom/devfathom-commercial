'use client';

import { StatusPill } from '@/components/ui/status-pill';
import type { CounterCart } from '@/lib/pharmacy/counter';
import { formatMinor, formatReceiptDate } from '@/lib/pharmacy/counter-receipt';

export type CounterCartPanelProps = {
  cart: CounterCart | null;
  state: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | null;
  onRetry: () => void;
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
  now = new Date(),
}: CounterCartPanelProps) {
  if (state === 'idle' || (state === 'ready' && cart === null)) {
    return (
      <p className="text-sm text-text-muted">
        No bill is open. Search for a medicine and add a line to start one.
      </p>
    );
  }

  if (state === 'loading') {
    return (
      <p className="text-sm text-text-muted" role="status">
        Loading the bill…
      </p>
    );
  }

  if (state === 'error' || cart === null) {
    return (
      <div className="space-y-2" role="alert">
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
      <p className="text-sm text-text-muted">
        This bill is open with no lines yet. Scan or search a medicine, choose its sale unit, then
        add it to the cart.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border-subtle" aria-label="Cart lines">
        {cart.lines.map((line) => (
          <li key={line.saleLineId} className="py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-semibold text-text-strong">
                {line.quantity} × {line.medicineName}
                {line.strength ? (
                  <span className="ml-1 font-normal text-text-body">{line.strength}</span>
                ) : null}
              </span>
              <span className="w-24 shrink-0 text-right font-mono text-sm tabular-nums text-text-strong">
                {formatMinor(line.lineTotalMinor)}
              </span>
            </div>
            <p className="truncate text-xs text-text-muted">
              {line.presentation} · {line.saleUnit.toLowerCase()} · {line.canonicalUnits} units · Gross{' '}
              {formatMinor(line.lineTotalMinor + line.discountMinor)}
              {line.discountMinor > 0 ? ` · less ${formatMinor(line.discountMinor)}` : ''}
            </p>
            {line.controlled ||
            line.rx ||
            line.restricted ||
            line.highAlert ||
            line.lasa ||
            line.coldChain ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {line.controlled ? (
                  <StatusPill
                    status="controlled"
                    tone="danger"
                    label="Controlled"
                    className="shrink-0"
                  />
                ) : null}
                {line.rx ? (
                  <StatusPill
                    status="prescription"
                    tone="warning"
                    label="Prescription only"
                    className="shrink-0"
                  />
                ) : null}
                {line.restricted ? (
                  <StatusPill
                    status="restricted"
                    tone="warning"
                    label="Restricted"
                    className="shrink-0"
                  />
                ) : null}
                {line.highAlert ? (
                  <StatusPill
                    status="high-alert"
                    tone="danger"
                    label="High alert"
                    className="shrink-0"
                  />
                ) : null}
                {line.lasa ? (
                  <StatusPill
                    status="look-alike"
                    tone="warning"
                    label="Look-alike"
                    className="shrink-0"
                  />
                ) : null}
                {line.coldChain ? (
                  <StatusPill
                    status="cold-chain"
                    tone="info"
                    label="Cold chain"
                    className="shrink-0"
                  />
                ) : null}
              </div>
            ) : null}

            <ul className="mt-1" aria-label={`FEFO allocation for ${line.medicineName}`}>
              {line.allocations.map((allocation) => (
                <li
                  key={allocation.inventoryLotId}
                  className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted"
                >
                  <span className="font-mono tabular-nums">Batch {allocation.batchNumber}</span>
                  <span className="font-mono tabular-nums">
                    Exp {formatReceiptDate(allocation.expiresAt)}
                  </span>
                  <span className="font-mono tabular-nums">{allocation.canonicalUnits} units</span>
                  {allocation.stockLocationCode ? (
                    <span className="font-mono tabular-nums">{allocation.stockLocationCode}</span>
                  ) : null}
                  {allocation.overridden ? (
                    <StatusPill status="override" tone="warning" label="Batch override" />
                  ) : (
                    <StatusPill status="fefo" tone="neutral" label="FEFO" />
                  )}
                  <NearExpiryPill expiresAt={allocation.expiresAt} now={now} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <dl className="space-y-1 border-t border-border-subtle pt-2 text-sm">
        {(
          [
            ['Gross', cart.totals.grossMinor],
            ['Discount', cart.totals.discountMinor],
            ['Total', cart.totals.netMinor],
            ['Tendered', cart.totals.tenderedMinor],
            ['Balance', cart.totals.netMinor - cart.totals.tenderedMinor],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-text-muted">{label}</dt>
            <dd className="w-24 shrink-0 text-right font-mono tabular-nums text-text-strong">
              {formatMinor(value)}
            </dd>
          </div>
        ))}
      </dl>
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
  const buttonClass =
    'inline-flex h-11 items-center rounded-md border border-border-subtle bg-surface-card px-4 text-sm font-semibold text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50';

  if (value === null) {
    return (
      <button
        type="button"
        className={buttonClass}
        aria-expanded={false}
        disabled={disabled}
        onClick={() => onChange({ inventoryLotId: null, reason: '' })}
      >
        Sell a different batch
      </button>
    );
  }

  const fefoLotId = lots.find(
    (lot) => lot.blockedBy === null && lot.sellableUnits > 0
  )?.inventoryLotId;
  const reasonMissing = value.inventoryLotId !== null && value.reason.trim() === '';

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
                <span>Exp {formatReceiptDate(lot.expiresAt)}</span>
                <span>{lot.sellableUnits} units</span>
                {fefo ? <StatusPill status="fefo" tone="neutral" label="FEFO" /> : null}
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

      <button
        type="button"
        className={buttonClass}
        aria-expanded={true}
        disabled={disabled}
        onClick={() => onChange(null)}
      >
        Keep FEFO batch
      </button>
    </div>
  );
}
