'use client';

import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { MAX_MONEY } from '@/lib/finance/money';

export function InvoiceAdjustments({
  tax,
  discount,
  currency,
  onTaxChange,
  onDiscountChange,
  error,
}: {
  tax: string;
  discount: string;
  currency: string;
  onTaxChange: (value: string) => void;
  onDiscountChange: (value: string) => void;
  error: string | null;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[
          { name: 'Tax', value: tax, change: onTaxChange },
          { name: 'Discount', value: discount, change: onDiscountChange },
        ].map((field) => (
          <div key={field.name}>
            <label
              htmlFor={`${id}-${field.name}`}
              className="mb-1 block text-xs font-medium text-foreground"
            >
              {field.name} ({currency})
            </label>
            <Input
              id={`${id}-${field.name}`}
              type="number"
              min="0"
              max={MAX_MONEY}
              step="0.01"
              value={field.value}
              onChange={(event) => field.change(event.target.value)}
              aria-invalid={!!error}
              aria-describedby={`${id}-help`}
              className="h-11 text-right tabular-nums"
            />
          </div>
        ))}
      </div>
      <p
        id={`${id}-help`}
        className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
        role={error ? 'alert' : undefined}
      >
        {error ?? 'Enter fixed amounts. Total = subtotal − discount + tax.'}
      </p>
    </div>
  );
}
