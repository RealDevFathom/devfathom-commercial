import { SelectField as StudioSelect } from '@/components/ui/select-field';
import { type FormEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { validateOperatorCredential } from '@/components/terminal/terminal-state';

export type OperatorSwitchInput = { staffProfileId: string; type: 'PIN'; secret: string };

export function OperatorSwitch({
  activeOperatorId,
  operators,
  pending,
  onSwitch,
}: {
  activeOperatorId: string;
  operators: Array<{ staffProfileId: string; displayName: string; role: string }>;
  pending: boolean;
  onSwitch: (input: OperatorSwitchInput) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [staffProfileId, setStaffProfileId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const activeOperator = operators.find((operator) => operator.staffProfileId === activeOperatorId);

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
      <p className="text-xs text-text-muted">
        Currently acting: {activeOperator?.displayName ?? 'Operator name unavailable'}
        {activeOperator?.role ? ` — ${activeOperator.role}` : ''}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="switch-operator-id">Operator</Label>
        <StudioSelect
          id="switch-operator-id"
          autoFocus
          value={staffProfileId}
          onChange={(event) => setStaffProfileId(event.target.value)}
          disabled={pending || operators.length === 0}
          className="h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="" disabled>
            {operators.length ? 'Select an operator' : 'No eligible operators for this branch'}
          </option>
          {operators.map((operator) => (
            <option key={operator.staffProfileId} value={operator.staffProfileId}>
              {operator.displayName} — {operator.role}
            </option>
          ))}
        </StudioSelect>
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
        <Button type="submit" disabled={pending || operators.length === 0} className="h-11 flex-1">
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
