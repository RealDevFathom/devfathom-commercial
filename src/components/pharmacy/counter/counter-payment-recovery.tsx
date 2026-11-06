'use client';

import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ManualPaymentSettings } from '@/lib/pharmacy/manual-payments';

export function CounterPaymentRecovery({
  attempt,
  settings,
  pending,
  onResolve,
}: {
  attempt: { id: string; state: string; method: string; canResolve: boolean };
  settings?: ManualPaymentSettings;
  pending: boolean;
  onResolve: (input: {
    decision: 'CONFIRM' | 'RELEASE';
    reason: string;
    payerName?: string;
    providerRef?: string;
    referenceSkipped?: boolean;
  }) => Promise<void>;
}) {
  const field = useId();
  const [reason, setReason] = useState('');
  const [payerName, setPayerName] = useState('');
  const [providerRef, setProviderRef] = useState('');
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(false);
  if (['SETTLED', 'RELEASED'].includes(attempt.state)) return null;
  if (
    !attempt.canResolve ||
    !['BANK_TRANSFER', 'RAAST', 'JAZZCASH', 'EASYPAISA'].includes(attempt.method) ||
    !['PREPARED', 'EXPOSED', 'UNKNOWN', 'CONFIRMED'].includes(attempt.state)
  )
    return (
      <p role="status" className="text-sm text-text-muted">
        {['CARD', 'WALLET'].includes(attempt.method)
          ? 'This payment needs certified provider reconciliation. A manual card or online-wallet confirmation is not available.'
          : 'Only an authorized Owner or Manager can confirm or release this uncertain payment.'}
      </p>
    );
  const wallet = ['RAAST', 'JAZZCASH', 'EASYPAISA'].includes(attempt.method);
  const allowSkip =
    wallet &&
    settings?.[attempt.method as 'RAAST' | 'JAZZCASH' | 'EASYPAISA']?.allowReferenceSkip === true;
  const confirmed = attempt.state === 'CONFIRMED';
  const captureValid =
    !wallet ||
    confirmed ||
    (payerName.trim().length > 0 &&
      ((skipped && allowSkip) || /^\d{4,6}$/.test(providerRef.trim())));
  async function resolve(decision: 'CONFIRM' | 'RELEASE') {
    if (pending || active.current || !reason.trim() || (decision === 'CONFIRM' && !captureValid))
      return;
    active.current = true;
    setError('');
    try {
      await onResolve({
        decision,
        reason: reason.trim(),
        ...(decision === 'CONFIRM' && wallet && !confirmed
          ? {
              payerName: payerName.trim(),
              ...(skipped && allowSkip
                ? { referenceSkipped: true }
                : { providerRef: providerRef.trim() }),
            }
          : {}),
      });
    } catch {
      setError(
        'Resolution could not be confirmed. Keep this payment locked and check its outcome again.'
      );
    } finally {
      active.current = false;
    }
  }
  return (
    <section
      aria-label="Resolve uncertain payment"
      className="space-y-3 rounded-md border border-border-subtle bg-surface-sunken p-4 text-sm"
    >
      <p className="font-medium text-text-strong">Owner or Manager review</p>
      <p className="text-text-body">
        Check the branch account before confirming funds. Release only after verifying that no
        unrecorded funds remain. Your decision and reason are recorded.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={`${field}-reason`}>Reason for decision</Label>
        <Input
          id={`${field}-reason`}
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          disabled={pending}
          className="min-h-11"
        />
      </div>
      {wallet && !confirmed ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-payer`}>Payer’s name for confirmation</Label>
            <Input
              id={`${field}-payer`}
              value={payerName}
              maxLength={100}
              onChange={(event) => setPayerName(event.target.value)}
              disabled={pending}
              className="min-h-11"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-reference`}>
              Transaction ID · last 4 to 6 digits for confirmation
            </Label>
            <Input
              id={`${field}-reference`}
              inputMode="numeric"
              value={providerRef}
              maxLength={6}
              onChange={(event) => setProviderRef(event.target.value)}
              disabled={pending || (skipped && allowSkip)}
              className="min-h-11"
            />
          </div>
          {allowSkip ? (
            <Label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={skipped}
                disabled={pending}
                onChange={(event) => setSkipped(event.target.checked)}
              />
              Skip transaction ID under branch policy
            </Label>
          ) : null}
        </>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <Button
          className="min-h-11"
          disabled={pending || !reason.trim() || !captureValid}
          onClick={() => void resolve('CONFIRM')}
        >
          {confirmed ? 'Finish recording confirmed funds' : 'Confirm funds arrived'}
        </Button>
        <Button
          variant="outline"
          className="min-h-11"
          disabled={pending || !reason.trim() || confirmed}
          onClick={() => void resolve('RELEASE')}
        >
          Release pending claim
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
