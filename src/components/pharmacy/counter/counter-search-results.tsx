'use client';

import { StatusPill } from '@/components/ui/status-pill';
import type { CounterSearchRow } from '@/lib/pharmacy/counter';
import { formatMinor, formatReceiptDate } from '@/lib/pharmacy/counter-receipt';

export type CounterSearchResultsProps = {
  rows: readonly CounterSearchRow[];
  state: 'idle' | 'loading' | 'ready' | 'error';
  query: string;
  activeMedicineId: string | null;
  error?: string | null;
  disabled?: boolean;
  onSelect: (row: CounterSearchRow) => void;
  onCaptureDemand: () => void;
  onRetry: () => void;
};

const LOCATION_LABEL: Record<string, string> = {
  STORE: 'Store',
  RACK_BIN: 'Rack',
  FRIDGE: 'Fridge',
  SAFE: 'Safe',
  QUARANTINE: 'Quarantine',
  TRANSIT: 'Transit',
  RETURNS: 'Returns',
};

const MATCH_LABEL: Record<CounterSearchRow['matchedOn'], string> = {
  BARCODE: 'Barcode',
  ALIAS: 'Alias',
  NAME: 'Name',
  INGREDIENT: 'Ingredient',
  PRESENTATION: 'Form',
};

/**
 * POS-02 result rows.
 *
 * Every field the requirement names is on the row itself — presentation,
 * saleable units, nearest safe expiry, stock, MRP, price, restriction and
 * storage marker — because a counter that has to open a detail view to learn
 * whether a medicine is prescription-only is a counter that stops checking.
 *
 * Rendered as a list of buttons rather than a table: each row is one keyboard
 * stop that stages the medicine, which is what makes the whole search
 * mouse-free (POS-01).
 */
export function CounterSearchResults({
  rows,
  state,
  query,
  activeMedicineId,
  error,
  disabled = false,
  onSelect,
  onCaptureDemand,
  onRetry,
}: CounterSearchResultsProps) {
  if (state === 'idle') {
    return (
      <p className="text-sm text-text-muted">
        Scan a barcode, or type at least two characters of a brand, generic, ingredient, strength,
        form, alias or legacy code.
      </p>
    );
  }

  if (state === 'loading') {
    return (
      <p className="text-sm text-text-muted" role="status">
        Searching the catalog…
      </p>
    );
  }

  if (state === 'error') {
    return (
      <div className="space-y-3" role="alert">
        <p className="text-sm text-destructive">{error ?? 'Search failed.'}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={onRetry}
            className="inline-flex h-11 items-center rounded-md border border-border-subtle bg-surface-card px-4 text-sm font-semibold text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Retry search
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onCaptureDemand}
            className="inline-flex h-11 items-center rounded-md border border-border-subtle bg-surface-card px-4 text-sm font-semibold text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Capture as unfulfilled demand
          </button>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-text-muted">Nothing in this catalog matches “{query}”.</p>
        <button
          type="button"
          disabled={disabled}
          onClick={onCaptureDemand}
          className="inline-flex h-11 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Capture as unfulfilled demand
        </button>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border-subtle" aria-label="Search results">
      {rows.map((row) => {
        const sellable = row.onHandUnits > 0 && row.saleableUnits.length > 0;
        const active = row.medicineId === activeMedicineId;
        return (
          <li key={row.medicineId}>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => onSelect(row)}
              className={`w-full min-w-0 rounded-md px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                active ? 'bg-surface-sunken' : 'hover:bg-surface-sunken'
              }`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 text-sm font-semibold text-text-strong">
                  {row.displayName}
                  {row.strength ? (
                    <span className="ml-1 font-normal text-text-body">{row.strength}</span>
                  ) : null}
                </span>
                <span className="font-mono text-xs tabular-nums text-text-muted">
                  {MATCH_LABEL[row.matchedOn]}
                </span>
              </div>

              <p className="mt-0.5 text-xs text-text-muted">
                {row.presentation}
                {row.dosageForm ? ` · ${row.dosageForm}` : ''}
                {row.brandName ? ` · ${row.brandName}` : ''}
                {row.manufacturer ? ` · ${row.manufacturer}` : ''}
              </p>

              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                <div>
                  <dt className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
                    Safe available
                  </dt>
                  <dd className="font-mono tabular-nums text-text-strong">
                    {row.onHandUnits} units
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
                    Nearest safe expiry
                  </dt>
                  <dd className="font-mono tabular-nums text-text-strong">
                    {row.nearestSafeExpiry ? formatReceiptDate(row.nearestSafeExpiry) : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
                    Printed MRP
                  </dt>
                  <dd className="font-mono tabular-nums text-text-strong">
                    {row.printedMrpMinor === null ? '—' : formatMinor(row.printedMrpMinor)}
                  </dd>
                </div>
                <div>
                  <dt className="font-mono text-[0.625rem] tracking-wide text-text-muted uppercase">
                    Batch
                  </dt>
                  <dd className="font-mono tabular-nums text-text-strong">
                    {row.batchNumber ?? '—'}
                  </dd>
                </div>
              </dl>

              {row.saleableUnits.length > 0 ? (
                <p className="mt-2 font-mono text-xs tabular-nums text-text-body">
                  {row.saleableUnits
                    .map(
                      (unit) =>
                        `${unit.wholeUnits} × ${unit.levelLabel.toLowerCase()} @ ${formatMinor(unit.unitPriceMinor)}`
                    )
                    .join('  ·  ')}
                </p>
              ) : null}

              <p className="mt-2 break-words text-xs text-text-body">
                FEFO location:{' '}
                {row.storage.locationName || row.storage.locationCode
                  ? [row.storage.locationName, row.storage.locationCode].filter(Boolean).join(' · ')
                  : 'Not recorded'}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {row.restriction.controlled ? (
                  <StatusPill status="controlled" tone="danger" label="Controlled" />
                ) : null}
                {row.restriction.rx ? (
                  <StatusPill status="rx" tone="warning" label="Prescription only" />
                ) : null}
                {row.restriction.restricted ? (
                  <StatusPill status="restricted" tone="warning" label="Restricted" />
                ) : null}
                {row.restriction.highAlert ? (
                  <StatusPill status="high-alert" tone="danger" label="High alert" />
                ) : null}
                {row.restriction.lasa ? (
                  <StatusPill status="lasa" tone="warning" label="Look-alike" />
                ) : null}
                {row.restriction.otc &&
                !row.restriction.rx &&
                !row.restriction.restricted &&
                !row.restriction.controlled ? (
                  <StatusPill status="otc" tone="neutral" label="Over the counter" />
                ) : null}
                {row.storage.coldChain ? (
                  <StatusPill status="cold-chain" tone="info" label="Cold chain" />
                ) : null}
                {row.storage.locationKind ? (
                  <StatusPill
                    status="location"
                    tone="neutral"
                    label={`${LOCATION_LABEL[row.storage.locationKind] ?? row.storage.locationKind}${
                      row.storage.locationCode ? ` ${row.storage.locationCode}` : ''
                    }`}
                  />
                ) : null}
                {!sellable ? (
                  <StatusPill status="unavailable" tone="danger" label="Not sellable" />
                ) : null}
              </div>

              {row.blocked.length > 0 ? (
                <p className="mt-2 text-xs text-warning">
                  Blocked stock present: {row.blocked.join(', ').toLowerCase()}.
                </p>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
