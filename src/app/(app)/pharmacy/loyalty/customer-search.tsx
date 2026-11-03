'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

type Results = {
  customers: {
    id: string;
    displayName: string;
    phoneLast4: string | null;
    pointsBalance: number;
  }[];
  hasMore: boolean;
};

export function CustomerSearch({
  branchId,
  customerId,
  query,
  initial,
  recent,
  searchAction,
}: {
  branchId: string;
  customerId: string;
  query: string;
  initial: Results;
  recent: Results;
  searchAction: (branchId: string, query: string) => Promise<Results>;
}) {
  const router = useRouter();
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const version = useRef(0);
  const [text, setText] = useState(query);
  const [result, setResult] = useState({ query: query.trim(), data: initial, failed: false });
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState(0);
  const [pending, startTransition] = useTransition();
  const trimmed = text.trim();
  const searching = trimmed.length >= 2;
  const original = trimmed === query.trim() && retry === 0;
  const loading = searching && !original && result.query !== trimmed;
  const failed = searching && !original && !loading && result.failed;
  const data = searching ? (original ? initial : result.data) : recent;
  const customers = loading || failed ? [] : data.customers;

  useEffect(() => {
    if (trimmed.length < 2 || (trimmed === query.trim() && retry === 0)) return;
    const requestVersion = ++version.current;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchAction(branchId, trimmed).then(
        (data) => {
          if (!cancelled && requestVersion === version.current)
            setResult({ query: trimmed, data, failed: false });
        },
        () => {
          if (!cancelled && requestVersion === version.current)
            setResult({ query: trimmed, data: { customers: [], hasMore: false }, failed: true });
        }
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [branchId, text, trimmed, query, searchAction, retry]);

  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  function select(id: string) {
    version.current++;
    setOpen(false);
    startTransition(() => {
      if (id === customerId) router.refresh();
      else
        router.push(
          `/pharmacy/loyalty?${new URLSearchParams({ branchId, customerId: id, page: '1' })}`,
          { scroll: false }
        );
    });
  }

  return (
    <div
      className="mt-4 min-w-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor={id} className="mb-2 block text-sm">
        Name, phone or account ID
      </label>
      <Input
        id={id}
        ref={input}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-results`}
        aria-describedby={`${id}-help`}
        aria-activedescendant={open && customers[active] ? `${id}-option-${active}` : undefined}
        autoComplete="off"
        maxLength={100}
        value={text}
        disabled={pending}
        className="min-h-11"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          version.current++;
          setText(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            setActive((index) =>
              customers.length
                ? (index + (event.key === 'ArrowDown' ? 1 : -1) + customers.length) %
                  customers.length
                : 0
            );
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            if (open && customers[active]) select(customers[active].id);
          }
        }}
      />
      <p id={`${id}-help`} className="mt-2 text-sm text-text-muted">
        Type at least 2 characters. Choose a customer to see their points and history below.
      </p>
      {pending && (
        <p role="status" className="mt-3 text-sm">
          Loading customer history…
        </p>
      )}
      {open && (
        <>
          <p className="mt-4 text-sm font-semibold">
            {searching ? 'Matching customers' : 'Recent loyalty customers'}
          </p>
          {loading && (
            <p role="status" className="mt-3 text-sm">
              Searching customers…
            </p>
          )}
          {failed && (
            <div role="alert" className="mt-3 space-y-2 text-sm">
              <p>Customer search is unavailable. Check your access or try again.</p>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  input.current?.focus();
                  setResult({ ...result, query: '' });
                  setRetry((value) => value + 1);
                }}
              >
                Retry search
              </Button>
            </div>
          )}
        </>
      )}
      <ul
        ref={list}
        id={`${id}-results`}
        role="listbox"
        aria-label="Customers"
        aria-busy={loading || pending}
        hidden={!open}
        className="mt-2 max-h-72 overflow-y-auto rounded-sm border border-border-subtle bg-surface-raised empty:hidden"
      >
        {customers.map((customer, index) => (
          <li key={customer.id} role="presentation">
            <button
              id={`${id}-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              disabled={pending}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(customer.id)}
              className="flex min-h-11 w-full items-center justify-between gap-3 border-b border-border-subtle px-3 py-3 text-left text-sm last:border-b-0 hover:bg-surface-sunken aria-selected:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            >
              <span className="min-w-0 break-words">
                <span className="font-medium">
                  {customer.displayName}
                  {customer.id === customerId ? ' · Selected' : ''}
                </span>
                <span className="mt-1 block break-all text-xs text-text-muted">
                  Account ID: {customer.id}
                  {customer.phoneLast4 ? ` · Phone ending ${customer.phoneLast4}` : ''}
                </span>
              </span>
              <span className="shrink-0 font-mono tabular-nums">
                {customer.pointsBalance} points
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && !loading && !failed && (
        <p role="status" className="mt-3 text-sm text-text-muted">
          {!customers.length
            ? searching
              ? 'No matching customers. Try another name, phone or account ID.'
              : 'No loyalty activity at this branch yet. Search for a customer above.'
            : data.hasMore
              ? 'Showing the first 50 customers. Refine your search to find another customer.'
              : `${customers.length} customer${customers.length === 1 ? '' : 's'}`}
        </p>
      )}
    </div>
  );
}
