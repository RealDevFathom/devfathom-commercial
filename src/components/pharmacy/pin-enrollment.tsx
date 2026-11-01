'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';

export function PharmacyPinEnrollment() {
  const status = trpc.pharmacyPin.status.useQuery();
  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const enroll = trpc.pharmacyPin.enroll.useMutation({
    onSuccess: () => {
      setPin('');
      setConfirmation('');
      void status.refetch();
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (pin !== confirmation) {
      setError('The PINs must match.');
      return;
    }
    setError('');
    enroll.mutate({ pin });
  }
  if (status.isPending) return <p role="status">Loading your PIN enrollment…</p>;
  if (status.error)
    return (
      <p role="alert" className="text-destructive">
        {status.error.message}
      </p>
    );
  if (status.data?.enrolled || enroll.isSuccess)
    return (
      <p role="status" className="text-text-body">
        Your pharmacy approval PIN is enrolled. Use it to confirm purchasing and other sensitive
        decisions. Ask your administrator if you need a reset.
      </p>
    );
  const message = error || enroll.error?.message;
  return (
    <form onSubmit={submit} className="max-w-md space-y-4">
      <p className="text-sm text-text-muted">
        Choose your own 4–8 digit PIN. It confirms your identity without granting additional
        permissions. A sole owner can use it for audited self-approval; staffed pharmacies require a
        separate authorized approver.
      </p>
      <div className="space-y-2">
        <Label htmlFor="pharmacy-pin">New pharmacy PIN</Label>
        <Input
          id="pharmacy-pin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          pattern="[0-9]{4,8}"
          minLength={4}
          maxLength={8}
          required
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          aria-invalid={!!message}
          aria-describedby={message ? 'pin-error' : undefined}
          className="min-h-11"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="pharmacy-pin-confirm">Confirm pharmacy PIN</Label>
        <Input
          id="pharmacy-pin-confirm"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          pattern="[0-9]{4,8}"
          minLength={4}
          maxLength={8}
          required
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          aria-invalid={!!message}
          aria-describedby={message ? 'pin-error' : undefined}
          className="min-h-11"
        />
      </div>
      {message && (
        <p id="pin-error" role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <Button type="submit" disabled={enroll.isPending} className="min-h-11">
        {enroll.isPending ? 'Enrolling…' : 'Enroll pharmacy PIN'}
      </Button>
    </form>
  );
}
