'use client';
import { startTransition, useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LOYALTY_RATE_OPTIONS } from '@/lib/pharmacy/loyalty-rate';
import { saveLoyaltySettings } from './actions';

export function LoyaltySettingsForm({
  digest,
  migrated,
  khataEnabled = false,
}: {
  digest: string;
  migrated: boolean;
  khataEnabled?: boolean;
}) {
  const [state, action, pending] = useActionState(saveLoyaltySettings, {
    message: '',
    saved: false,
  });
  const [option, setOption] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
      className="space-y-4"
    >
      <input type="hidden" name="reconciliationDigest" value={digest} />
      <label className="block space-y-2">
        Earning rate
        <select
          name="option"
          required
          value={option}
          onChange={(event) => setOption(event.target.value)}
          className="block min-h-11 w-full rounded-sm border border-border-default bg-surface-paper px-3 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <option value="" disabled>
            Choose a rate
          </option>
          {LOYALTY_RATE_OPTIONS.map((rate) => (
            <option key={rate.id} value={rate.id}>
              {rate.label}
            </option>
          ))}
          <option value="percent-custom">Custom percentage</option>
          <option value="step-custom">Custom points per spend step</option>
        </select>
      </label>
      {option === 'percent-custom' && (
        <label className="block space-y-2">
          Percentage of spend
          <Input
            className="min-h-11"
            name="percentage"
            type="number"
            min="0.01"
            max="100"
            step="0.01"
            required
          />
        </label>
      )}
      {option === 'step-custom' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <label>
            Points per step
            <Input
              className="min-h-11"
              name="pointsPerStep"
              type="number"
              min="1"
              max="1000000"
              step="1"
              required
            />
          </label>
          <label>
            Spend per step (PKR)
            <Input
              className="min-h-11"
              name="spendRupees"
              type="number"
              min="1"
              max="20000000"
              step="1"
              required
            />
          </label>
        </div>
      )}
      <p className="text-sm text-text-muted">
        All products qualify. Points use whole-number rounding down for each sale or collection
        allocation. Spending points does not earn more points. One point always redeems for PKR 1.
      </p>
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" name="khataEnabled" defaultChecked={khataEnabled} />
        Earn on Khata collections, including partial payments
      </label>
      <p className="text-sm text-text-muted">
        Khata never earns at sale time. Existing sales that already earned on credit will not earn
        twice. Consent is checked when points are earned.
      </p>
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" name="approveReconciliation" required />
        {migrated
          ? 'I approve this rate for future earning.'
          : 'I reviewed the balances above and approve combining them across this organization’s branches without changing their value.'}
      </label>
      {state.message && <p role={state.saved ? 'status' : 'alert'}>{state.message}</p>}
      <Button size="touch" type="submit" disabled={pending || !option}>
        {pending ? 'Saving…' : 'Save earning settings'}
      </Button>
    </form>
  );
}
