'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

export type RestaurantStaffOption = {
  id: string;
  displayName: string;
  role: string;
  canSelfApprove?: boolean;
};

const selectClass =
  'h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

export function RestaurantStaffSelect({
  id,
  name,
  value,
  defaultValue,
  staff,
  loading = false,
  error = false,
  required = false,
  allowEmpty = false,
  emptyLabel = 'No staff member',
  disabled = false,
  label = 'Staff member',
  onChange,
}: {
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  staff: RestaurantStaffOption[];
  loading?: boolean;
  error?: boolean;
  required?: boolean;
  allowEmpty?: boolean;
  emptyLabel?: string;
  disabled?: boolean;
  label?: string;
  onChange?: (value: string) => void;
}) {
  const unavailable = loading || error || staff.length === 0;
  const prompt = loading
    ? 'Loading eligible staff…'
    : error
      ? 'Staff unavailable — retry the page'
      : staff.length === 0
        ? 'No eligible staff for this branch'
        : `Select ${label.toLowerCase()}`;

  return (
    <StudioSelect
      id={id}
      name={name}
      value={value}
      defaultValue={value === undefined ? defaultValue : undefined}
      required={required}
      disabled={disabled || unavailable}
      className={selectClass}
      aria-label={label}
      aria-invalid={error || undefined}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {allowEmpty ? <option value="">{emptyLabel}</option> : null}
      {!allowEmpty && (!value || unavailable) ? (
        <option value="" disabled>
          {prompt}
        </option>
      ) : null}
      {staff.map((person) => (
        <option key={person.id} value={person.id}>
          {person.displayName} — {person.role}
        </option>
      ))}
    </StudioSelect>
  );
}
