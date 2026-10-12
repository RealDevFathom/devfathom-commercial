'use client';

import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  calculateContributionScenario,
  CONTRIBUTION_CONDITIONS,
  CONTRIBUTION_DEFINITION,
  type ContributionContext,
  type ContributionInputs,
} from '@/lib/restaurant/contribution-scenario';

const emptyInputs: ContributionInputs = {
  unitPrice: '',
  unitVariableCost: '',
  quantity: '',
  discount: '0',
  incrementalCost: '',
};
const fields = [
  ['unitPrice', 'Unit price'],
  ['unitVariableCost', 'Unit variable cost'],
  ['quantity', 'Quantity'],
  ['discount', 'Discount per unit'],
  ['incrementalCost', 'Incremental cost'],
] as const;

export function ContributionScenarios({
  branchId,
  from,
  to,
}: Omit<ContributionContext, 'currency'>) {
  const id = useId();
  const [baseline, setBaseline] = useState({ ...emptyInputs });
  const [scenario, setScenario] = useState({ ...emptyInputs });
  const [currency, setCurrency] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [exportError, setExportError] = useState(false);
  const result = calculateContributionScenario({
    baseline,
    scenario,
    context: { branchId, from, to, currency },
  });
  const errors = attempted && !result.ok ? result.errors : {};
  const evidence = submitted && result.ok ? result.evidence : null;

  function edited() {
    setSubmitted(false);
    setExportError(false);
  }

  function exportEvidence() {
    if (!evidence) return;
    setExportError(false);
    let url: string | undefined;
    let anchor: HTMLAnchorElement | undefined;
    try {
      url = URL.createObjectURL(
        new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' })
      );
      anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'restaurant-contribution-assumptions.json';
      document.body.appendChild(anchor);
      anchor.click();
    } catch {
      setExportError(true);
    } finally {
      anchor?.remove();
      if (url) URL.revokeObjectURL(url);
    }
  }

  return (
    <SectionCard title="Contribution scenarios" titleLevel={2}>
      <div className="space-y-5">
        <StatusPill status="Assumptions" tone="neutral" />
        <p className="max-w-3xl text-sm text-text-body">
          Compare a baseline you enter with a proposed scenario. Insights rollups do not supply a
          complete observed variable-cost baseline. These inputs are assumptions, not historical
          facts. Enter known costs, including an explicit 0 where appropriate; an unknown cost
          cannot be treated as zero.
        </p>
        <p className="text-sm text-text-muted">
          Planning period: {from || 'Unspecified start'} to {to || 'unspecified end'}. Scope:{' '}
          {branchId ? `selected branch (${branchId})` : 'manual scenario, no branch selected'}. No
          branch data is used. Currency is user-entered for both cases; amounts use major units.
        </p>
        <form
          noValidate
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            setAttempted(true);
            setSubmitted(result.ok);
            setExportError(false);
          }}
        >
          <div className="max-w-xs space-y-1.5">
            <label htmlFor={`${id}-currency`} className="text-sm font-medium">
              Assumed currency code
            </label>
            <Input
              id={`${id}-currency`}
              className="h-11"
              value={currency}
              maxLength={3}
              placeholder="e.g. PKR"
              autoComplete="off"
              aria-invalid={Boolean(errors.currency)}
              aria-describedby={errors.currency ? `${id}-currency-error` : undefined}
              onChange={(event) => {
                setCurrency(event.target.value.toUpperCase());
                edited();
              }}
            />
            {errors.currency ? (
              <p id={`${id}-currency-error`} className="text-sm text-destructive">
                {errors.currency}
              </p>
            ) : null}
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            {(['baseline', 'scenario'] as const).map((side) => (
              <fieldset key={side} className="min-w-0 space-y-4">
                <legend className="mb-3 font-semibold text-text-strong">
                  {side === 'baseline' ? 'Baseline assumptions' : 'Scenario assumptions'}
                </legend>
                <div className="grid gap-4 sm:grid-cols-2">
                  {fields.map(([field, label]) => {
                    const key = `${side}.${field}`;
                    const error = errors[key];
                    return (
                      <div key={field} className="min-w-0 space-y-1.5">
                        <label htmlFor={`${id}-${key}`} className="text-sm font-medium">
                          {label}
                        </label>
                        <Input
                          id={`${id}-${key}`}
                          className="h-11"
                          type="text"
                          inputMode={field === 'quantity' ? 'numeric' : 'decimal'}
                          maxLength={field === 'quantity' ? 7 : 13}
                          value={(side === 'baseline' ? baseline : scenario)[field]}
                          aria-invalid={Boolean(error)}
                          aria-describedby={error ? `${id}-${key}-error` : `${id}-limits`}
                          onChange={(event) => {
                            const update = side === 'baseline' ? setBaseline : setScenario;
                            update((current) => ({ ...current, [field]: event.target.value }));
                            edited();
                          }}
                        />
                        {error ? (
                          <p id={`${id}-${key}-error`} className="text-sm text-destructive">
                            {error}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
          <p id={`${id}-limits`} className="text-sm text-text-muted">
            Amounts: 0–9,999,999,999.99, up to 2 decimals. Quantity: 0–1,000,000 whole units.
            Discount is a major amount per unit, not a percentage, and cannot exceed price.
            Incremental cost is the one-time cost for this period. Assumed quantity does not predict
            demand.
          </p>
          {attempted && !result.ok ? (
            <p role="alert" className="text-sm text-destructive">
              {errors.period || 'Complete or correct the marked assumptions to calculate.'}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" className="min-h-11">
              Calculate contribution
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={!evidence}
              onClick={exportEvidence}
            >
              Export assumptions JSON
            </Button>
          </div>
        </form>
        {exportError ? (
          <p role="alert" className="text-sm text-destructive">
            Export unavailable. Your calculation is preserved; try exporting again.
          </p>
        ) : null}
        <div
          role="status"
          aria-live="polite"
          aria-label="Contribution result"
          className="space-y-4 border-t border-border-subtle pt-5"
        >
          {evidence ? (
            <>
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ['Baseline contribution', evidence.baseline.contribution],
                  ['Scenario contribution', evidence.scenario.contribution],
                  ['Contribution change', evidence.change.contribution],
                  ['Baseline revenue', evidence.baseline.revenue],
                  ['Scenario revenue', evidence.scenario.revenue],
                  ['Scenario contribution per unit', evidence.scenario.unitContribution],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <dt className="text-sm text-text-muted">{label}</dt>
                    <dd className="break-words font-mono text-lg font-semibold tabular-nums text-text-strong">
                      {evidence.currency} {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-sm text-text-body">
                Break-even volume (cover entered incremental cost):{' '}
                {evidence.breakEven.quantity === null
                  ? 'Unreachable'
                  : `${evidence.breakEven.quantity} units`}
                . {evidence.breakEven.reason}
              </p>
              <p className="text-sm text-text-body">
                Volume to match baseline contribution:{' '}
                {evidence.matchBaseline.quantity === null
                  ? 'Unreachable'
                  : `${evidence.matchBaseline.quantity} units`}
                . {evidence.matchBaseline.reason}
              </p>
              <p className="text-sm text-text-muted">
                Source: {evidence.source} Coverage: {evidence.coverage} Freshness:{' '}
                {evidence.freshness}
              </p>
            </>
          ) : (
            <p className="text-sm text-text-muted">
              Enter both cases and calculate. Editing assumptions clears the previous result and
              export.
            </p>
          )}
        </div>
        <p className="text-sm text-text-body">Contribution = {CONTRIBUTION_DEFINITION}.</p>
        <p className="max-w-3xl text-sm text-text-muted">{CONTRIBUTION_CONDITIONS}</p>
      </div>
    </SectionCard>
  );
}
