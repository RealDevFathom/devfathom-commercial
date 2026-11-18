'use client';

import { useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { CardTerminalCounterView } from '@/lib/pharmacy/card-terminal/counter-view';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { trpc } from '@/lib/trpc';

/**
 * DEV-743: a manager or owner resolves a card-terminal payment waiting for review, from the
 * terminal slip, with their own PIN. The server decides who may: a cashier is refused there, and a
 * solo owner approves their own resolution with that PIN. Two outcomes only, the ones the
 * database allows: nothing was charged, or the money was taken and is refunded through the card
 * provider's own process. Either way the bill can then take another payment and the day can close.
 */

type Outcome = 'DECLINED' | 'REVERSED';

type Props = {
  branchId: string;
  view: CardTerminalCounterView;
  /** The person took this charge, and nobody else can resolve it at this branch (solo rule). */
  selfResolve?: boolean;
  onResolved: (next: CardTerminalCounterView) => Promise<void> | void;
};

const PIN = /^\d{4,8}$/;
const SLIP_REF = /^[A-Za-z0-9._:/-]{1,64}$/;

export function CounterCardTerminalReview({
  branchId,
  view,
  selfResolve = false,
  onResolved,
}: Props) {
  const id = useId();
  const resolve = trpc.pharmacyCardTerminal.resolveReview.useMutation();
  // The terminal reported a charge: it cannot be recorded as not charged.
  const [outcome, setOutcome] = useState<Outcome | null>(view.chargeReported ? 'REVERSED' : null);
  const [slipRef, setSlipRef] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  const trimmedReason = reason.trim();
  const ready =
    outcome !== null &&
    SLIP_REF.test(slipRef.trim()) &&
    trimmedReason.length >= 3 &&
    trimmedReason.length <= 200 &&
    PIN.test(pin) &&
    !resolve.isPending;

  async function submit() {
    if (!ready || inFlight.current || outcome === null) return;
    inFlight.current = true;
    setError('');
    try {
      const answer = await resolve.mutateAsync({
        branchId,
        attemptKey: view.attemptKey,
        outcome,
        resolutionReason: trimmedReason,
        slipRef: slipRef.trim(),
        managerPin: pin,
      });
      setPin('');
      if ('blocked' in answer) {
        setError(answer.blocked);
        return;
      }
      await onResolved(answer);
    } catch (failure) {
      setPin('');
      setError(counterErrorMessage(failure));
    } finally {
      inFlight.current = false;
    }
  }

  const options: { value: Outcome; label: string; hint: string; disabled: boolean }[] = [
    {
      value: 'DECLINED',
      label: 'Not charged',
      hint: view.chargeReported
        ? 'Not available: the terminal reported a charge for this payment.'
        : 'The slip shows the payment was declined or never taken. The bill can take another payment.',
      disabled: view.chargeReported,
    },
    {
      value: 'REVERSED',
      label: 'Money taken',
      hint: 'The slip shows the customer was charged. Record it here, refund it through the card provider’s own refund process, then take the payment again.',
      disabled: false,
    },
  ];

  return (
    <form
      aria-labelledby={`${id}-title`}
      className="space-y-3 border-t border-border-subtle pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1">
        <h4 id={`${id}-title`} className="text-sm font-semibold text-text-strong">
          Manager review
        </h4>
        <p className="text-sm text-text-muted">
          Only a manager or owner can record this, with their own PIN. Check the terminal slip
          first.
        </p>
        {selfResolve ? (
          <p className="text-sm text-text-body">
            You took this payment, and no other manager or owner can resolve it at this branch, so
            you may resolve it yourself with your PIN. It is recorded as self-approved.
          </p>
        ) : null}
        {view.reviewReason ? (
          <p className="text-sm text-text-body">Why it needs review: {view.reviewReason}</p>
        ) : null}
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-text-strong">
          What does the terminal slip show?
        </legend>
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-border-subtle p-3 has-[:checked]:border-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
          >
            <input
              type="radio"
              name={`${id}-outcome`}
              className="mt-1"
              value={option.value}
              checked={outcome === option.value}
              disabled={option.disabled || resolve.isPending}
              aria-describedby={`${id}-${option.value}-hint`}
              onChange={() => setOutcome(option.value)}
            />
            <span className="text-sm">
              <span className="block text-text-strong">{option.label}</span>
              <span id={`${id}-${option.value}-hint`} className="block text-text-muted">
                {option.hint}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="space-y-2">
        <Label htmlFor={`${id}-slip`}>Reference on the terminal slip</Label>
        <Input
          id={`${id}-slip`}
          className="h-11"
          autoComplete="off"
          maxLength={64}
          disabled={resolve.isPending}
          aria-describedby={`${id}-slip-hint`}
          value={slipRef}
          onChange={(event) => setSlipRef(event.target.value)}
        />
        <p id={`${id}-slip-hint`} className="text-sm text-text-muted">
          The transaction or reference number printed on the slip. Never the card number.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-reason`}>Reason</Label>
        <Textarea
          id={`${id}-reason`}
          maxLength={200}
          disabled={resolve.isPending}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-pin`}>Your manager or owner PIN</Label>
        <Input
          id={`${id}-pin`}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          className="h-11"
          disabled={resolve.isPending}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="h-11" disabled={!ready} aria-busy={resolve.isPending}>
        {resolve.isPending ? 'Recording review…' : 'Record review'}
      </Button>
    </form>
  );
}
