'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { CONTROL } from './form-controls';

/** How long typing must pause before the product list is filtered. */
export const SCAN_SEARCH_DEBOUNCE_MS = 250;
/** Shortest typed term that lists products; a single letter matches almost everything. */
export const SCAN_SEARCH_MIN_LENGTH = 2;
const MAX_RESULTS = 8;

export type ScanSearchMedicine = { id: string; productName: string; brandName: string | null };

/** Same rule as the server's typed-name lookup: a case-insensitive substring of the name. */
export function matchScanSearch(
  medicines: readonly ScanSearchMedicine[],
  raw: string
): ScanSearchMedicine[] {
  const term = raw.trim().toLocaleLowerCase();
  if (term.length < SCAN_SEARCH_MIN_LENGTH) return [];
  return medicines
    .filter(
      (medicine) =>
        medicine.productName.toLocaleLowerCase().includes(term) ||
        (medicine.brandName?.toLocaleLowerCase().includes(term) ?? false)
    )
    .slice(0, MAX_RESULTS);
}

/**
 * DEV-734: the goods-in "Scan or search" box.
 *
 * A barcode scanner types its code and presses Enter, which still submits the
 * surrounding GET form untouched. A person typing a name gets a product list
 * once typing pauses, without pressing Enter; choosing a product (arrow keys
 * then Enter, or a click) submits that product's name. Nothing is chosen until
 * the operator moves onto it, so a fast scan never lands on a suggestion.
 */
export function ScanSearch({
  defaultValue,
  medicines,
}: {
  defaultValue: string;
  medicines: readonly ScanSearchMedicine[];
}) {
  const [term, setTerm] = useState(defaultValue);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = useId();
  const statusId = useId();

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const results = matchScanSearch(medicines, query);
  const searched = query.trim().length >= SCAN_SEARCH_MIN_LENGTH;
  const listOpen = open && results.length > 0;
  const activeOption = listOpen && active >= 0 ? results[active] : undefined;

  function cancelPending() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }

  function close() {
    cancelPending();
    setOpen(false);
    setActive(-1);
  }

  function choose(medicine: ScanSearchMedicine) {
    close();
    setTerm(medicine.productName);
    const field = input.current;
    if (!field) return;
    field.value = medicine.productName;
    field.form?.requestSubmit();
  }

  return (
    <div
      className="relative min-w-56 flex-1"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <label className="block text-sm font-medium text-text-body" htmlFor="scan">
        Scan or search
        <input
          ref={input}
          autoComplete="off"
          autoFocus
          className={cn(CONTROL, 'mt-1')}
          id="scan"
          name="scan"
          placeholder="Scan a 2D or linear code, or type a product name"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listOpen ? listId : undefined}
          aria-expanded={listOpen}
          aria-activedescendant={activeOption ? `${listId}-${active}` : undefined}
          aria-describedby={statusId}
          value={term}
          onChange={(event) => {
            const next = event.target.value;
            setTerm(next);
            setActive(-1);
            cancelPending();
            timer.current = setTimeout(() => {
              timer.current = null;
              setQuery(next);
              setOpen(true);
            }, SCAN_SEARCH_DEBOUNCE_MS);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey)
              return;
            if (event.key === 'Escape') {
              if (listOpen) event.preventDefault();
              close();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              if (!results.length) return;
              event.preventDefault();
              setOpen(true);
              setActive((index) =>
                event.key === 'ArrowDown'
                  ? (index + 1) % results.length
                  : index <= 0
                    ? results.length - 1
                    : index - 1
              );
            } else if (event.key === 'Enter') {
              if (activeOption) {
                event.preventDefault();
                choose(activeOption);
              } else {
                // A scan or a typed code: let the form submit what was typed.
                close();
              }
            }
          }}
        />
      </label>
      {listOpen ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Matching products"
          className="absolute z-10 mt-1 max-h-72 w-full overflow-x-hidden overflow-y-auto rounded-[var(--radius-sm)] border border-border-default bg-surface-raised p-1 shadow-sm"
        >
          {results.map((medicine, index) => (
            <button
              key={medicine.id}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={active === index}
              className={cn(
                'block min-h-11 w-full min-w-0 rounded-[var(--radius-xs)] px-3 py-2 text-left text-sm break-words text-text-strong hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-ring',
                active === index && 'bg-surface-sunken'
              )}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(medicine)}
            >
              {medicine.productName}
              {medicine.brandName && medicine.brandName !== medicine.productName ? (
                <span className="block text-xs text-text-muted">{medicine.brandName}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : open && searched ? (
        <p
          aria-hidden="true"
          className="absolute z-10 mt-1 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 py-2 text-sm text-text-muted shadow-sm"
        >
          No product name matches “{query.trim()}”. Press Enter to look it up as a code.
        </p>
      ) : null}
      <p id={statusId} className="sr-only" aria-live="polite">
        {open && searched
          ? results.length
            ? `${results.length} matching products. Use the arrow keys then Enter to choose one.`
            : `No product name matches “${query.trim()}”. Press Enter to look it up as a code.`
          : ''}
      </p>
    </div>
  );
}
