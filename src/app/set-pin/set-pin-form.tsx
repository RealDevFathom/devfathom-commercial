'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trpc } from '@/lib/trpc';

export function SetPinForm() {
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const mutation = trpc.restaurantStaff.setOwnPin.useMutation({
    onSuccess: () => {
      setPin('');
      setConfirmation('');
      router.replace('/dashboard');
      router.refresh();
    },
    onError: (failure) => setError(failure.message),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pin !== confirmation) {
      setError('PINs do not match.');
      return;
    }
    setError('');
    mutation.mutate({ secret: pin });
  }
  return (
    <form className="mt-6 space-y-4" onSubmit={submit}>
      <label className="block text-sm text-text-body">
        New PIN
        <Input
          className="mt-1.5 min-h-11"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{4,8}"
          required
          value={pin}
          onChange={(event) => setPin(event.target.value)}
        />
      </label>
      <label className="block text-sm text-text-body">
        Confirm PIN
        <Input
          className="mt-1.5 min-h-11"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{4,8}"
          required
          aria-invalid={error === 'PINs do not match.'}
          aria-describedby={error ? 'pin-error' : undefined}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </label>
      {error ? (
        <p id="pin-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="min-h-11" disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Set PIN'}
      </Button>
    </form>
  );
}
