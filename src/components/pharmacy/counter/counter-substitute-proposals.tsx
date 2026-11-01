'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { SubstituteProposal } from '@/lib/pharmacy/substitute-finder';

const fieldClass =
  'h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-body focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

export function CounterSubstituteProposals({
  proposals,
  state,
  outOfStock = false,
  error,
  disabled,
  onAccept,
  onDecline,
  onRetry,
}: {
  proposals: readonly SubstituteProposal[];
  state: 'loading' | 'ready' | 'error';
  /** The staged product has no safe units, so any equivalent is useful. */
  outOfStock?: boolean;
  error?: string | null;
  disabled: boolean;
  onAccept: (
    proposal: SubstituteProposal,
    evidence: { patientCommunication: string; jurisdictionRuleRef: string }
  ) => void;
  onDecline: () => void;
  onRetry: () => void;
}) {
  const [patientCommunication, setPatientCommunication] = useState('');
  const [jurisdictionRuleRef, setJurisdictionRuleRef] = useState('');
  const evidenceReady =
    patientCommunication.trim().length > 0 && jurisdictionRuleRef.trim().length > 0;

  if (state === 'loading') {
    return (
      <p className="text-sm text-text-muted" role="status">
        Checking exact in-stock equivalents…
      </p>
    );
  }
  if (state === 'error') {
    return (
      <div className="space-y-3" role="alert">
        <p className="text-sm text-destructive">
          {error ?? 'Substitute suggestions are unavailable.'}
        </p>
        <Button type="button" variant="outline" className="h-11" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (proposals.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        {outOfStock
          ? 'Nothing in stock shares this salt, strength, form and route.'
          : 'No cheaper exact equivalent is safely available in this branch.'}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status="suggestion" tone="info" label="Suggestion only" />
        <p className="text-xs text-text-muted">
          Not clinical advice. Nothing is added to the sale from this list. A pharmacist records the
          substitution under the dispense capability.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm text-text-strong" htmlFor="substitution-communication">
          Patient communication
          <input
            id="substitution-communication"
            className={fieldClass}
            value={patientCommunication}
            onChange={(event) => setPatientCommunication(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm text-text-strong" htmlFor="substitution-rule">
          Governing rule reference
          <input
            id="substitution-rule"
            className={fieldClass}
            value={jurisdictionRuleRef}
            onChange={(event) => setJurisdictionRuleRef(event.target.value)}
          />
        </label>
      </div>
      <ul
        className="divide-y divide-border-subtle rounded-md border border-border-subtle"
        aria-label="Substitute suggestions"
      >
        {proposals.map((proposal) => {
          const costsMore = proposal.priceDifferenceMinor < 0;
          return (
            <li
              key={proposal.inventoryLotId}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text-strong">
                  {proposal.displayName}{' '}
                  <span className="font-normal text-text-body">{proposal.strength}</span>
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {proposal.controlled ? (
                    <StatusPill status="controlled" tone="danger" label="Controlled" />
                  ) : null}
                  {proposal.rx ? (
                    <StatusPill status="prescription" tone="warning" label="Prescription" />
                  ) : null}
                  {proposal.restricted ? (
                    <StatusPill status="restricted" tone="warning" label="Restricted" />
                  ) : null}
                </div>
                <p className="text-xs text-text-muted">
                  {proposal.dosageForm} · {proposal.route} · {proposal.equivalenceBasis}
                </p>
                <p className="mt-1 font-mono text-xs tabular-nums text-text-body">
                  {formatMinor(proposal.priceMinor)}
                  {proposal.priceDifferenceMinor > 0
                    ? ` · save ${formatMinor(proposal.priceDifferenceMinor)}`
                    : null}
                  {` · ${proposal.availableCanonicalUnits} units this lot can sell`}
                </p>
                {costsMore ? (
                  <p className="mt-1 text-xs text-warning" role="status">
                    This substitute costs {formatMinor(-proposal.priceDifferenceMinor)} more.
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={disabled || !evidenceReady}
                onClick={() =>
                  onAccept(proposal, {
                    patientCommunication: patientCommunication.trim(),
                    jurisdictionRuleRef: jurisdictionRuleRef.trim(),
                  })
                }
              >
                Record substitution
              </Button>
            </li>
          );
        })}
      </ul>
      <Button
        type="button"
        variant="ghost"
        className="h-11"
        disabled={disabled}
        onClick={onDecline}
      >
        Patient declined substitutes
      </Button>
    </div>
  );
}
