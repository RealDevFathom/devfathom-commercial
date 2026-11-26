'use client';

import { useId, useRef, useState } from 'react';
import { LateControlledReviewForm } from '../dispensing/late-controlled-review-form';
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
 *
 * DEV-960: at a branch where the owner turned "One pharmacist per shift" on, a pharmacist with
 * colleagues on the staff list may still sign their own line, by ticking "I am the only pharmacist
 * on duty now" and entering their PIN. The sign-off is recorded as declared, with who else was on
 * the staff list, for the owner's list.
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
          <h3 className="text-sm font-semibold text-text-strong">
            {line.productName} needs a pharmacist’s signature
          </h3>
          {line.mayRecordLate ? (
            <LateControlledReviewForm
              reviewItemId={line.reviewItemId}
              onRecorded={async () => {
                await status.refetch();
                onSigned?.();
              }}
            />
          ) : line.maySelfSign || (line.mayDeclareSolo && status.data?.declaration) ? (
            <SelfSignForm
              reviewItemId={line.reviewItemId}
              declaration={line.maySelfSign ? null : (status.data?.declaration ?? null)}
              askName={line.askName}
              pin={status.data?.pin ?? null}
              checking={status.isFetching}
              onRefresh={async () => {
                await status.refetch();
              }}
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
  declaration = null,
  askName = null,
  pin: pinState,
  checking = false,
  onRefresh,
  onSigned,
}: {
  reviewItemId: string;
  /** DEV-960: the on-duty declaration to confirm; null for the staff-list solo rule. */
  declaration?: { version: string; text: string } | null;
  /** DEV-960: someone on the staff list who could sign it instead, for the declared form. */
  askName?: string | null;
  pin: { state: 'SET' | 'NOT_SET' | 'RESET'; locked: boolean } | null;
  checking?: boolean;
  /** Reads the line and the PIN state again (after a refusal, or once a lock may have ended). */
  onRefresh: () => Promise<void>;
  onSigned: () => Promise<void>;
}) {
  const id = useId();
  const sign = trpc.pharmacyDispensing.selfSignReview.useMutation();
  const [pin, setPin] = useState('');
  const [declared, setDeclared] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  // The server refuses a locked PIN anyway; the form says so and takes no PIN meanwhile.
  const locked = pinState?.locked === true;
  const ready = PIN.test(pin) && !sign.isPending && !locked && (!declaration || declared);

  if (pinState && pinState.state !== 'SET')
    return declaration ? (
      <p className="text-text-body">
        You rang up this line. If you are the only pharmacist on duty now, you can sign it yourself
        with your PIN. You have not set up your PIN yet. <OwnPinLink />, then come back to sign, or
        ask {askName ?? 'another pharmacist'} to sign it in the{' '}
        <Link
          href={QUEUE_PATH}
          className="font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
        >
          pharmacist queue
        </Link>
        .
      </p>
    ) : (
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
      await sign.mutateAsync({
        reviewItemId,
        pin,
        ...(declaration
          ? { declaration: { onlyPharmacistOnDuty: true as const, version: declaration.version } }
          : {}),
      });
      setPin('');
      setDeclared(false);
      await onSigned();
    } catch (failure) {
      setPin('');
      setError(counterErrorMessage(failure));
      // A refused PIN may have just locked it: show that state at once.
      await onRefresh().catch(() => undefined);
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
      {declaration ? (
        <>
          <p id={`${id}-help`} className="text-text-body">
            You rang up this line. This branch runs one pharmacist per shift: if you are the only
            pharmacist on duty now, sign it yourself with your PIN. Your signature is recorded as a
            declared solo sign-off, with the others on the staff list, and the owner sees it.
            Otherwise ask {askName ?? 'another pharmacist'} to sign it in the{' '}
            <Link
              href={QUEUE_PATH}
              className="font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
            >
              pharmacist queue
            </Link>
            .
          </p>
          <label className="flex min-h-11 items-start gap-2 text-text-body">
            <input
              className="mt-0.5 size-4 shrink-0 accent-primary"
              type="checkbox"
              name="onlyPharmacistOnDuty"
              checked={declared}
              disabled={sign.isPending || locked}
              onChange={(event) => setDeclared(event.target.checked)}
            />
            {declaration.text}
          </label>
        </>
      ) : (
        <p id={`${id}-help`} className="text-text-body">
          You rang up this line and nobody else at this branch can sign it, so sign it yourself with
          your PIN. Your signature is recorded as self-approved.
        </p>
      )}
      {locked ? (
        <div className="flex flex-wrap items-center gap-2">
          <p id={`${id}-locked`} role="status" className="text-text-body">
            Your PIN is locked after too many wrong tries. Wait until the lock ends, then try again.
          </p>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={checking}
            onClick={() => void onRefresh()}
          >
            {checking ? 'Checking…' : 'Check again'}
          </Button>
        </div>
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
          disabled={sign.isPending || locked}
          aria-describedby={locked ? `${id}-help ${id}-locked` : `${id}-help`}
          aria-invalid={error ? true : undefined}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
        />
        <Button type="submit" className="h-11" disabled={!ready} aria-busy={sign.isPending}>
          {sign.isPending ? 'Signing…' : 'Sign with my PIN'}
        </Button>
      </div>
      {error && !locked ? (
        <p role="alert" className="text-destructive">
          <PinAwareMessage message={error} />
        </p>
      ) : null}
    </form>
  );
}
