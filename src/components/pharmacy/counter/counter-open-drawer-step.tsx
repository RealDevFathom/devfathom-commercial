'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { parseAmountMinor } from './counter-tender-panel';

export type CounterOpenDrawerStepProps = {
  /** Status not yet known, a write in flight, or no authorized branch. */
  disabled: boolean;
  onOpen: (openingFloatMinor: number) => void;
};

/**
 * DEV-725: the first step of a shift. Until this counter device has an OPEN
 * drawer the counter shows this step in place of scan/search, so a cashier
 * never builds a bill they are then refused at payment. The server enforces the
 * same rule when a bill is created.
 */
export function CounterOpenDrawerStep({ disabled, onOpen }: CounterOpenDrawerStepProps) {
  const [openingCash, setOpeningCash] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const openingFloatMinor = parseAmountMinor(openingCash);
  const invalid = submitted && openingFloatMinor === null;

  return (
    <form
      aria-labelledby="counter-open-drawer-title"
      className="space-y-3 rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (disabled || openingFloatMinor === null) return;
        onOpen(openingFloatMinor);
      }}
    >
      <div className="space-y-1">
        <h3 id="counter-open-drawer-title" className="text-sm font-semibold text-text-strong">
          Open the cash drawer to start the shift
        </h3>
        <p className="text-sm text-text-body">
          Count the cash in the drawer and enter it below. Bills can be started once the drawer is
          open.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="counter-opening-cash">Opening cash</Label>
          <Input
            id="counter-opening-cash"
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            placeholder="0.00"
            value={openingCash}
            disabled={disabled}
            aria-invalid={invalid}
            aria-describedby={invalid ? 'counter-opening-cash-error' : undefined}
            onChange={(event) => setOpeningCash(event.target.value)}
            className="h-11 font-mono tabular-nums"
          />
        </div>
        <Button type="submit" className="h-11" disabled={disabled}>
          Open drawer
        </Button>
      </div>
      {invalid ? (
        <p id="counter-opening-cash-error" role="alert" className="text-sm text-destructive">
          Enter the opening cash, for example 5000 or 0 for an empty drawer.
        </p>
      ) : null}
    </form>
  );
}
