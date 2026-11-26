'use client';

import { useEffect, useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { LostSaleOutcome } from '@/lib/pharmacy/lost-sales';

export const LOST_SALE_CHIPS: readonly { outcome: LostSaleOutcome; label: string }[] = [
  { outcome: 'SUBSTITUTE_TAKEN', label: 'Substitute taken' },
  { outcome: 'WILL_RETURN', label: 'Will return' },
  { outcome: 'WENT_ELSEWHERE', label: 'Went elsewhere' },
  { outcome: 'ORDERED_FOR_CUSTOMER', label: 'Ordered for customer' },
  { outcome: 'UNKNOWN', label: 'Unknown' },
];

export type LostSaleChoice = {
  outcome: LostSaleOutcome;
  notifyOptIn?: boolean;
  notifyPhone?: string;
};

export function CounterLostSaleChips({
  requested,
  onChoose,
  onDismiss,
  unmatched = false,
}: {
  requested: string;
  onChoose: (choice: LostSaleChoice) => void;
  onDismiss: () => void;
  unmatched?: boolean;
}) {
  const [notify, setNotify] = useState(false);
  const [phone, setPhone] = useState('');
  const phoneId = useId();
  const phoneDigits = phone.replace(/[\s-]/g, '');
  const phoneValid = /^\+?\d{10,15}$/.test(phoneDigits);
  const phoneInvalid = notify && phone.length > 0 && !phoneValid;

  const choose = (outcome: LostSaleOutcome) =>
    onChoose(
      notify && phoneValid ? { outcome, notifyOptIn: true, notifyPhone: phoneDigits } : { outcome }
    );

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.hasAttribute('data-counter-scan') ||
        event.repeat ||
        event.isComposing ||
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const chip = LOST_SALE_CHIPS[Number(event.key) - 1];
      if (!chip) return;
      event.preventDefault();
      onChoose(
        notify && phoneValid
          ? { outcome: chip.outcome, notifyOptIn: true, notifyPhone: phoneDigits }
          : { outcome: chip.outcome }
      );
    }
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [notify, onChoose, phoneDigits, phoneValid]);

  return (
    <section
      aria-label="What happened to the short line"
      className="mt-3 rounded-[var(--radius-md)] border border-border-subtle bg-surface-raised p-3 shadow-[var(--shadow-sm)]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-text-strong">
          {unmatched
            ? `Nothing matches '${requested}'. Was the customer asking for it?`
            : `What happened to the shortage of ${requested}?`}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Outcome">
        {LOST_SALE_CHIPS.map((chip, index) => (
          <Button
            key={chip.outcome}
            type="button"
            variant="outline"
            size="touch"
            className="rounded-full px-4"
            aria-label={chip.label}
            aria-keyshortcuts={`Alt+${index + 1}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(chip.outcome)}
          >
            {chip.label}{' '}
            <kbd aria-hidden="true" className="font-mono text-xs">
              Alt+{index + 1}
            </kbd>
          </Button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Label
          htmlFor={`${phoneId}-notify`}
          className="flex min-h-11 cursor-pointer items-center gap-2"
        >
          <Switch
            id={`${phoneId}-notify`}
            checked={notify}
            onCheckedChange={(checked) => setNotify(Boolean(checked))}
          />
          <span className="text-sm text-text-body">Notify when back (customer agrees)</span>
        </Label>
        {notify ? (
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={phoneId} className="sr-only">
              Customer phone
            </Label>
            <Input
              id={phoneId}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="Customer phone"
              className="h-11 w-48"
              value={phone}
              aria-invalid={phoneInvalid || undefined}
              aria-describedby={phoneInvalid ? `${phoneId}-error` : undefined}
              onChange={(event) => setPhone(event.target.value)}
            />
            {phoneInvalid ? (
              <p id={`${phoneId}-error`} className="text-xs text-destructive">
                Enter 10 to 15 digits, then tap an outcome.
              </p>
            ) : null}
          </div>
        ) : null}
        <Button type="button" variant="ghost" className="ml-auto h-11" onClick={onDismiss}>
          Skip
        </Button>
      </div>
    </section>
  );
}
