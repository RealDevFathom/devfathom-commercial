'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export type CounterCashier = { id: string; name: string };

/** A native select dressed as the shared `Input`, for short pick-lists at the counter. */
export const COUNTER_NATIVE_SELECT_CLASS =
  'h-11 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-base text-text-strong outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30';

export type CounterDrawerOperatorProps = {
  /** Who runs the open till, as the server reports it. */
  operatingCashier: { name: string | null; isYou: boolean };
  /** The branch cashiers, present only for a manager or owner. */
  cashiers?: readonly CounterCashier[];
  /** A handover is being saved. */
  pending?: boolean;
  /** Resolves once the server has recorded the handover; rejects when it refused. */
  onHandover?: (toCashierId: string, reason: string) => Promise<void>;
};

/**
 * DEV-821: who runs this counter's open till. Cash goes only into a till the
 * signed-in user runs, so a cashier at someone else's till is told before they
 * take a cash payment; a manager or owner can hand the till over, with a reason
 * the close reports keep.
 */
export function CounterDrawerOperator({
  operatingCashier,
  cashiers,
  pending = false,
  onHandover,
}: CounterDrawerOperatorProps) {
  const [open, setOpen] = useState(false);
  const [toCashierId, setToCashierId] = useState('');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const canHandOver = Boolean(cashiers?.length && onHandover);
  const runBy = operatingCashier.name ?? 'another team member';
  if (operatingCashier.isYou && !canHandOver) return null;
  const missingCashier = submitted && !toCashierId;
  const missingReason = submitted && !reason.trim();

  return (
    <div
      className="space-y-3 rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-3"
      aria-labelledby="counter-drawer-operator-title"
      role="region"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id="counter-drawer-operator-title" className="text-sm text-text-body">
          {operatingCashier.isYou ? (
            <>You run this cash drawer.</>
          ) : (
            <>
              <span className="font-semibold text-text-strong">{runBy}</span> runs this cash drawer.{' '}
              {canHandOver
                ? 'As a manager or owner you can still take cash, or hand the till over.'
                : 'Ask a manager or owner to hand it over to you before you take cash.'}
            </>
          )}
        </p>
        {canHandOver && !open ? (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={pending}
            aria-describedby={pending ? 'counter-handover-pending' : undefined}
            onClick={() => setOpen(true)}
          >
            Hand over till
          </Button>
        ) : null}
      </div>
      {pending ? (
        <p id="counter-handover-pending" className="text-sm text-text-muted">
          Saving the change of cashier. Please wait.
        </p>
      ) : null}
      {canHandOver && open ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if (pending || !toCashierId || !reason.trim()) return;
            onHandover!(toCashierId, reason.trim()).then(
              () => {
                setOpen(false);
                setToCashierId('');
                setReason('');
                setSubmitted(false);
              },
              // The caller shows the refusal; the form keeps its values to retry.
              () => undefined
            );
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="counter-handover-cashier">Hand the till to</Label>
              <select
                id="counter-handover-cashier"
                className={COUNTER_NATIVE_SELECT_CLASS}
                value={toCashierId}
                disabled={pending}
                aria-invalid={missingCashier}
                aria-describedby={
                  pending
                    ? 'counter-handover-pending'
                    : missingCashier
                      ? 'counter-handover-error'
                      : undefined
                }
                onChange={(event) => setToCashierId(event.target.value)}
              >
                <option value="">Choose a cashier</option>
                {cashiers!.map((cashier) => (
                  <option key={cashier.id} value={cashier.id}>
                    {cashier.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0 flex-[2] space-y-1.5">
              <Label htmlFor="counter-handover-reason">Reason</Label>
              <Input
                id="counter-handover-reason"
                className="h-11"
                autoComplete="off"
                maxLength={500}
                placeholder="Shift change"
                value={reason}
                disabled={pending}
                aria-invalid={missingReason}
                aria-describedby={
                  pending
                    ? 'counter-handover-pending'
                    : missingReason
                      ? 'counter-handover-error'
                      : undefined
                }
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={pending}
              aria-describedby={pending ? 'counter-handover-pending' : undefined}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="h-11"
              disabled={pending}
              aria-describedby={pending ? 'counter-handover-pending' : undefined}
            >
              {pending ? 'Handing over…' : 'Hand over'}
            </Button>
          </div>
          {missingCashier || missingReason ? (
            <p id="counter-handover-error" role="alert" className="text-sm text-destructive">
              Choose the cashier and give a reason. The close report keeps both.
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
