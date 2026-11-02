'use client';

import { useId } from 'react';
import { moneyLabel } from '@/lib/finance/currency';
import type { InvoiceAmountsResult } from '@/lib/finance/invoice-amounts';
import { cn } from '@/lib/utils';

/**
 * DEV-252 / #448: the discount and tax inputs and the totals ledger shared by
 * the create and edit invoice forms. Both are AMOUNTS in the invoice currency,
 * and every figure shown comes from `computeInvoiceAmounts`, the calculation
 * the server persists, so the preview and the saved invoice agree to the cent.
 */

/** A money input's text as a number: blank is 0, anything unparsable is NaN. */
export function parseMoneyInput(value: string): number {
  return value.trim() === '' ? 0 : Number(value);
}

/** The error the shared calculation reports for one field, if it is that field's. */
export function amountsErrorFor(
  result: InvoiceAmountsResult,
  ...fields: Array<'items' | 'subtotal' | 'discount' | 'tax' | 'total'>
): string | null {
  return !result.ok && fields.includes(result.field) ? result.message : null;
}

export function InvoiceMoneyInput({
  label,
  currency,
  value,
  onChange,
  error,
}: {
  label: string;
  currency: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-foreground">
        {label} ({currency})
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="0.00"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="w-full rounded-xl border border-border bg-background px-3 py-2 text-right text-sm tabular-nums text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20"
      />
      {error && (
        <p id={errorId} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Subtotal, discount, tax and total, as the invoice will be saved and printed. */
export function InvoiceTotalsSummary({
  result,
  subtotal,
  currency,
  className,
}: {
  /** The shared calculation for the form's current lines, discount and tax. */
  result: InvoiceAmountsResult;
  /** The lines' subtotal on its own, still shown while the discount is invalid. */
  subtotal: number | null;
  currency: string;
  className?: string;
}) {
  const amounts = result.ok ? result.amounts : null;
  const money = (value: number | null | undefined) =>
    value === null || value === undefined ? '—' : moneyLabel(value, currency);
  return (
    <dl className={cn('w-full space-y-1 text-sm', className)}>
      <div className="flex justify-between gap-4 text-muted-foreground">
        <dt>Subtotal</dt>
        <dd className="tabular-nums">{money(amounts?.subtotal ?? subtotal)}</dd>
      </div>
      <div className="flex justify-between gap-4 text-muted-foreground">
        <dt>Discount</dt>
        <dd className="tabular-nums">
          {amounts && amounts.discount > 0
            ? `−${money(amounts.discount)}`
            : money(amounts?.discount)}
        </dd>
      </div>
      <div className="flex justify-between gap-4 text-muted-foreground">
        <dt>Tax</dt>
        <dd className="tabular-nums">{money(amounts?.tax)}</dd>
      </div>
      <div className="flex items-baseline justify-between gap-4 border-t border-border/60 pt-2 text-foreground">
        <dt className="font-semibold">Total</dt>
        <dd className="font-display text-xl font-bold tabular-nums">{money(amounts?.total)}</dd>
      </div>
    </dl>
  );
}
