'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { amountInputError, amountInputToMinor } from '@/lib/money-input';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import { BPS, NO_MAXIMUM_DISCOUNT_BPS } from '@/lib/pharmacy/smart-discount';
import { trpc } from '@/lib/trpc';
import { percentToBps } from './discount-maximum-panel';

/** DEV-929: a manual discount the cashier set for the next item, as a share or an amount. */
export type CounterHeldDiscount =
  { kind: 'PERCENT'; bps: number } | { kind: 'AMOUNT'; minor: number };

/**
 * The discount, in minor units, the counter sends for a line of `grossMinor`. A percentage
 * rounds down, so it never exceeds the share the cashier asked for (or the owner's maximum).
 */
export function counterDiscountMinor(held: CounterHeldDiscount, grossMinor: number): number {
  return held.kind === 'PERCENT' ? Math.floor((grossMinor * held.bps) / BPS) : held.minor;
}

export function describeCounterDiscount(held: CounterHeldDiscount): string {
  return held.kind === 'PERCENT' ? `${held.bps / 100}%` : `Rs ${formatMinor(held.minor)}`;
}

/**
 * DEV-929: the counter's place to give a manual discount on the next item added. It shows the
 * owner's maximum and refuses a larger share before sending. The server stays the judge: it
 * re-checks the maximum, the cost floor and minimum margin, regulated medicines, and whether
 * the cashier may discount without a manager's PIN (the counter then asks for one).
 */
export function CounterDiscountEntry({
  branchId,
  held,
  disabled,
  onHold,
  onClear,
}: {
  branchId: string;
  held: CounterHeldDiscount | null;
  disabled: boolean;
  onHold: (discount: CounterHeldDiscount) => void;
  onClear: () => void;
}) {
  const id = useId();
  const maximum = trpc.pharmacySales.discountMaximum.useQuery({ branchId });
  const [kind, setKind] = useState<CounterHeldDiscount['kind']>('PERCENT');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stored = maximum.data?.maxDiscountBps;
  // The owner's maximum in bps, or null when none is set (or it has not loaded).
  const maxBps = stored !== undefined && stored < NO_MAXIMUM_DISCOUNT_BPS ? stored : null;

  if (held) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-subtle bg-surface-sunken p-3 text-sm"
        role="status"
      >
        <p className="min-w-0 text-text-body">
          A discount of {describeCounterDiscount(held)} comes off the next item you add.
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={disabled}
          onClick={onClear}
        >
          Remove discount
        </Button>
      </div>
    );
  }

  return (
    <details className="rounded-md border border-border-subtle p-3 text-sm">
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium focus-visible:outline-2 focus-visible:outline-ring">
        Give a discount
      </summary>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          if (kind === 'AMOUNT') {
            // DEV-939: the shared typed-amount reader, so "12.50" is 1250 exactly, never via a float.
            const amount = amountInputToMinor(value);
            if (amount.status === 'INVALID') {
              setError(amountInputError(amount.reason));
              return;
            }
            if (amount.status === 'EMPTY' || amount.minor === 0) {
              setError('Enter an amount in rupees above 0, with at most two decimal places.');
              return;
            }
            onHold({ kind, minor: amount.minor });
          } else {
            const bps = percentToBps(value);
            if (bps === null || bps === 0) {
              setError(
                'Enter a percentage above 0 and up to 100, with at most two decimal places.'
              );
              return;
            }
            if (maxBps !== null && bps > maxBps) {
              setError(
                `${bps / 100}% is above the owner's maximum discount of ${maxBps / 100}%. Give a smaller discount, or ask the owner to raise the maximum.`
              );
              return;
            }
            onHold({ kind, bps });
          }
          setValue('');
          setError(null);
        }}
      >
        <p id={`${id}-maximum`} className="text-text-body">
          {maximum.isLoading
            ? "Checking the owner's maximum discount…"
            : maximum.isError
              ? `The owner's maximum discount could not be loaded: ${counterErrorMessage(maximum.error)} The discount is still checked when you add the item.`
              : maxBps !== null
                ? `The owner's maximum discount is ${maxBps / 100}% of an item's price.`
                : "The owner has not set a maximum discount. A discount still cannot take an item below its cost or the branch's minimum margin."}
        </p>
        <fieldset className="space-y-1.5">
          <legend className="font-medium">Discount as</legend>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['PERCENT', 'Percentage (%)'],
                ['AMOUNT', 'Amount (Rs)'],
              ] as const
            ).map(([option, label]) => (
              <Button
                key={option}
                type="button"
                variant={kind === option ? 'default' : 'outline'}
                className="min-h-11"
                aria-pressed={kind === option}
                disabled={disabled}
                onClick={() => {
                  setKind(option);
                  setError(null);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </fieldset>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-value`}>
            {kind === 'PERCENT' ? 'Discount (%)' : 'Discount (Rs)'}
          </Label>
          <Input
            id={`${id}-value`}
            className="h-11 w-40"
            inputMode="decimal"
            autoComplete="off"
            value={value}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-maximum ${id}-help${error ? ` ${id}-error` : ''}`}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
          />
        </div>
        <p id={`${id}-help`} className="text-text-muted">
          Prescription, restricted and controlled medicines are never discounted. If you cannot give
          discounts on your own, a manager or owner approves with their PIN when you add the item.
        </p>
        {error ? (
          <p id={`${id}-error`} role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="min-h-11" disabled={disabled}>
          Apply to next item
        </Button>
      </form>
    </details>
  );
}
