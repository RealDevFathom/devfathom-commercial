'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { useCounterError } from '@/i18n/use-counter-error';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { UpsellSuggestion } from '@/lib/pharmacy/upsell-suggestions';
import { trpc } from '@/lib/trpc';

/** #730: presentational list; nothing here mutates the bill. */
export function CounterUpsellList({
  suggestions,
  state,
  error,
  disabled,
  onChoose,
  onRetry,
}: {
  suggestions: readonly UpsellSuggestion[];
  state: 'loading' | 'ready' | 'error';
  error?: string | null;
  disabled: boolean;
  onChoose: (suggestion: UpsellSuggestion) => void;
  onRetry: () => void;
}) {
  const ct = useTranslations('CounterText');
  if (state === 'loading') {
    return (
      <p className="text-sm text-text-muted" role="status">
        {ct('checkingComplementaryItemsInStock')}
      </p>
    );
  }
  if (state === 'error') {
    return (
      <div className="space-y-3" role="alert">
        <p className="text-sm text-destructive">{error ?? ct('suggestionsAreUnavailable')}</p>
        <Button type="button" variant="outline" className="h-11" onClick={onRetry}>
          {ct('retry')}
        </Button>
      </div>
    );
  }
  if (suggestions.length === 0) {
    return (
      <p className="text-sm text-text-muted">{ct('noComplementaryOverTheCounterItemIsInStock')}</p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status="suggestion" tone="info" label={ct('suggestionOnly')} />
        <p className="text-xs text-text-muted">{ct('overTheCounterAndFrontShopItemsOnlyOffer')}</p>
      </div>
      <ul
        className="divide-y divide-border-subtle rounded-md border border-border-subtle"
        aria-label={ct('complementaryItemSuggestions')}
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
                MRP {formatMinor(suggestion.packMrpMinor)} {ct('pack')}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={disabled}
              onClick={() => onChoose(suggestion)}
            >
              {ct('findItem')}
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
  onChoose,
}: {
  branchId: string;
  medicineIds: readonly string[];
  disabled: boolean;
  onChoose: (suggestion: UpsellSuggestion) => void;
}) {
  const ct = useTranslations('CounterText');
  const counterErrorMessage = useCounterError();
  const ids = [...new Set(medicineIds)].sort().slice(0, 50);
  const enabled = Boolean(branchId) && ids.length > 0;
  const query = trpc.pharmacySales.upsellSuggestions.useQuery(
    { branchId, medicineIds: enabled ? ids : ['none'] },
    { enabled, staleTime: 60_000 }
  );
  if (!enabled) return null;
  if (query.isSuccess && query.data.length === 0) return null;
  return (
    <SectionCard compact eyebrow={ct('counterUpsell')} title={ct('complementaryItems')}>
      <CounterUpsellList
        suggestions={query.data ?? []}
        state={query.isLoading ? 'loading' : query.isError ? 'error' : 'ready'}
        error={query.error ? counterErrorMessage(query.error) : null}
        disabled={disabled}
        onChoose={onChoose}
        onRetry={() => void query.refetch()}
      />
    </SectionCard>
  );
}
