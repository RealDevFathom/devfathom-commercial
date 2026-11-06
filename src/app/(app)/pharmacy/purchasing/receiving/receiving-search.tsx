'use client';

import { useEffect, useRef, useState } from 'react';
import { SubmitButton } from '../_components/form-controls';

type Medicine = { id: string; productName: string };

export function ReceivingSearch({
  branchId,
  orderId,
  receiptId,
  initialTerm,
  medicines,
}: {
  branchId: string;
  orderId?: string;
  receiptId?: string;
  initialTerm: string;
  medicines: Medicine[];
}) {
  const [term, setTerm] = useState(initialTerm);
  const [search, setSearch] = useState('');
  const [composing, setComposing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const selection = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (composing) return;
    const timer = setTimeout(() => setSearch(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term, composing]);

  const matches = search
    ? medicines.filter((medicine) =>
        medicine.productName.toLocaleLowerCase().includes(search.toLocaleLowerCase())
      )
    : [];

  return (
    <div>
      <form
        ref={form}
        action="/pharmacy/purchasing/receiving"
        className="flex flex-wrap items-end gap-3"
        method="get"
      >
        <input name="branch" type="hidden" value={branchId} />
        <input ref={selection} name="scanMedicine" type="hidden" defaultValue="" />
        {orderId ? <input name="order" type="hidden" value={orderId} /> : null}
        {receiptId ? <input name="receipt" type="hidden" value={receiptId} /> : null}
        <label className="min-w-56 flex-1 text-sm font-medium text-text-body" htmlFor="scan">
          Scan or search
          <input
            ref={input}
            autoComplete="off"
            autoFocus
            className="mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
            id="scan"
            name="scan"
            onChange={(event) => {
              if (selection.current) selection.current.value = '';
              setTerm(event.target.value);
              setSearch('');
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            placeholder="Scan a 2D or linear code, or type a product name"
            value={term}
          />
        </label>
        <SubmitButton variant="secondary">Find line</SubmitButton>
      </form>
      {search && matches.length > 0 ? (
        <ul
          aria-label="Matching products"
          className="mt-2 max-h-60 overflow-y-auto rounded-[var(--radius-sm)] border border-border-default bg-surface-raised"
        >
          {matches.map((medicine) => (
            <li key={medicine.id}>
              <button
                className="min-h-11 w-full px-3 text-left text-sm text-text-strong hover:bg-muted focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
                onClick={() => {
                  if (!input.current || !form.current || !selection.current) return;
                  input.current.value = medicine.productName;
                  selection.current.value = medicine.id;
                  form.current.requestSubmit();
                }}
                type="button"
              >
                {medicine.productName}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p aria-live="polite" className="mt-2 text-xs text-text-muted">
        {search
          ? `${matches.length} matching ${matches.length === 1 ? 'product' : 'products'}. Press Enter to find a code or name.`
          : ''}
      </p>
    </div>
  );
}
