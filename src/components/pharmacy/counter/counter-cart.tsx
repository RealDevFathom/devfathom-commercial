'use client';

import { useState, type ReactNode } from 'react';
import { Minus, Plus, ScanBarcode, Trash2 } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import type { CounterCart, CounterCartLine } from '@/lib/pharmacy/counter';
import {
  counterUnitNoun,
  plural,
  type SaleUnitKind,
  type SaleUnitOption,
} from '@/lib/pharmacy/counter-pricing';
import type { CounterAlert } from '@/lib/pharmacy/counter-alerts';
import { formatMinor, formatShortExpiry } from '@/lib/pharmacy/counter-receipt';
import { batchPhrase } from '@/lib/pharmacy/unrecorded-batch';

export type CounterCartPanelProps = {
  cart: CounterCart | null;
  state: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | null;
  onRetry: () => void;
  alerts?: readonly CounterAlert[];
  /** The instant near-expiry is measured from; injectable for tests. */
  now?: Date;
  /** DEV-977: the keys that start a bill, shown under the empty bill. */
  emptyHints?: ReactNode;
  /**
   * DEV-977B (Counter v2, A1): quantity, sale unit and removal are changed on the bill line.
   * Without it the bill is read-only, as before.
   */
  lineControls?: CounterLineControls;
};

/** The quantity and unit a bill line is changed to. */
export type CounterLineChange = Pick<
  SaleUnitOption,
  'kind' | 'packLevelId' | 'canonicalUnitsPerSaleUnit'
> & {
  quantity: number;
};

export type CounterLineControls = {
  /** No line can change now (bill paid or closed, a counter action running, offline). */
  disabled: boolean;
  /** The sale units this line's medicine can be sold in, when the counter knows them. */
  unitOptions: (line: CounterCartLine) => readonly SaleUnitOption[];
  onChange: (line: CounterCartLine, next: CounterLineChange) => void;
  onRemove: (line: CounterCartLine) => void;
};

/**
 * DEV-977B: what the counter may change on a line. The server decides; this only keeps controls
 * off a line the server would refuse. A line with dispensing records (controlled, prescription,
 * emergency supply) or prepaid pricing stays as recorded. A line whose discount or batch was
 * approved for its quantity can be removed, not changed.
 */
export function counterLineEditing(
  line: CounterCartLine
): 'locked' | 'remove-only' | 'approved' | 'full' {
  if (
    line.controlled ||
    line.prescriptionLineId ||
    line.emergencySupply ||
    (line.tierDiscountMinor ?? 0) > 0
  )
    return 'locked';
  const ownDiscount = line.discountMinor - (line.billDiscountMinor ?? 0) > 0 && !line.promotionName;
  if (ownDiscount || line.allocations.some((allocation) => allocation.overridden))
    return 'approved';
  // An older bill read without the line's pack level can only be removed here.
  if (!line.packLevelId || !line.canonicalUnitsPerSaleUnit) return 'remove-only';
  return 'full';
}

/** DEV-977B: takes the line off the bill; beside its amount, as the design draws it. */
function CounterLineRemove({
  line,
  controls,
}: {
  line: CounterCartLine;
  controls: CounterLineControls;
}) {
  if (counterLineEditing(line) === 'locked') return null;
  return (
    <button
      type="button"
      aria-label={`Remove ${line.medicineName}`}
      disabled={controls.disabled}
      onClick={() => controls.onRemove(line)}
      className="mt-1 ms-auto grid size-11 place-items-center rounded-[var(--radius-sm)] text-text-muted transition-colors hover:bg-surface-sunken hover:text-destructive focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Trash2 aria-hidden="true" className="size-[18px]" />
    </button>
  );
}

const UNIT_WORD: Record<SaleUnitKind, string> = { PACK: 'Pack', STRIP: 'Strip', UNIT: 'Unit' };

function CounterLineEditor({
  line,
  controls,
}: {
  line: CounterCartLine;
  controls: CounterLineControls;
}) {
  const editing = counterLineEditing(line);
  const [draft, setDraft] = useState(String(line.quantity));
  if (editing === 'locked' || editing === 'remove-only') return null;
  const name = line.medicineName;
  const unitWord =
    line.saleUnit === 'UNIT' ? counterUnitNoun(line.dosageForm) : line.saleUnit.toLowerCase();
  const options = controls.unitOptions(line);
  const current = {
    kind: line.saleUnit,
    packLevelId: line.packLevelId ?? '',
    canonicalUnitsPerSaleUnit: line.canonicalUnitsPerSaleUnit ?? 0,
  };
  const setQuantity = (quantity: number) => {
    if (quantity === line.quantity) return;
    if (quantity < 1) controls.onRemove(line);
    else controls.onChange(line, { ...current, quantity });
  };
  const commitDraft = () => {
    const quantity = Number(draft);
    if (/^\d+$/.test(draft) && Number.isSafeInteger(quantity) && quantity > 0)
      setQuantity(quantity);
    else setDraft(String(line.quantity));
  };
  const button =
    'grid size-11 place-items-center text-text-strong transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {options.length > 0 && !options.some((option) => option.kind === 'UNIT') && (
        <span className="basis-full text-xs text-text-muted">
          {options.length === 1 && options[0]!.canonicalUnitsPerSaleUnit === 1
            ? 'One pack contains one unit.'
            : `Not sold loose. The smallest sellable size is one ${options.reduce((a, b) => (a.canonicalUnitsPerSaleUnit <= b.canonicalUnitsPerSaleUnit ? a : b)).kind.toLowerCase()}.`}
        </span>
      )}
      {editing === 'full' && options.length > 1 ? (
        <span
          role="radiogroup"
          aria-label={`Sold as: ${name}`}
          className="inline-flex overflow-hidden rounded-[var(--radius-sm)] border border-border-default bg-surface-card"
        >
          {options.map((option) => {
            const checked =
              option.kind === line.saleUnit &&
              option.canonicalUnitsPerSaleUnit === line.canonicalUnitsPerSaleUnit;
            return (
              <button
                key={`${option.kind}:${option.packLevelId}:${option.canonicalUnitsPerSaleUnit}`}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={controls.disabled}
                onClick={() => {
                  if (!checked)
                    controls.onChange(line, {
                      kind: option.kind,
                      packLevelId: option.packLevelId,
                      canonicalUnitsPerSaleUnit: option.canonicalUnitsPerSaleUnit,
                      quantity: line.quantity,
                    });
                }}
                className={`min-h-11 px-2.5 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:opacity-50 ${
                  checked
                    ? 'bg-text-strong text-surface-card'
                    : 'text-text-body hover:bg-surface-sunken'
                }`}
              >
                {UNIT_WORD[option.kind]}
              </button>
            );
          })}
        </span>
      ) : null}
      {editing === 'full' ? (
        <span className="inline-flex items-center overflow-hidden rounded-[var(--radius-sm)] border border-border-default bg-surface-card">
          <button
            type="button"
            aria-label={`− ${name}`}
            disabled={controls.disabled}
            onClick={() => setQuantity(line.quantity - 1)}
            className={button}
          >
            <Minus aria-hidden="true" className="size-[18px]" />
          </button>
          <input
            inputMode="numeric"
            aria-label={`Quantity: ${name}`}
            data-counter-line-quantity=""
            value={draft}
            disabled={controls.disabled}
            onChange={(event) => setDraft(event.target.value.replace(/\D/g, '').slice(0, 4))}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitDraft();
              }
              if (event.key === 'Escape') setDraft(String(line.quantity));
            }}
            className="h-11 w-14 border-x border-border-subtle bg-transparent text-center text-base font-semibold tabular-nums text-text-strong outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:opacity-50"
          />
          <button
            type="button"
            aria-label={`+ ${name}`}
            disabled={controls.disabled}
            onClick={() => setQuantity(line.quantity + 1)}
            className={button}
          >
            <Plus aria-hidden="true" className="size-[18px]" />
          </button>
        </span>
      ) : editing === 'approved' ? (
        <span className="text-xs text-text-muted">
          {line.quantity} × {unitWord}. Its discount or batch was approved for this quantity: remove
          it and add it again to change it.
        </span>
      ) : null}
    </div>
  );
}

/** PH-A4: a batch this close to expiry is flagged at the counter. */
export const NEAR_EXPIRY_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until `expiresAt` when under {@link NEAR_EXPIRY_DAYS}; otherwise null. */
export function nearExpiryDays(expiresAt: string | null, now: Date): number | null {
  // DEV-853: an expiry that was never recorded is never "near".
  if (expiresAt === null) return null;
  const days = Math.floor((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS);
  return days >= 0 && days < NEAR_EXPIRY_DAYS ? days : null;
}

function NearExpiryPill({ expiresAt, now }: { expiresAt: string | null; now: Date }) {
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
  emptyHints,
  lineControls,
}: CounterCartPanelProps) {
  if (state === 'idle' || (state === 'ready' && cart === null)) {
    // DEV-977 (Counter v2): the empty bill says how to start one, in the bill's own place.
    return (
      <div className="grid justify-items-center gap-3 px-4 py-14 text-center">
        <span
          aria-hidden="true"
          className="grid size-12 place-items-center rounded-[var(--radius-sm)] bg-surface-sunken text-text-strong"
        >
          <ScanBarcode className="size-6" />
        </span>
        <h3 className="text-xl font-semibold text-text-strong">Start a bill</h3>
        <p className="max-w-[42ch] text-sm text-text-body">
          No bill is open. Search for a medicine and add a line to start one.
        </p>
        {emptyHints ? (
          <p className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-text-muted">
            {emptyHints}
          </p>
        ) : null}
      </div>
    );
  }

  if (state === 'loading') {
    return (
      <div className="p-4">
        <p className="text-sm text-text-muted" role="status">
          Loading the bill…
        </p>
        <div aria-hidden="true" className="mt-4 space-y-6">
          {['w-3/5', 'w-1/2'].map((width) => (
            <div key={width} className="grid grid-cols-[minmax(0,1fr)_6rem] gap-x-6 gap-y-2.5">
              <Skeleton className={`h-3.5 ${width}`} />
              <Skeleton className="h-3.5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          ))}
        </div>
      </div>
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
      <div className="grid justify-items-center gap-3 px-4 py-14 text-center">
        <p className="max-w-[46ch] text-sm text-text-body">
          This bill is open with no lines yet. Scan or search a medicine, choose its sale unit, then
          add it to the cart.
        </p>
        {emptyHints ? (
          <p className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-text-muted">
            {emptyHints}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="@container min-w-0 overflow-x-auto">
      <table role="table" className="block w-full @min-[40rem]:table" aria-label="Cart lines">
        <thead className="sr-only bg-surface-sunken @min-[40rem]:not-sr-only @min-[40rem]:table-header-group">
          <tr role="row" className="font-mono text-xs tracking-wide text-text-muted uppercase">
            {['#', 'Medicine', 'Unit × qty', 'Batch · Expiry', 'Amount'].map((heading) => (
              <th
                key={heading}
                scope="col"
                role="columnheader"
                className="py-2.5 pr-4 text-left font-medium first:pl-0 last:pr-0 last:text-right"
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
              className="block border-t border-border-subtle @min-[40rem]:table-row-group"
            >
              <tr
                role="row"
                className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 py-3.5 align-top @min-[40rem]:table-row"
              >
                <td
                  role="cell"
                  className="row-span-3 pt-0.5 font-mono text-xs tabular-nums text-text-muted @min-[40rem]:py-3.5 @min-[40rem]:pr-3"
                >
                  {index + 1}
                </td>
                <th
                  scope="row"
                  role="rowheader"
                  className="min-w-0 text-left font-normal @min-[40rem]:w-2/5 @min-[40rem]:py-3.5 @min-[40rem]:pr-4"
                >
                  <p className="text-[15px] font-semibold text-text-strong">
                    {line.medicineName}
                    {line.strength ? (
                      <span className="ml-1 font-normal text-text-body">{line.strength}</span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-[13px] text-text-body">
                    {line.presentation} ·{' '}
                    {line.saleUnit === 'UNIT'
                      ? counterUnitNoun(line.dosageForm)
                      : line.saleUnit.toLowerCase()}{' '}
                    · {line.canonicalUnits}{' '}
                    {plural(counterUnitNoun(line.dosageForm), line.canonicalUnits)} @{' '}
                    {formatMinor(line.unitPriceMinor)}
                    {line.discountMinor > 0 ? ` · less ${formatMinor(line.discountMinor)}` : ''}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5 empty:hidden">
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
                  {lineControls ? (
                    // Keyed on the quantity, so a typed draft resets when the line changes.
                    <CounterLineEditor
                      key={`${line.saleLineId}:${line.quantity}`}
                      line={line}
                      controls={lineControls}
                    />
                  ) : null}
                </th>
                <td
                  role="cell"
                  className="col-span-2 col-start-2 row-start-2 @min-[40rem]:py-3.5 @min-[40rem]:pr-4"
                >
                  <p className="text-[15px] font-semibold tabular-nums text-text-strong">
                    {line.quantity} ×{' '}
                    {line.saleUnit === 'UNIT'
                      ? counterUnitNoun(line.dosageForm)
                      : line.saleUnit.toLowerCase()}
                  </p>
                  <p className="text-xs text-text-muted">
                    {line.canonicalUnits}{' '}
                    {plural(counterUnitNoun(line.dosageForm), line.canonicalUnits)}
                  </p>
                </td>
                <td
                  role="cell"
                  className="col-span-2 col-start-2 row-start-3 @min-[40rem]:py-3.5 @min-[40rem]:pr-4"
                >
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
                            {batchPhrase(allocation.batchNumber)}
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
                  className="col-start-3 row-start-1 text-right text-base font-semibold tabular-nums text-text-strong @min-[40rem]:py-3.5"
                >
                  {formatMinor(line.lineTotalMinor)}
                  {lineControls ? <CounterLineRemove line={line} controls={lineControls} /> : null}
                </td>
              </tr>
              {lineAlerts.length > 0 ? (
                <tr role="row" className="block @min-[40rem]:table-row">
                  <td role="cell" className="hidden @min-[40rem]:table-cell" />
                  <td
                    role="cell"
                    colSpan={4}
                    className="block pb-3.5 pl-10 @min-[40rem]:table-cell @min-[40rem]:pl-0"
                  >
                    <div className="space-y-2">
                      {lineAlerts.map((alert) => (
                        <div
                          key={alert.key}
                          role={alert.severity === 'SAFETY_BLOCK' ? 'alert' : undefined}
                          className={
                            alert.severity === 'SAFETY_BLOCK'
                              ? 'rounded-[var(--radius-sm)] bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive'
                              : 'rounded-[var(--radius-sm)] bg-surface-sunken px-3 py-2.5 text-[13px] text-text-body'
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
  /** DEV-853: null when the batch number was never recorded. */
  batchNumber: string | null;
  /** DEV-853: null when the expiry was never recorded. */
  expiresAt: string | null;
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
          {batchPhrase(chosenLot.batchNumber)} will be sold on this line (not the earliest-expiry
          batch).
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
                <span>{batchPhrase(lot.batchNumber)}</span>
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
