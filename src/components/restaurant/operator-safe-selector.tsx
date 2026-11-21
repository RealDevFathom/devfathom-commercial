'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useEffect, useMemo, useState } from 'react';

export type OperatorSafeOption = { value: string; label: string; code?: string };

export function OperatorSafeSelector({
  label,
  name,
  options,
  value,
  onChange,
  loading = false,
  error = false,
  forbidden = false,
  disabled = false,
  required = false,
  emptyLabel = 'No available choices',
  placeholder = 'Choose an option',
}: {
  label: string;
  name?: string;
  options: OperatorSafeOption[];
  value: string;
  onChange: (value: string) => void;
  loading?: boolean;
  error?: boolean;
  forbidden?: boolean;
  disabled?: boolean;
  required?: boolean;
  emptyLabel?: string;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () =>
      options.filter(
        (option) =>
          option.value === value ||
          `${option.label} ${option.code ?? ''}`.toLocaleLowerCase().includes(normalized)
      ),
    [normalized, options, value]
  );
  const stale = Boolean(value) && !options.some((option) => option.value === value);
  useEffect(() => {
    if (stale) onChange('');
  }, [onChange, stale]);
  const unavailable = loading || error || forbidden || disabled || options.length === 0;
  const status = loading
    ? `Loading ${label.toLocaleLowerCase()}…`
    : forbidden
      ? `${label} unavailable for your access`
      : error
        ? `${label} unavailable — try again`
        : options.length === 0
          ? emptyLabel
          : stale
            ? `Previous ${label.toLocaleLowerCase()} is no longer available`
            : null;

  return (
    <div className="space-y-1.5">
      <input
        aria-label={`Search ${label.toLocaleLowerCase()}`}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Search ${label.toLocaleLowerCase()}`}
        disabled={unavailable}
        className="h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <StudioSelect
        aria-label={label}
        name={name}
        required={required}
        value={stale ? '' : value}
        onChange={(event) => onChange(event.target.value)}
        disabled={unavailable}
        aria-invalid={stale || undefined}
        className="h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="">{status ?? placeholder}</option>
        {filtered.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
            {option.code ? ` — ${option.code}` : ''}
          </option>
        ))}
      </StudioSelect>
      {stale ? (
        <p role="alert" className="text-xs text-destructive">
          The previous choice is no longer available. Choose another option.
        </p>
      ) : null}
      {!status && normalized && filtered.length === 0 ? (
        <p role="status" className="text-xs text-text-muted">
          No choices match this search.
        </p>
      ) : null}
    </div>
  );
}
