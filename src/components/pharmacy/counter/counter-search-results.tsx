'use client';

import { useId } from 'react';
import { SlidersHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPill } from '@/components/ui/status-pill';
import type { CounterSearchRow } from '@/lib/pharmacy/counter';
import {
  counterMedicineDisplayName,
  counterMedicineGenericName,
} from '@/lib/pharmacy/counter-display-name';
import { formatMinor, formatShortExpiry } from '@/lib/pharmacy/counter-receipt';
import { BATCH_NOT_RECORDED } from '@/lib/pharmacy/unrecorded-batch';
import { formatStockBreakdown } from '@/lib/pharmacy/stock-breakdown';

export type CounterSearchResultsProps = {
  rows: readonly CounterSearchRow[];
  state: 'idle' | 'loading' | 'ready' | 'error';
  query: string;
  activeMedicineId: string | null;
  error?: string | null;
  disabled?: boolean;
  disabledReason?: string | null;
  /** A visible explanation owned by the parent; standalone uses its own text. */
  disabledReasonId?: string;
  onSelect: (row: CounterSearchRow) => void;
  /**
   * DEV-977B (Counter v2, A6): a press on a result adds one of it to the bill in one step, in
   * the unit chosen under "Adds as". Without it a press stages the row (the line form).
   */
  onAdd?: (row: CounterSearchRow) => void;
  /** DEV-977B: the search has been waiting long enough to say so. */
  slow?: boolean;
  emptySearchHint?: string;
  onCaptureDemand: () => void;
  onRetry: () => void;
  listLabel?: string;
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
 * DEV-907: "Gulberg", "Gulberg and DHA", "Gulberg, DHA and other branches".
 * The server sends branch names only; nothing else about the other branch.
 */
export function otherBranchAvailabilityText(
  availability: NonNullable<CounterSearchRow['otherBranchAvailability']>
): string {
  const names = availability.more
    ? [...availability.branchNames, 'other branches']
    : availability.branchNames;
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

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
 *
 * DEV-972: the row is dense (the details run on as one wrapping line) so at least five results
 * show at 1366 x 768; every field above is still on the row.
 */
export function CounterSearchResults({
  rows,
  state,
  query,
  activeMedicineId,
  error,
  disabled = false,
  disabledReason,
  disabledReasonId,
  onSelect,
  onAdd,
  slow = false,
  emptySearchHint,
  onCaptureDemand,
  onRetry,
  listLabel = 'Search results',
}: CounterSearchResultsProps) {
  const localReasonId = useId();
  const reasonId = disabledReasonId ?? localReasonId;
  const reason = disabled
    ? (disabledReason ?? 'Wait for the current counter action to finish.')
    : null;
  const reasonText =
    reason && !disabledReasonId ? (
      <p id={reasonId} className="text-sm text-text-muted">
        {reason}
      </p>
    ) : null;
  if (state === 'idle') {
    return (
      <p className="text-sm text-text-muted">
        Scan a barcode, or type at least two characters of a brand, generic, ingredient, strength,
        form, alias or legacy code.
      </p>
    );
  }

  if (state === 'loading') {
    // DEV-977B (Counter v2): a slow search says so and keeps the place of the results.
    return slow ? (
      <div aria-busy="true" className="space-y-3">
        <p className="text-sm text-text-muted" role="status">
          Still searching… Scanning the barcode is faster.
        </p>
        <div aria-hidden="true" className="space-y-4">
          {['w-3/5', 'w-1/2', 'w-2/3'].map((width) => (
            <div key={width} className="grid grid-cols-[minmax(0,1fr)_5rem] gap-x-6 gap-y-2">
              <Skeleton className={`h-3.5 ${width}`} />
              <Skeleton className="h-3.5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          ))}
        </div>
      </div>
    ) : (
      <p className="text-sm text-text-muted" role="status">
        Searching the catalog…
      </p>
    );
  }

  if (state === 'error') {
    return (
      <div className="space-y-3" role="alert">
        {reasonText}
        <p className="text-sm text-destructive">{error ?? 'Search failed.'}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={disabled}
            aria-describedby={reason ? reasonId : undefined}
            onClick={onRetry}
          >
            Retry search
          </Button>
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={disabled}
            aria-describedby={reason ? reasonId : undefined}
            onClick={onCaptureDemand}
            className="h-auto min-h-11 whitespace-normal"
          >
            Capture as unfulfilled demand
          </Button>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="space-y-3">
        {reasonText}
        <p className="text-sm text-text-muted">Nothing in this catalog matches “{query}”.</p>
        {emptySearchHint ? (
          <p className="text-sm text-text-muted">{emptySearchHint}</p>
        ) : (
          <Button
            type="button"
            size="touch"
            disabled={disabled}
            aria-describedby={reason ? reasonId : undefined}
            onClick={onCaptureDemand}
            className="h-auto min-h-11 whitespace-normal"
          >
            Capture as unfulfilled demand
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      {reasonText}
      <ul
        className="min-w-0 divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface-card"
        aria-label={listLabel}
      >
        {rows.map((row) => {
          const sellable = row.onHandUnits > 0 && row.saleableUnits.length > 0;
          const active = row.medicineId === activeMedicineId;
          const location = row.storage.locationKind
            ? `${LOCATION_LABEL[row.storage.locationKind] ?? row.storage.locationKind}${
                row.storage.locationCode ? ` ${row.storage.locationCode}` : ''
              }`
            : (row.storage.locationName ?? row.storage.locationCode);
          const safety = [
            !sellable
              ? row.onHandUnits === 0 && row.blocked.length === 0
                ? { status: 'out-of-stock', tone: 'warning' as const, label: 'Out of stock' }
                : { status: 'not-sellable', tone: 'warning' as const, label: 'Not sellable' }
              : null,
            row.restriction.controlled
              ? { status: 'controlled', tone: 'danger' as const, label: 'Controlled' }
              : null,
            row.restriction.rx
              ? { status: 'prescription', tone: 'warning' as const, label: 'Prescription only' }
              : null,
            row.restriction.restricted
              ? { status: 'restricted', tone: 'warning' as const, label: 'Restricted' }
              : null,
            row.restriction.highAlert
              ? { status: 'high-alert', tone: 'danger' as const, label: 'High alert' }
              : null,
            row.restriction.lasa
              ? { status: 'look-alike', tone: 'warning' as const, label: 'Look-alike' }
              : null,
            row.storage.coldChain
              ? { status: 'cold-chain', tone: 'info' as const, label: 'Cold chain' }
              : null,
          ].filter((flag) => flag !== null);
          const notes = [
            row.restriction.otc &&
            !row.restriction.rx &&
            !row.restriction.restricted &&
            !row.restriction.controlled
              ? 'Over the counter'
              : null,
            location ?? 'Location unavailable',
          ].filter(Boolean);
          return (
            <li key={`${row.medicineId}:${row.presentationId}`}>
              <div className="flex min-w-0">
                <button
                  type="button"
                  disabled={disabled}
                  aria-describedby={reason ? reasonId : undefined}
                  aria-pressed={active}
                  onClick={() => (onAdd ?? onSelect)(row)}
                  // DEV-977B (Counter v2): a result row is at least 64px, as drawn.
                  className={`grid min-h-16 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-s-[3px] px-4 py-3 text-start focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${
                    // DEV-977 (Counter v2): the chosen result also carries a mark, not only a tint.
                    active
                      ? 'border-s-accent-brand bg-surface-sunken'
                      : 'border-s-transparent hover:bg-surface-sunken'
                  }`}
                >
                  <span
                    dir="auto"
                    className="min-w-0 break-words text-sm font-semibold text-text-strong"
                  >
                    {counterMedicineDisplayName(row)}
                    {row.composition ? (
                      <span dir="auto" className="block text-xs font-normal text-text-body">
                        {row.composition}
                      </span>
                    ) : null}
                    {counterMedicineGenericName(row) ? (
                      <span dir="auto" className="block text-xs font-normal text-text-muted">
                        {counterMedicineGenericName(row)}
                      </span>
                    ) : null}
                  </span>
                  <span className="w-full text-end font-mono text-sm tabular-nums text-text-strong">
                    <span className="sr-only">Pack MRP </span>
                    {row.printedMrpMinor === null ? '—' : formatMinor(row.printedMrpMinor)}
                  </span>
                  <span className="col-span-2 flex min-w-0 flex-wrap gap-x-3 break-words text-xs text-text-muted">
                    {/* DEV-977 phase 3 (owner, 21 Nov 2026): imported medicines carry their strength
                        in the name, so a missing one shows nothing here, not a placeholder. */}
                    {row.strength ? (
                      <span className="block">
                        <span>Strength:</span>{' '}
                        <span className="ms-1">
                          <bdi dir="auto">{row.strength}</bdi>
                        </span>
                      </span>
                    ) : null}
                    <span className="block">
                      <span>Form:</span> {row.presentation}
                      {row.dosageForm ? ` · ${row.dosageForm}` : ''}
                    </span>
                    {row.unitsPerPack ? (
                      <span className="block">
                        <span>Pack:</span> {row.unitsPerPack} units
                      </span>
                    ) : null}
                    <span className="block">
                      <span>Stock:</span>{' '}
                      {formatStockBreakdown(row.onHandUnits, row.saleableUnits, row.dosageForm)}
                    </span>
                    {row.batchNumber
                      ? ` · Batch ${row.batchNumber}`
                      : row.recommendedLotId
                        ? ` · ${BATCH_NOT_RECORDED}`
                        : ''}
                    {/* DEV-853: a sellable lot with no expiry says "Expiry not recorded". */}
                    {row.nearestSafeExpiry || row.recommendedLotId
                      ? ` · ${formatShortExpiry(row.nearestSafeExpiry)}`
                      : ''}
                    {notes.length ? ` · ${notes.join(' · ')}` : ''}
                    {` · ${MATCH_LABEL[row.matchedOn]}`}
                  </span>
                  {safety.length > 0 ? (
                    <span className="col-span-2 flex flex-wrap gap-1">
                      {safety.map((flag) => (
                        <StatusPill
                          key={flag.status}
                          status={flag.status}
                          tone={flag.tone}
                          label={flag.label}
                          className="shrink-0"
                        />
                      ))}
                    </span>
                  ) : null}
                  {row.blocked.length > 0 ? (
                    <span className="col-span-2 text-xs text-warning">
                      Blocked stock present: {row.blocked.join(', ').toLowerCase()}.
                    </span>
                  ) : null}
                </button>
                {onAdd ? (
                  // DEV-977B: the line form (quantity before adding, another batch) by pointer too;
                  // Shift+Enter from the search field does the same for the highlighted result.
                  <button
                    type="button"
                    disabled={disabled}
                    aria-describedby={reason ? reasonId : undefined}
                    aria-label={`Quantity or batch first: ${counterMedicineDisplayName(row)}`}
                    onClick={() => onSelect(row)}
                    className="grid w-12 shrink-0 place-items-center border-s border-border-subtle text-text-muted hover:bg-surface-sunken hover:text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <SlidersHorizontal aria-hidden="true" className="size-[18px]" />
                  </button>
                ) : null}
              </div>
              {row.otherBranchAvailability?.branchNames.length ? (
                <p className="border-t border-border-subtle px-4 py-2 text-sm text-text-body">
                  Also in stock at{' '}
                  <bdi dir="auto" className="font-semibold text-text-strong">
                    {otherBranchAvailabilityText(row.otherBranchAvailability)}
                  </bdi>
                  .{' '}
                  <span className="text-text-muted">
                    The customer buys and collects it at that branch.
                  </span>
                </p>
              ) : null}
              {row.stockAlternatives ? (
                <section
                  aria-label={`Alternatives for ${counterMedicineDisplayName(row)}`}
                  className="space-y-3 border-t border-border-subtle bg-surface-sunken p-3 sm:p-4"
                >
                  {!row.stockAlternatives.ingredientRecorded ? (
                    <p className="text-sm text-text-muted">
                      No ingredient recorded for this product
                    </p>
                  ) : (
                    <>
                      <h3 className="text-sm font-semibold text-text-strong">
                        In-stock alternatives
                      </h3>
                      <StatusPill status="suggestion" tone="info" label="Suggestion only" />
                      <p className="text-xs text-text-muted">
                        Nothing is swapped automatically. For prescription-only or controlled
                        medicines, the pharmacist decides on substitution.
                      </p>
                      {row.stockAlternatives.exact.length ? (
                        <CounterSearchResults
                          rows={row.stockAlternatives.exact}
                          state="ready"
                          query={query}
                          activeMedicineId={activeMedicineId}
                          disabled={disabled}
                          disabledReason={disabledReason}
                          disabledReasonId={reason ? reasonId : undefined}
                          onSelect={onSelect}
                          onCaptureDemand={onCaptureDemand}
                          onRetry={onRetry}
                          listLabel="Same ingredient, strength and form"
                        />
                      ) : (
                        <p className="text-sm text-text-muted">
                          No in-stock brand with the same ingredient, strength and form at this
                          branch.
                        </p>
                      )}
                      {row.stockAlternatives.truncated ? (
                        <p className="text-xs text-text-muted">
                          More brands with this ingredient may be in stock. Search by the ingredient
                          name to see them all.
                        </p>
                      ) : null}
                      {row.stockAlternatives.other.length ? (
                        <>
                          <h3 className="text-sm font-semibold text-text-strong">
                            Other strengths or forms
                          </h3>
                          <p className="text-xs text-text-muted">
                            These are not exact equivalents. Ask the pharmacist to review strength,
                            form and route before selecting.
                          </p>
                          <CounterSearchResults
                            rows={row.stockAlternatives.other}
                            state="ready"
                            query={query}
                            activeMedicineId={activeMedicineId}
                            disabled={disabled}
                            disabledReason={disabledReason}
                            disabledReasonId={reason ? reasonId : undefined}
                            onSelect={onSelect}
                            onCaptureDemand={onCaptureDemand}
                            onRetry={onRetry}
                            listLabel="Other strengths or forms"
                          />
                        </>
                      ) : null}
                    </>
                  )}
                </section>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
