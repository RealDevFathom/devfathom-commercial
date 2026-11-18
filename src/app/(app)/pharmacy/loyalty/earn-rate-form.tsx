'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { saveEarnRate, type EarnRateFormState } from './earn-rate-actions';

export type EarnRateChoice = { id: string; label: string };
/** DEV-764: the program settings in force, used as the form's starting values. */
export type ProgramDefaults = {
  pointValue: string;
  expiryDays: number | null;
  khataEarns: boolean;
  managerAdjustLimitPoints: number;
};

const initial: EarnRateFormState = { status: 'idle', message: '' };
const fieldClass = 'grid w-full gap-2 text-sm sm:w-48';

export function EarnRateForm({
  presets,
  defaults = { pointValue: '1', expiryDays: null, khataEarns: true, managerAdjustLimitPoints: 500 },
}: {
  presets: readonly EarnRateChoice[];
  defaults?: ProgramDefaults;
}) {
  const [state, action, pending] = useActionState(saveEarnRate, initial);
  const [option, setOption] = useState(presets[0]?.id ?? 'custom-percent');
  const invalid = state.status === 'error';
  const choices = [
    ...presets,
    { id: 'custom-percent', label: 'A percentage of spend I choose' },
    { id: 'custom-step', label: 'Points for every spend step I choose' },
  ];
  return (
    <form action={action} className="space-y-4" aria-describedby="earn-rate-status">
      <fieldset className="grid gap-2" aria-invalid={invalid || undefined}>
        <legend className="mb-2 text-sm font-semibold text-text-strong">
          How points are earned
        </legend>
        {choices.map((choice) => (
          <label key={choice.id} className="flex min-h-11 items-center gap-3 text-sm">
            <input
              type="radio"
              name="option"
              value={choice.id}
              checked={option === choice.id}
              onChange={() => setOption(choice.id)}
              className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring"
            />
            {choice.label}
          </label>
        ))}
      </fieldset>
      {option === 'custom-percent' && (
        <label className={fieldClass}>
          Percentage of spend
          <Input
            name="percent"
            inputMode="decimal"
            required
            placeholder="e.g. 1.5"
            aria-invalid={invalid || undefined}
            className="min-h-11"
          />
        </label>
      )}
      {option === 'custom-step' && (
        <div className="flex flex-wrap gap-3">
          <label className={fieldClass}>
            Points
            <Input
              name="stepPoints"
              inputMode="numeric"
              required
              placeholder="e.g. 1"
              aria-invalid={invalid || undefined}
              className="min-h-11"
            />
          </label>
          <label className={fieldClass}>
            For every PKR
            <Input
              name="stepRupees"
              inputMode="numeric"
              required
              placeholder="e.g. 1000"
              aria-invalid={invalid || undefined}
              className="min-h-11"
            />
          </label>
        </div>
      )}
      <fieldset className="grid gap-4" aria-invalid={invalid || undefined}>
        <legend className="mb-2 text-sm font-semibold text-text-strong">
          Redemption and expiry
        </legend>
        <div className="flex flex-wrap gap-3">
          <label className={fieldClass}>
            PKR value of 1 point
            <Input
              name="pointValue"
              inputMode="decimal"
              required
              defaultValue={defaults.pointValue}
              aria-describedby="point-value-help"
              aria-invalid={invalid || undefined}
              className="min-h-11"
            />
          </label>
          <label className={fieldClass}>
            Points expire after (days)
            <Input
              name="expiryDays"
              inputMode="numeric"
              defaultValue={defaults.expiryDays ?? ''}
              placeholder="Never"
              aria-describedby="expiry-help"
              aria-invalid={invalid || undefined}
              className="min-h-11"
            />
          </label>
        </div>
        <p id="point-value-help" className="text-sm text-text-muted">
          What one point takes off a bill at the counter. Changing it changes the value of every
          point customers already hold, not only points earned from now on: raising it raises your
          liability for all unredeemed points.
        </p>
        <p id="expiry-help" className="text-sm text-text-muted">
          Leave blank and points never expire. Points expire by the date each was earned.
        </p>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            type="checkbox"
            name="khataEarns"
            defaultChecked={defaults.khataEarns}
            className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring"
          />
          Khata purchases earn points once the customer pays them off
        </label>
        <label className={fieldClass}>
          Largest manager adjustment (points)
          <Input
            name="managerAdjustLimitPoints"
            inputMode="numeric"
            required
            defaultValue={defaults.managerAdjustLimitPoints}
            aria-describedby="adjust-limit-help"
            aria-invalid={invalid || undefined}
            className="min-h-11"
          />
        </label>
        <p id="adjust-limit-help" className="text-sm text-text-muted">
          A manager can add or remove up to this many points for a customer in one day, across all
          of that day&apos;s adjustments. Larger totals need the owner. Every adjustment is audited.
        </p>
      </fieldset>
      <Button type="submit" className="min-h-11" disabled={pending}>
        {pending ? 'Saving…' : 'Save earning rate'}
      </Button>
      <p
        id="earn-rate-status"
        role={invalid ? 'alert' : undefined}
        aria-live="polite"
        className={`text-sm ${invalid ? 'text-destructive' : 'text-text-muted'}`}
      >
        {state.message}
      </p>
    </form>
  );
}
