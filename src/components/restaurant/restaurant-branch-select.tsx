'use client';

import { SelectField } from '@/components/ui/select-field';

type BranchOption = {
  id: string;
  name: string;
  code?: string;
  active: boolean;
  isDefault: boolean;
};

const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

export function RestaurantBranchSelect({
  id,
  name,
  value,
  defaultValue,
  branches,
  loading = false,
  error = false,
  required = false,
  allowEmpty = false,
  emptyLabel = 'No branch',
  disabled = false,
  onChange,
  ariaLabel = 'Branch',
}: {
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  branches: BranchOption[];
  loading?: boolean;
  error?: boolean;
  required?: boolean;
  allowEmpty?: boolean;
  emptyLabel?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
  ariaLabel?: string;
}) {
  const available = branches.filter((branch) => branch.active);
  const unavailable = loading || error || available.length === 0;
  const prompt = loading
    ? 'Loading branches…'
    : error
      ? 'Branches unavailable — retry the page'
      : available.length === 0
        ? 'No active branches — create one first'
        : 'Select a branch';

  return (
    <SelectField
      id={id}
      name={name}
      value={value}
      defaultValue={value === undefined ? defaultValue : undefined}
      required={required}
      disabled={disabled || unavailable}
      className={selectClass}
      aria-invalid={error || undefined}
      aria-label={ariaLabel}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {allowEmpty ? <option value="">{emptyLabel}</option> : null}
      {!allowEmpty && (!value || unavailable) ? (
        <option value="" disabled>
          {prompt}
        </option>
      ) : null}
      {available.map((branch) => (
        <option key={branch.id} value={branch.id}>
          {branch.name}
          {branch.code ? ` · ${branch.code}` : ''}
          {branch.isDefault ? ' (default)' : ''}
        </option>
      ))}
    </SelectField>
  );
}
