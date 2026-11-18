'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { parseAmountMinor } from './counter-tender-panel';
import { COUNTER_NATIVE_SELECT_CLASS, type CounterCashier } from './counter-drawer-operator';

export type CounterOpenDrawerStepProps = {
  /** Status not yet known, a write in flight, or no authorized branch. */
  disabled: boolean;
  disabledReason?: string | null;
  /** Presentation only; the server checks manager access on every float write. */
  canDeclareFloat?: boolean;
  /** The drawer status read failed: the drawer may or may not be open. */
  statusError?: boolean;
  /** The manager-access check has not answered yet; the step waits for it. */
  accessChecking?: boolean;
  /** Site storage is blocked, so this browser has no counter device id. */
  deviceUnavailable?: boolean;
  /** A drawer status read is in flight. */
  checking?: boolean;
  onRetry?: () => void;
  /**
   * DEV-821: the branch cashiers a manager or owner may hand the till to as it
   * opens. Omitted for a cashier, who always runs the drawer they open.
   */
  cashiers?: readonly CounterCashier[];
  /** The signed-in user, the default cashier for the till. */
  currentUserId?: string;
  /** `operatingCashierId` is sent only when someone other than the opener runs the till. */
  onOpen: (openingFloatMinor: number, operatingCashierId?: string) => void;
  /** DEV-508: where and when this drawer opens, so the cashier can check before confirming. */
  context?: { branch: string | null; counter: string | null; businessDay: string };
};

/** DEV-508: common opening floats. Choosing one only fills the field; Open drawer confirms. */
export const OPENING_FLOAT_QUICK_AMOUNTS = ['0', '1000', '2000', '5000'] as const;

/**
 * DEV-725: the first step of a shift. Until this counter device has an OPEN
 * drawer the counter shows this step in place of scan/search, so a cashier
 * never builds a bill they are then refused at payment. The server enforces the
 * same rule when a bill is created.
 */
export function CounterOpenDrawerStep({
  disabled,
  disabledReason,
  canDeclareFloat = false,
  statusError = false,
  deviceUnavailable = false,
  accessChecking = false,
  checking = false,
  onRetry,
  cashiers,
  currentUserId,
  onOpen,
  context,
}: CounterOpenDrawerStepProps) {
  const [openingCash, setOpeningCash] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [cashierId, setCashierId] = useState(currentUserId ?? '');
  const waiting = disabled || accessChecking;
  const openingCashRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // A disabled field cannot receive its mount-time autofocus while access loads.
    // Preserve focus if the cashier has already chosen another control.
    if (!waiting && document.activeElement === document.body) openingCashRef.current?.focus();
  }, [waiting]);
  const chooseCashier = canDeclareFloat && Boolean(cashiers?.length);
  // One rule on any connection: the count is always typed (a typed 0 is allowed).
  // The server still refuses a float above 0 from anyone but a manager or owner.
  const openingFloatMinor = parseAmountMinor(openingCash);
  const reason = waiting
    ? deviceUnavailable
      ? 'Allow site storage for this site, then reload before opening the drawer.'
      : accessChecking
        ? 'Checking your access…'
        : (disabledReason ?? 'Wait for the current counter action to finish.')
    : null;
  const invalid = submitted && openingFloatMinor === null;

  return (
    <form
      aria-labelledby="counter-open-drawer-title"
      className="space-y-3 rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (waiting || openingFloatMinor === null) return;
        onOpen(
          openingFloatMinor,
          chooseCashier && cashierId && cashierId !== currentUserId ? cashierId : undefined
        );
      }}
    >
      <div className="space-y-1">
        <h3 id="counter-open-drawer-title" className="text-sm font-semibold text-text-strong">
          Open the cash drawer to start the shift
        </h3>
        <p className="text-sm text-text-body">
          {canDeclareFloat
            ? 'Count the cash in the drawer and enter it below. Bills can be started once the drawer is open.'
            : 'Type 0 only if the drawer is empty. Ask a manager or owner to declare any opening float. Bills can be started once the drawer is open.'}
        </p>
      </div>
      {context ? (
        <dl
          aria-label="Drawer details"
          className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-3"
        >
          {(
            [
              ['Branch', context.branch],
              ['Counter', context.counter],
              ['Business day', context.businessDay],
            ] as const
          ).map(([term, value]) =>
            value ? (
              <div key={term} className="min-w-0">
                <dt className="text-xs text-text-muted">{term}</dt>
                <dd className="truncate text-text-strong">{value}</dd>
              </div>
            ) : null
          )}
        </dl>
      ) : null}
      {deviceUnavailable ? (
        <p
          role="alert"
          className="rounded-[var(--radius-xs)] border border-warning/30 bg-warning/10 p-3 text-sm text-text-body"
        >
          This browser is blocking site storage, so the counter cannot identify this device or its
          cash drawer. Allow site storage for this site, then reload the page.
        </p>
      ) : statusError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-xs)] border border-warning/30 bg-warning/10 p-3"
        >
          <p className="text-sm text-text-body">
            This counter could not check its cash drawer. Check again, or open it below.
          </p>
          {onRetry ? (
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={checking}
              onClick={onRetry}
            >
              {checking ? 'Checking…' : 'Check drawer again'}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="counter-opening-cash">Opening cash</Label>
          <Input
            id="counter-opening-cash"
            ref={openingCashRef}
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            placeholder="0.00"
            value={openingCash}
            disabled={waiting}
            aria-invalid={invalid}
            aria-describedby={
              [
                invalid ? 'counter-opening-cash-error' : '',
                reason ? 'counter-drawer-disabled-reason' : '',
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
            onChange={(event) => setOpeningCash(event.target.value)}
            className="h-11 font-mono tabular-nums"
          />
        </div>
        {chooseCashier ? (
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="counter-drawer-cashier">Who runs this till</Label>
            <select
              id="counter-drawer-cashier"
              className={COUNTER_NATIVE_SELECT_CLASS}
              value={cashierId}
              disabled={waiting}
              aria-describedby={reason ? 'counter-drawer-disabled-reason' : undefined}
              onChange={(event) => setCashierId(event.target.value)}
            >
              {currentUserId && !cashiers!.some((cashier) => cashier.id === currentUserId) ? (
                <option value={currentUserId}>You</option>
              ) : null}
              {cashiers!.map((cashier) => (
                <option key={cashier.id} value={cashier.id}>
                  {cashier.id === currentUserId ? `${cashier.name} (you)` : cashier.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <Button
          type="submit"
          className="h-11"
          disabled={waiting}
          aria-describedby={reason ? 'counter-drawer-disabled-reason' : undefined}
        >
          Open drawer
        </Button>
      </div>
      {reason ? (
        <p id="counter-drawer-disabled-reason" className="text-sm text-text-muted">
          {reason}
        </p>
      ) : null}
      {canDeclareFloat ? (
        <div role="group" aria-label="Quick amounts" className="flex flex-wrap gap-2">
          {OPENING_FLOAT_QUICK_AMOUNTS.map((amount) => (
            <Button
              key={amount}
              type="button"
              variant="outline"
              className="h-11 font-mono tabular-nums"
              aria-pressed={openingCash === amount}
              disabled={waiting}
              aria-describedby={reason ? 'counter-drawer-disabled-reason' : undefined}
              onClick={() => setOpeningCash(amount)}
            >
              {amount === '0' ? 'Empty (0)' : `PKR ${Number(amount).toLocaleString('en-PK')}`}
            </Button>
          ))}
        </div>
      ) : null}
      {canDeclareFloat ? (
        <p className="text-xs text-text-muted">
          An opening cash above 0 needs a manager or owner. Enter 0 when the drawer is empty.
        </p>
      ) : null}
      {chooseCashier ? (
        <p className="text-sm text-text-muted">
          Only the cashier who runs the till, or a manager or owner, can take cash into it.
        </p>
      ) : null}
      {invalid ? (
        <p id="counter-opening-cash-error" role="alert" className="text-sm text-destructive">
          Enter the opening cash, for example 5000 or 0 for an empty drawer.
        </p>
      ) : null}
    </form>
  );
}
