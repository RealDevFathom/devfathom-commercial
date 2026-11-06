import type * as React from 'react';

import { StatusPill } from '@/components/ui/status-pill';
import { SUPPLIER_NOT_CHECKED_LABEL } from '@/lib/pharmacy/supplier-compliance';
import { cn } from '@/lib/utils';
import type { Notice, SupplierPickerOption } from '../_lib/types';

/**
 * The form vocabulary the PH-PUR surfaces share.
 *
 * Two UX rules drive every control here. Rule 11: a validation failure names
 * the field, says the fix in plain words, and focuses the input — so `Field`
 * takes the notice and decides for itself whether it is the one at fault. Rule
 * 1 and 16: an identifier is never typed, so the only way to name a supplier,
 * branch, medicine, pack or location is a `<select>` of this organization's
 * records.
 */

export const CONTROL =
  'min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong ' +
  'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive';

export function fieldInvalid(notice: Notice | null, name: string): boolean {
  return notice?.kind === 'error' && notice.field === name;
}

/**
 * A labelled control with its own error slot. The error is rendered next to the
 * input and wired with `aria-describedby`, and the offending control takes
 * focus on load — the network tab is not an error message.
 */
export function Field({
  name,
  label,
  hint,
  notice,
  children,
  className,
}: {
  name: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  notice: Notice | null;
  children: (props: {
    id: string;
    name: string;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
    autoFocus: boolean;
    className: string;
  }) => React.ReactNode;
  className?: string;
}) {
  const invalid = fieldInvalid(notice, name);
  const id = `field-${name}`;
  const describedBy = invalid ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <label className="block text-sm font-medium text-text-body" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        name,
        'aria-invalid': invalid,
        'aria-describedby': describedBy,
        autoFocus: invalid,
        className: CONTROL,
      })}
      {invalid ? (
        <p className="text-sm text-destructive" id={`${id}-error`}>
          {notice!.message}
        </p>
      ) : hint ? (
        <p className="text-xs text-text-muted" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextField(props: {
  name: string;
  label: React.ReactNode;
  notice: Notice | null;
  hint?: React.ReactNode;
  type?: 'text' | 'date' | 'number' | 'password';
  defaultValue?: string | number;
  placeholder?: string;
  required?: boolean;
  min?: number;
  step?: string;
  inputMode?: 'numeric' | 'decimal' | 'text';
  autoComplete?: string;
  className?: string;
}) {
  const { label, notice, hint, className, ...input } = props;
  return (
    <Field className={className} label={label} name={props.name} notice={notice} hint={hint}>
      {(control) => <input {...control} {...input} type={props.type ?? 'text'} />}
    </Field>
  );
}

export function TextAreaField(props: {
  name: string;
  label: React.ReactNode;
  notice: Notice | null;
  hint?: React.ReactNode;
  defaultValue?: string;
  required?: boolean;
  rows?: number;
  className?: string;
}) {
  const { label, notice, hint, className, ...input } = props;
  return (
    <Field className={className} label={label} name={props.name} notice={notice} hint={hint}>
      {(control) => (
        <textarea
          {...control}
          {...input}
          className={cn(control.className, 'min-h-[5.5rem] py-2')}
          rows={props.rows ?? 3}
        />
      )}
    </Field>
  );
}

export type SelectOption = { value: string; label: string; disabled?: boolean };

/**
 * UX rule 12: a required select that can be empty is a dead end unless it says
 * what the missing thing is and where to create it, so `emptyHint` is required
 * rather than optional and is rendered whenever there is nothing to choose.
 */
export function SelectField({
  name,
  label,
  notice,
  options,
  emptyHint,
  hint,
  defaultValue,
  required,
  placeholder,
  className,
}: {
  name: string;
  label: React.ReactNode;
  notice: Notice | null;
  options: SelectOption[];
  emptyHint: React.ReactNode;
  hint?: React.ReactNode;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
  className?: string;
}) {
  if (options.length === 0) {
    return (
      <div className={cn('min-w-0 space-y-1', className)}>
        <span className="block text-sm font-medium text-text-body">{label}</span>
        <p className="rounded-[var(--radius-sm)] border border-dashed border-border-default p-3 text-sm text-text-muted">
          {emptyHint}
        </p>
      </div>
    );
  }
  return (
    <Field className={className} label={label} name={name} notice={notice} hint={hint}>
      {(control) => (
        <select {...control} defaultValue={defaultValue ?? ''} required={required}>
          <option disabled={required} value="">
            {placeholder ?? 'Choose…'}
          </option>
          {options.map((option) => (
            <option disabled={option.disabled} key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/**
 * PUR-01 in a dropdown. A supplier that cannot be ordered from stays visible
 * and says why, but is not selectable: offering it would produce a refusal the
 * operator could not have predicted, and hiding it would make an authorized
 * supplier that lapsed look deleted. While the owner has the supplier checks off
 * (DEV-753) every supplier is selectable and says it was not checked.
 */
export function supplierOptions(suppliers: readonly SupplierPickerOption[]): SelectOption[] {
  return suppliers.map((supplier) => ({
    value: supplier.id,
    disabled: !supplier.eligibility.orderable,
    // A summary without `compliance` (an older cached one) reads as checked: fail closed.
    label:
      supplier.compliance?.checked === false
        ? `${supplier.name} — not checked`
        : supplier.eligibility.orderable
          ? supplier.name
          : `${supplier.name} — ${
              supplier.eligibility.reason === 'NOT_AUTHORIZED'
                ? 'not authorized'
                : 'no valid licence'
            }`,
  }));
}

/**
 * The primary action of a form. Sized to the 44px touch target the goods-in
 * bench needs when it is being operated with one hand and a scanner.
 */
export function SubmitButton({
  children,
  variant = 'primary',
  name,
  value,
  disabled,
}: {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'destructive';
  name?: string;
  value?: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={cn(
        'inline-flex min-h-11 items-center justify-center rounded-[var(--radius-sm)] px-4 text-sm font-medium transition-colors',
        'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-primary text-primary-foreground hover:bg-primary-hover',
        variant === 'secondary' && 'border border-border-default text-text-strong hover:bg-muted',
        variant === 'destructive' && 'bg-destructive/10 text-destructive hover:bg-destructive/20'
      )}
      disabled={disabled}
      name={name}
      type="submit"
      value={value}
    >
      {children}
    </button>
  );
}

/** A short read-back of a derived number, so it is visible before it is committed. */
export function Derived({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <p className="text-xs text-text-muted">
      <span className="font-mono uppercase tracking-wide">{label}</span>{' '}
      <span className="font-mono tabular-nums text-text-strong">{value}</span>
    </p>
  );
}

export function LicenceBadge({ supplier }: { supplier: SupplierPickerOption }) {
  // DEV-753: with the owner's checks off nothing was verified, so the badge says so
  // and never reads "Orderable", "Licensed" or "Authorized" on the policy's account.
  if (supplier.compliance?.checked === false) {
    return <StatusPill status="Not checked" tone="warning" label={SUPPLIER_NOT_CHECKED_LABEL} />;
  }
  if (supplier.eligibility.orderable) {
    const days = supplier.governingLicence?.daysToExpiry;
    return (
      <StatusPill
        status="Orderable"
        tone={days != null && days <= 30 ? 'warning' : 'success'}
        label={days != null && days <= 30 ? `Licence expires in ${days}d` : 'Orderable'}
      />
    );
  }
  return (
    <StatusPill
      status="Blocked"
      tone="danger"
      label={
        supplier.eligibility.reason === 'NOT_AUTHORIZED' ? 'Not authorized' : 'No valid licence'
      }
    />
  );
}
