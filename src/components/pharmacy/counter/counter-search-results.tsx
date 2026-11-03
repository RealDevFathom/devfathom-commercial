'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
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
  const ct = useTranslations('CounterText');
  if (state === 'idle') {
    return (
      <p className="text-sm text-text-muted">{ct('scanABarcodeOrTypeAtLeastTwoCharacters')}</p>
    );
  }

  if (state === 'loading') {
    return (
      <p className="text-sm text-text-muted" role="status">
        {ct('searchingTheCatalog')}
      </p>
    );
  }

  if (state === 'error') {
    return (
      <div className="space-y-3" role="alert">
        <p className="text-sm text-destructive">{error ?? ct('searchFailed')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={disabled}
            onClick={onRetry}
          >
            {ct('retrySearch')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={disabled}
            onClick={onCaptureDemand}
            className="h-auto min-h-11 whitespace-normal"
          >
            {ct('captureAsUnfulfilledDemand')}
          </Button>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-text-muted">
          {ct('nothingInThisCatalogMatches')}
          {query}”.
        </p>
        <Button
          type="button"
          size="touch"
          disabled={disabled}
          onClick={onCaptureDemand}
          className="h-auto min-h-11 whitespace-normal"
        >
          {ct('captureAsUnfulfilledDemand')}
        </Button>
      </div>
    );
  }

  return (
    <ul
      className="min-w-0 divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface-card"
      aria-label={ct('searchResults')}
    >
      {rows.map((row) => {
        const sellable = row.onHandUnits > 0 && row.saleableUnits.length > 0;
        const active = row.medicineId === activeMedicineId;
        const location = row.storage.locationKind
          ? ct('value0Value1', {
              value0: LOCATION_LABEL[row.storage.locationKind]
                ? ct(`locations.${row.storage.locationKind}`)
                : row.storage.locationKind,
              value1: row.storage.locationCode ? ` ${row.storage.locationCode}` : '',
            })
          : (row.storage.locationName ?? row.storage.locationCode);
        const safety = [
          !sellable
            ? { status: 'not-sellable', tone: 'warning' as const, label: ct('notSellable') }
            : null,
          row.restriction.controlled
            ? { status: 'controlled', tone: 'danger' as const, label: ct('controlled') }
            : null,
          row.restriction.rx
            ? { status: 'prescription', tone: 'warning' as const, label: ct('prescriptionOnly') }
            : null,
          row.restriction.restricted
            ? { status: 'restricted', tone: 'warning' as const, label: ct('restricted') }
            : null,
          row.restriction.highAlert
            ? { status: 'high-alert', tone: 'danger' as const, label: ct('highAlert') }
            : null,
          row.restriction.lasa
            ? { status: 'look-alike', tone: 'warning' as const, label: ct('lookAlike') }
            : null,
          row.storage.coldChain
            ? { status: 'cold-chain', tone: 'info' as const, label: ct('coldChain') }
            : null,
        ].filter((flag) => flag !== null);
        const notes = [
          row.restriction.otc &&
          !row.restriction.rx &&
          !row.restriction.restricted &&
          !row.restriction.controlled
            ? ct('overTheCounter')
            : null,
          location ?? ct('locationUnavailable'),
        ].filter(Boolean);
        return (
          <li key={row.medicineId}>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => onSelect(row)}
              className={`grid min-h-11 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 text-start focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${
                active ? 'bg-surface-sunken' : 'hover:bg-surface-sunken'
              }`}
            >
              <span
                dir="auto"
                className="min-w-0 break-words text-sm font-semibold text-text-strong"
              >
                {row.displayName}
                {row.urduName ? (
                  <bdi lang="ur" dir="rtl" className="ms-2 inline-block font-normal">
                    {row.urduName}
                  </bdi>
                ) : null}
                {row.strength ? (
                  <span className="ms-1 font-normal text-text-body">
                    <bdi dir="auto">{row.strength}</bdi>
                  </span>
                ) : null}
              </span>
              <span className="w-full text-end font-mono text-sm tabular-nums text-text-strong">
                <span className="sr-only">{ct('packMRP')}</span>
                {row.printedMrpMinor === null ? '—' : formatMinor(row.printedMrpMinor)}
              </span>
              <span className="col-span-2 min-w-0 break-words text-xs leading-relaxed text-text-muted">
                {row.presentation}
                {row.dosageForm ? ct('value02', { value0: row.dosageForm }) : ''}
                {ct('batchValue0', { value0: row.batchNumber ?? '—' })}
                {ct('expValue0', {
                  value0: row.nearestSafeExpiry ? formatReceiptDate(row.nearestSafeExpiry) : '—',
                })}
                {ct('value0Units', { value0: row.onHandUnits })}
                {notes.length ? ` · ${notes.join(' · ')}` : ''}
                {ct('value02', { value0: ct(`matches.${row.matchedOn}`) })}
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
                  {ct('blockedStockPresent')}
                  {row.blocked.join(', ').toLowerCase()}.
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
