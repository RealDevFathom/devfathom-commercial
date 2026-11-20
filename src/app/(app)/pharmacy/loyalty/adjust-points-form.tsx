'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adjustPoints, type AdjustPointsFormState } from './adjust-points-actions';

const initial: AdjustPointsFormState = { status: 'idle', message: '' };
const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** DEV-764: manual points adjustment with a written reason, recorded as its own ledger entry. */
export function AdjustPointsForm({
  branchId,
  customerId,
}: {
  branchId: string;
  customerId: string;
}) {
  // One key per intended adjustment: a double submit records it once; a saved one gets a new key.
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [state, action, pending] = useActionState(
    async (previous: AdjustPointsFormState, form: FormData) => {
      const result = await adjustPoints(previous, form);
      if (result.status === 'saved') setIdempotencyKey(newKey());
      return result;
    },
    initial
  );
  const invalid = state.status === 'error';
  return (
    <form action={action} className="space-y-4" aria-describedby="adjust-points-status">
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid w-full gap-2 text-sm sm:w-40">
          Adjustment
          <StudioSelect
            name="direction"
            defaultValue="add"
            className="min-h-11 rounded-sm border border-border bg-surface-card px-3 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <option value="add">Add points</option>
            <option value="remove">Remove points</option>
          </StudioSelect>
        </label>
        <label className="grid w-full gap-2 text-sm sm:w-40">
          Number of points
          <Input
            name="points"
            inputMode="numeric"
            required
            aria-invalid={invalid || undefined}
            className="min-h-11"
          />
        </label>
        <label className="grid w-full min-w-0 gap-2 text-sm sm:flex-1">
          Reason
          <Input
            name="reason"
            required
            minLength={3}
            maxLength={500}
            placeholder="e.g. Points missed on receipt 1042"
            aria-invalid={invalid || undefined}
            className="min-h-11"
          />
        </label>
        <label className="grid w-full gap-2 text-sm sm:w-40">
          Your manager PIN
          <Input
            name="managerPin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9]{4,8}"
            maxLength={8}
            aria-describedby="adjust-points-pin-help"
            aria-invalid={invalid || undefined}
            className="min-h-11"
          />
        </label>
        <Button type="submit" className="min-h-11" disabled={pending}>
          {pending ? 'Saving…' : 'Record adjustment'}
        </Button>
      </div>
      <p id="adjust-points-pin-help" className="text-sm text-text-muted">
        Managers re-enter their own PIN for every adjustment. Owners can leave it blank.
      </p>
      <p
        id="adjust-points-status"
        aria-live="polite"
        className={`text-sm ${invalid ? 'text-destructive' : 'text-text-muted'}`}
      >
        {state.message ||
          'Owners, and managers up to the limit the owner sets for each customer per day. Each adjustment is kept in the ledger and the audit log with your name and reason; a removal cannot take more than the points that can still be spent.'}
      </p>
    </form>
  );
}
