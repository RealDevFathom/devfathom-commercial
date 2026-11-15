'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { saveEarnRate, type EarnRateFormState } from './earn-rate-actions';

export type EarnRateChoice = { id: string; label: string };

const initial: EarnRateFormState = { status: 'idle', message: '' };
const fieldClass = 'grid w-full gap-2 text-sm sm:w-48';

export function EarnRateForm({ presets }: { presets: readonly EarnRateChoice[] }) {
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
