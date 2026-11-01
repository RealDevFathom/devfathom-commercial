'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';

export function OperatingModeSettings({ initialMode }: { initialMode: 'SOLO' | 'STAFFED' }) {
  const [mode, setMode] = useState(initialMode);
  const [pin, setPin] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutation = trpc.pharmacyOperatingMode.set.useMutation({
    onSuccess: (saved) => {
      setMode(saved.pharmacyOperatingMode);
      setPin('');
      setNotice('Operating mode changed and recorded in the audit log.');
    },
    onError: (cause) => {
      setPin('');
      setError(cause.message);
    },
  });
  const next = mode === 'SOLO' ? 'STAFFED' : 'SOLO';

  function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    setError(null);
    mutation.mutate({ mode: next, pin });
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <StatusPill status={mode} tone={mode === 'SOLO' ? 'warning' : 'neutral'} />
          <p className="max-w-2xl text-sm text-text-body">
            {mode === 'SOLO'
              ? 'The owner may perform separated duties after PIN re-authentication. Other users are retained but do not receive the solo exception.'
              : 'Prescription approval, overrides, and maker-checker work require appropriately separated staff.'}
          </p>
        </div>
      </div>
      <div className="max-w-sm">
        <Label htmlFor="operating-mode-pin">Owner PIN</Label>
        <Input
          id="operating-mode-pin"
          type="password"
          className="mt-1 min-h-11"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{4,8}"
          minLength={4}
          maxLength={8}
          required
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? 'operating-mode-error' : undefined}
        />
      </div>
      <p className="text-sm text-text-muted">
        <a href="/pharmacy/settings/pin" className="underline">
          Enroll or rotate your pharmacy approval PIN
        </a>
      </p>
      <Button type="submit" disabled={mutation.isPending || !/^\d{4,8}$/.test(pin)}>
        {mutation.isPending ? 'Changing…' : `Switch to ${next}`}
      </Button>
      {error ? (
        <p id="operating-mode-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-text-body">
          {notice}
        </p>
      ) : null}
    </form>
  );
}
