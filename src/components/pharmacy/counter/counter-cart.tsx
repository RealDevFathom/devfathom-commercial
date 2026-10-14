'use client';

import { StatusPill } from '@/components/ui/status-pill';
import type { CounterCart } from '@/lib/pharmacy/counter';
import { formatMinor, formatReceiptDate } from '@/lib/pharmacy/counter-receipt';

export type CounterCartPanelProps = {
  cart: CounterCart | null;
  state: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | null;
  onRetry: () => void;
};

/**
 * POS-03 — the cart, showing the FEFO allocation each line actually drew.
 *
 * The allocation is not decoration. A line filled from two batches, or from a
 * batch that is not the earliest-expiring one, is a fact the operator has to be
 * able to read off the screen before handing the medicine over — and it is what
 * makes an override visible instead of silent.
 */
export function CounterCartPanel({ cart, state, error, onRetry }: CounterCartPanelProps) {
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
    <div className="space-y-4">
      <ul className="divide-y divide-border-subtle" aria-label="Cart lines">
        {cart.lines.map((line) => (
          <li key={line.saleLineId} className="py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="min-w-0 text-sm font-semibold text-text-strong">
                {line.quantity} × {line.medicineName}
                {line.strength ? (
                  <span className="ml-1 font-normal text-text-body">{line.strength}</span>
                ) : null}
              </span>
              <span className="font-mono text-sm tabular-nums text-text-strong">
                {formatMinor(line.lineTotalMinor)}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-text-muted">
              {line.presentation} · {line.saleUnit.toLowerCase()} · {line.canonicalUnits} units @{' '}
              {formatMinor(line.unitPriceMinor)}
              {line.discountMinor > 0 ? ` · less ${formatMinor(line.discountMinor)}` : ''}
            </p>

            <ul className="mt-2 space-y-1" aria-label={`FEFO allocation for ${line.medicineName}`}>
              {line.allocations.map((allocation) => (
                <li
                  key={allocation.inventoryLotId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-surface-sunken px-3 py-1.5 font-mono text-xs tabular-nums text-text-body"
                >
                  <span>Batch {allocation.batchNumber}</span>
                  <span>Exp {formatReceiptDate(allocation.expiresAt)}</span>
                  <span>{allocation.canonicalUnits} units</span>
                  {allocation.stockLocationCode ? (
                    <span>{allocation.stockLocationCode}</span>
                  ) : null}
                  {allocation.overridden ? (
                    <StatusPill status="override" tone="warning" label="Batch override" />
                  ) : (
                    <StatusPill status="fefo" tone="neutral" label="FEFO" />
                  )}
                </li>
              ))}
            </ul>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {line.controlled ? (
                <StatusPill status="controlled" tone="danger" label="Controlled" />
              ) : null}
              {line.rx ? <StatusPill status="rx" tone="warning" label="Prescription only" /> : null}
              {line.restricted ? (
                <StatusPill status="restricted" tone="warning" label="Restricted" />
              ) : null}
              {line.highAlert ? (
                <StatusPill status="high-alert" tone="danger" label="High alert" />
              ) : null}
              {line.coldChain ? (
                <StatusPill status="cold-chain" tone="info" label="Cold chain" />
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <dl className="space-y-1 border-t border-border-subtle pt-3 text-sm">
        {(
          [
            ['Gross', cart.totals.grossMinor],
            ['Discount', cart.totals.discountMinor],
            ['Total', cart.totals.netMinor],
            ['Tendered', cart.totals.tenderedMinor],
            ['Balance', cart.totals.netMinor - cart.totals.tenderedMinor],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-text-muted">{label}</dt>
            <dd className="font-mono tabular-nums text-text-strong">{formatMinor(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
