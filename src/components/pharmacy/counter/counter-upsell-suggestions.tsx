'use client';

import { useId } from 'react';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { UpsellSuggestion } from '@/lib/pharmacy/upsell-suggestions';
import { trpc } from '@/lib/trpc';

/** #730: presentational list; nothing here mutates the bill. */
export function CounterUpsellList({
  suggestions,
  state,
  error,
  disabled,
  disabledReason,
  disabledReasonId,
  onChoose,
  onRetry,
}: {
  suggestions: readonly UpsellSuggestion[];
  state: 'loading' | 'ready' | 'error';
  error?: string | null;
  disabled: boolean;
  disabledReason?: string | null;
  /** A visible explanation owned by the parent; standalone uses its own text. */
  disabledReasonId?: string;
  onChoose: (suggestion: UpsellSuggestion) => void;
  onRetry: () => void;
}) {
  const localReasonId = useId();
  const reasonId = disabledReasonId ?? localReasonId;
  const reason = disabled
    ? (disabledReason ?? 'Wait for the current counter action to finish.')
    : null;
  if (state === 'loading') {
    return (
      <p className="text-sm text-text-muted" role="status">
        Checking complementary items in stock…
      </p>
    );
  }
  if (state === 'error') {
    return (
      <div className="space-y-3" role="alert">
        <p className="text-sm text-destructive">{error ?? 'Suggestions are unavailable.'}</p>
        <Button type="button" variant="outline" className="h-11" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (suggestions.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        No complementary over-the-counter item is in stock for this bill.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {reason && !disabledReasonId ? (
        <p id={reasonId} className="text-sm text-text-muted">
          {reason}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status="suggestion" tone="info" label="Suggestion only" />
        <p className="text-xs text-text-muted">
          Over-the-counter and front-shop items only. Offer only if the customer wants it.
        </p>
      </div>
      <ul
        className="divide-y divide-border-subtle rounded-md border border-border-subtle"
        aria-label="Complementary item suggestions"
      >
        {suggestions.map((suggestion) => (
          <li
            key={suggestion.medicineId}
            className="flex flex-wrap items-center justify-between gap-3 p-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-strong">
                {suggestion.displayName}{' '}
                <span className="font-normal text-text-body">{suggestion.presentation}</span>
              </p>
              <p className="text-xs text-text-muted">{suggestion.reason}</p>
              <p className="mt-1 font-mono text-xs tabular-nums text-text-body">
                MRP {formatMinor(suggestion.packMrpMinor)} / pack
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={disabled}
              aria-describedby={reason ? reasonId : undefined}
              onClick={() => onChoose(suggestion)}
            >
              Find item
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * #730: complementary-item suggestions for the medicines already on the bill.
 * Hidden until the bill has a line; choosing one only searches for it.
 */
export function CounterUpsellSuggestions({
  branchId,
  medicineIds,
  disabled,
  disabledReason,
  disabledReasonId,
  onChoose,
}: {
  branchId: string;
  medicineIds: readonly string[];
  disabled: boolean;
  disabledReason?: string | null;
  /** A visible explanation owned by the parent; standalone uses its own text. */
  disabledReasonId?: string;
  onChoose: (suggestion: UpsellSuggestion) => void;
}) {
  const ids = [...new Set(medicineIds)].sort().slice(0, 50);
  const enabled = Boolean(branchId) && ids.length > 0;
  const query = trpc.pharmacySales.upsellSuggestions.useQuery(
    { branchId, medicineIds: enabled ? ids : ['none'] },
    { enabled, staleTime: 60_000 }
  );
  if (!enabled) return null;
  if (query.isSuccess && query.data.length === 0) return null;
  return (
    <SectionCard compact eyebrow="Counter · Upsell" title="Complementary items">
      <CounterUpsellList
        suggestions={query.data ?? []}
        state={query.isLoading ? 'loading' : query.isError ? 'error' : 'ready'}
        error={query.error ? counterErrorMessage(query.error) : null}
        disabled={disabled}
        disabledReason={disabledReason}
        disabledReasonId={disabledReasonId}
        onChoose={onChoose}
        onRetry={() => void query.refetch()}
      />
    </SectionCard>
  );
}
