'use client';

import { useId, useRef, useState } from 'react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OwnPinLink, PinAwareMessage } from '@/components/pharmacy/pin-aware-message';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { trpc } from '@/lib/trpc';

/**
 * DEV-950: at payment, a prescription line waits for a pharmacist's signature. A pharmacist who
 * rang it up alone (nobody else at this branch could sign it) is offered to sign it here with
 * their own PIN; the server checks every rule again and records the signature as self-approved.
 * Anyone else is told who signs it. Shown only to a person with the dispensing right; a cashier
 * sees the payment refusal the server already gives.
 */

const PIN = /^\d{4,8}$/;
const QUEUE_PATH = '/pharmacy/pharmacist-queue';

type Props = { branchId: string; saleId: string | null; enabled: boolean; onSigned?: () => void };

export function CounterRxSelfSign({ branchId, saleId, enabled, onSigned }: Props) {
  const status = trpc.pharmacyDispensing.counterSignStatus.useQuery(
    { branchId, saleId: saleId ?? '' },
    { enabled: enabled && Boolean(branchId && saleId), retry: false, staleTime: 0 }
  );
  const lines = status.data?.lines ?? [];
  if (!enabled || !saleId || lines.length === 0) return null;
  return (
    <section
      aria-label="Prescription lines waiting for a signature"
      data-counter-rx-self-sign=""
      className="mb-4 space-y-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm"
    >
      {lines.map((line) => (
        <div key={line.reviewItemId} className="space-y-2">
          <h3 className="font-semibold text-text-strong">
            {line.productName} needs a pharmacist’s signature
          </h3>
          {line.maySelfSign ? (
            <SelfSignForm
              reviewItemId={line.reviewItemId}
              pin={status.data?.pin ?? null}
              onSigned={async () => {
                await status.refetch();
                onSigned?.();
              }}
            />
          ) : line.rungUpByYou && line.askName ? (
            <p className="text-text-body">
              You rang up this line, so another pharmacist at this branch signs it. Ask{' '}
              {line.askName} to sign it in the{' '}
              <Link
                href={QUEUE_PATH}
                className="font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
              >
                pharmacist queue
              </Link>
              , then take payment.
            </p>
          ) : line.rungUpByYou && line.controlled ? (
            <p className="text-text-body">
              A controlled medicine needs an independent pharmacist’s signature. It cannot be
              self-signed.
            </p>
          ) : (
            <p className="text-text-body">
              Sign it in the{' '}
              <Link
                href={QUEUE_PATH}
                className="font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
              >
                pharmacist queue
              </Link>
              , then take payment.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

function SelfSignForm({
  reviewItemId,
  pin: pinState,
  onSigned,
}: {
  reviewItemId: string;
  pin: { state: 'SET' | 'NOT_SET' | 'RESET'; locked: boolean } | null;
  onSigned: () => Promise<void>;
}) {
  const id = useId();
  const sign = trpc.pharmacyDispensing.selfSignReview.useMutation();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const ready = PIN.test(pin) && !sign.isPending;

  if (pinState && pinState.state !== 'SET')
    return (
      <p className="text-text-body">
        You rang up this line and nobody else at this branch can sign it, so you sign it yourself
        with your PIN. You have not set up your PIN yet. <OwnPinLink />, then come back to sign.
      </p>
    );

  async function submit() {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setError('');
    try {
      await sign.mutateAsync({ reviewItemId, pin });
      setPin('');
      await onSigned();
    } catch (failure) {
      setPin('');
      setError(counterErrorMessage(failure));
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p id={`${id}-help`} className="text-text-body">
        You rang up this line and nobody else at this branch can sign it, so sign it yourself with
        your PIN. Your signature is recorded as self-approved.
      </p>
      {pinState?.locked ? (
        <p className="text-text-body">
          Your PIN is locked after too many wrong tries. Wait until the lock ends, then try again.
        </p>
      ) : null}
      <Label htmlFor={`${id}-pin`}>Your PIN</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`${id}-pin`}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          className="h-11 max-w-40"
          disabled={sign.isPending}
          aria-describedby={`${id}-help`}
          aria-invalid={error ? true : undefined}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
        />
        <Button type="submit" className="h-11" disabled={!ready} aria-busy={sign.isPending}>
          {sign.isPending ? 'Signing…' : 'Sign with my PIN'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          <PinAwareMessage message={error} />
        </p>
      ) : null}
    </form>
  );
}
