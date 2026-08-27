import { type FormEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { validateOperatorCredential } from '@/components/terminal/terminal-state';

export type OperatorSwitchInput = { staffProfileId: string; type: 'PIN'; secret: string };

export function OperatorSwitch({
  activeOperatorId,
  pending,
  onSwitch,
}: {
  activeOperatorId: string;
  pending: boolean;
  onSwitch: (input: OperatorSwitchInput) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [staffProfileId, setStaffProfileId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateOperatorCredential(staffProfileId, pin);
    if (validation) return setError(validation);
    setError(null);
    if (await onSwitch({ staffProfileId: staffProfileId.trim(), type: 'PIN', secret: pin })) {
      setOpen(false);
      setStaffProfileId('');
      setPin('');
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        className="h-11"
        disabled={pending}
        onClick={() => setOpen(true)}
      >
        Switch operator
      </Button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="w-full space-y-3 rounded-lg border border-border-subtle bg-surface-card p-3 sm:w-80"
    >
      <p className="text-sm font-semibold text-text-strong">Incoming operator</p>
      <p className="text-xs text-text-muted">Currently acting: {activeOperatorId}</p>
      <div className="space-y-1.5">
        <Label htmlFor="switch-operator-id">Operator profile ID</Label>
        <Input
          id="switch-operator-id"
          autoFocus
          value={staffProfileId}
          onChange={(event) => setStaffProfileId(event.target.value)}
          className="h-11"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="switch-operator-pin">Operator PIN</Label>
        <Input
          id="switch-operator-pin"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
          className="h-11"
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending} className="h-11 flex-1">
          {pending ? 'Switching…' : 'Confirm switch'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          className="h-11"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
