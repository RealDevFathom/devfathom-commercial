'use client';

import { useState } from 'react';
import Link from 'next/link';
import { SectionCard } from '@/components/ui/section-card';
import { EarnRateForm, type EarnRateChoice } from './earn-rate-form';

/**
 * DEV-814 — onboarding asks the owner whether to run a loyalty programme. No rate is ever
 * seeded: "Yes" opens the same earning-rate form (and server procedure, validation and
 * permission) as the loyalty page; "No" stores nothing. The step is not a readiness gate,
 * so skipping it never blocks finishing onboarding.
 */
export function OnboardingLoyaltyStep({ presets }: { presets: readonly EarnRateChoice[] }) {
  const [choice, setChoice] = useState<'yes' | 'no' | null>(null);
  const answers = [
    { id: 'yes', label: 'Yes, customers earn points' },
    { id: 'no', label: 'No, not now' },
  ] as const;
  return (
    <SectionCard eyebrow="Optional" title="Loyalty programme" titleLevel={2}>
      <div className="space-y-4">
        <p className="text-sm text-text-muted">
          Do you want customers to earn loyalty points on their purchases? No rate is set for you
          — until you choose one, no points are earned. You can skip this and decide later; it
          does not hold up your setup.
        </p>
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-semibold text-text-strong">
            Enable the loyalty programme?
          </legend>
          {answers.map((answer) => (
            <label key={answer.id} className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="radio"
                name="loyalty-enable"
                value={answer.id}
                checked={choice === answer.id}
                onChange={() => setChoice(answer.id)}
                className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring"
              />
              {answer.label}
            </label>
          ))}
        </fieldset>
        {choice === 'yes' && <EarnRateForm presets={presets} />}
        {choice === 'no' && (
          <p className="text-sm text-text-muted" role="status">
            Loyalty stays off and nothing is saved. You can turn it on any time from{' '}
            <Link
              href="/pharmacy/loyalty"
              className="text-primary underline underline-offset-4 hover:text-accent-brand"
            >
              Loyalty
            </Link>
            .
          </p>
        )}
      </div>
    </SectionCard>
  );
}
