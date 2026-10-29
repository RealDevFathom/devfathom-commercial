'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';

export function OperatingModeSettings({ initialMode }: { initialMode: 'SOLO' | 'STAFFED' }) {
  const [mode, setMode] = useState(initialMode);
  const [pin, setPin] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = trpc.pharmacyOperatingMode.set.useMutation({
    onSuccess: (saved) => {
      setMode(saved.pharmacyOperatingMode);
      setPin('');
      setNotice('Operating mode changed and recorded in the audit log.');
    },
    onError: (error) => setNotice(error.message),
  });
  const next = mode === 'SOLO' ? 'STAFFED' : 'SOLO';

  function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
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
        <input
          id="operating-mode-pin"
          type="password"
          className="mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{4,8}"
          required
          value={pin}
          onChange={(event) => setPin(event.target.value)}
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
      {notice ? (
        <p role="status" className="text-sm text-text-body">
          {notice}
        </p>
      ) : null}
    </form>
  );
}
