'use client';

import { type RefObject, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
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
 *
 * DEV-972: it sits on the bill side as a compact "Discount" button that opens a small panel,
 * and one short line with its remove action while a discount is held, so nothing comes between
 * the search box and its results. Escape (or applying the discount) closes the panel and focus
 * returns to `returnFocus`.
 */
export function CounterDiscountEntry({
  branchId,
  held,
  disabled,
  onHold,
  onClear,
  returnFocus,
}: {
  branchId: string;
  held: CounterHeldDiscount | null;
  disabled: boolean;
  onHold: (discount: CounterHeldDiscount) => void;
  onClear: () => void;
  /** Where focus goes when the panel closes (the counter's search box). */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const valueRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
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
        role="status"
        title={`A discount of ${describeCounterDiscount(held)} comes off the next item you add.`}
        className="flex min-w-0 items-center gap-1 rounded-xs bg-surface-sunken ps-3 text-sm"
      >
        <span className="min-w-0 truncate text-text-body">
          {describeCounterDiscount(held)} off the next item
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          aria-label="Remove discount"
          disabled={disabled}
          onClick={onClear}
        >
          <X aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="outline" className="min-h-11" />}>
        Discount
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="max-h-(--available-height) w-96 max-w-[calc(100vw-2rem)] overflow-y-auto p-3"
        initialFocus={valueRef}
        finalFocus={returnFocus ?? true}
      >
        <PopoverTitle className="text-sm font-semibold text-text-strong">
          Discount on the next item
        </PopoverTitle>
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
            setOpen(false);
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
              ref={valueRef}
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
            Prescription, restricted and controlled medicines are never discounted. If you cannot
            give discounts on your own, a manager or owner approves with their PIN when you add the
            item.
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
      </PopoverContent>
    </Popover>
  );
}
