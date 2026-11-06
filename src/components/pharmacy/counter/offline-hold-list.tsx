'use client';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';

export const offlineHoldMethods: Record<string, string> = {
  JAZZCASH: 'JazzCash',
  EASYPAISA: 'Easypaisa',
  RAAST: 'Raast',
  BANK_TRANSFER: 'Bank transfer',
};
export type OfflineHoldRow = {
  id: string;
  saleId: string;
  method: string;
  state: string;
  currency: string;
  amountMinor: number;
  createdAt: Date;
  canResolve: boolean;
};
export function OfflineHoldList({
  items,
  loading,
  error,
  nextCursor,
  paged,
  disabled,
  selectedId,
  onReview,
  onRefresh,
  onNext,
  onFirst,
}: {
  items: OfflineHoldRow[];
  loading: boolean;
  error: boolean;
  nextCursor: string | null;
  paged: boolean;
  disabled: boolean;
  selectedId?: string;
  onReview: (row: OfflineHoldRow) => void;
  onRefresh: () => void;
  onNext: () => void;
  onFirst: () => void;
}) {
  return (
    <SectionCard
      title="Recovered offline holds"
      actions={
        <Button
          variant="outline"
          className="min-h-11"
          disabled={loading || disabled}
          onClick={onRefresh}
        >
          Refresh holds
        </Button>
      }
    >
      <p className="mb-4 text-sm text-text-muted">
        These payments have a server bill but are not recorded as completed. Unsent holds on an
        offline counter will appear after that counter reconnects. Absence from this list does not
        prove funds did not arrive.
      </p>
      {loading ? (
        <p role="status">Checking pending payments…</p>
      ) : error ? (
        <p role="alert">
          Pending payments could not be read. Check your branch access and refresh. No payment has
          been changed.
        </p>
      ) : items.length === 0 ? (
        <p role="status">No pending offline payments are visible for this branch.</p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {items.map((row) => (
            <li
              key={row.id}
              className="flex min-w-0 flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-2">
                <p className="font-medium text-text-strong">
                  {offlineHoldMethods[row.method] ?? 'External payment'} ·{' '}
                  <span className="font-mono tabular-nums">
                    {row.currency} {formatMinor(row.amountMinor)}
                  </span>
                </p>
                <p className="break-all text-xs text-text-muted">Bill {row.saleId}</p>
                <p className="text-xs text-text-muted">
                  Recovered {new Date(row.createdAt).toLocaleString()}
                </p>
                <StatusPill
                  status="pending"
                  tone="warning"
                  label={
                    row.state === 'CONFIRMED'
                      ? 'Funds confirmed · recording pending'
                      : 'Payment not confirmed'
                  }
                />
              </div>
              <Button
                variant="outline"
                className="min-h-11 shrink-0"
                aria-pressed={selectedId === row.id}
                disabled={disabled}
                onClick={() => onReview(row)}
              >
                Review bill <span className="sr-only">{row.saleId}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {paged ? (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={loading || disabled}
            onClick={onFirst}
          >
            First page
          </Button>
        ) : null}
        {nextCursor && !error ? (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={loading || disabled}
            onClick={onNext}
          >
            Next page
          </Button>
        ) : null}
      </div>
    </SectionCard>
  );
}
