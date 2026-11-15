'use client';

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { SubstituteProposal } from '@/lib/pharmacy/substitute-finder';

export function CounterSubstituteProposals({
  proposals,
  state,
  prescriptionOnly,
  canOpenSubstitution,
  error,
  disabled,
  onChoose,
  onDecline,
  onRetry,
}: {
  proposals: readonly SubstituteProposal[];
  state: 'loading' | 'ready' | 'error';
  prescriptionOnly: boolean;
  /** DEV-35: the member may open the substitution workspace (dispense or safety). */
  canOpenSubstitution: boolean;
  error?: string | null;
  disabled: boolean;
  onChoose: (proposal: SubstituteProposal) => void;
  onDecline: () => void;
  onRetry: () => void;
}) {
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
        No cheaper exact equivalent is safely available in this branch.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status="suggestion" tone="info" label="Suggestion only" />
        <p className="text-xs text-text-muted">
          Not clinical advice. Nothing is substituted until a pharmacist acts.
        </p>
      </div>
      <ul
        className="divide-y divide-border-subtle rounded-md border border-border-subtle"
        aria-label="Substitute suggestions"
      >
        {proposals.map((proposal) => (
          <li
            key={proposal.inventoryLotId}
            className="flex flex-wrap items-center justify-between gap-3 p-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-strong">
                {proposal.displayName}{' '}
                <span className="font-normal text-text-body">{proposal.strength}</span>
              </p>
              <p className="text-xs text-text-muted">
                {proposal.dosageForm} · {proposal.route} · {proposal.equivalenceBasis}
              </p>
              <p className="mt-1 font-mono text-xs tabular-nums text-text-body">
                {formatMinor(proposal.priceMinor)} · save{' '}
                {formatMinor(proposal.priceDifferenceMinor)}
              </p>
            </div>
            {prescriptionOnly && !canOpenSubstitution ? (
              <p className="text-sm text-text-muted">Ask a pharmacist to review</p>
            ) : prescriptionOnly ? (
              <Link
                href="/pharmacy/substitution"
                className="inline-flex h-11 items-center rounded-md border border-border-subtle bg-surface-card px-4 text-sm font-semibold text-text-strong focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Pharmacist review
              </Link>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={disabled}
                onClick={() => onChoose(proposal)}
              >
                Review option
              </Button>
            )}
          </li>
        ))}
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
