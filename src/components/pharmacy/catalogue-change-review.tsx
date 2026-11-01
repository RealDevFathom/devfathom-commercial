'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';

const KIND_LABEL: Record<string, string> = {
  INGREDIENT: 'Ingredient',
  MEDICINE: 'Medicine',
  PACK_LEVEL: 'Pack',
  PACK_REVISION: 'Pack revision',
  PRINTED_MRP: 'Printed MRP',
  BARCODE: 'Barcode',
  ALIAS: 'Alias',
};

/**
 * Catalogue review queue. Catalogue edits wait here until a different user with
 * catalogue review permission approves (publishes) or rejects them. A solo
 * owner may decide their own changes.
 */
export function CatalogueChangeReview() {
  const utils = trpc.useUtils();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const changes = trpc.pharmacyMedicine.catalogueChanges.useQuery(undefined, { retry: false });
  const decide = trpc.pharmacyMedicine.decideCatalogueChange.useMutation({
    onSettled: async () => {
      setPendingId(null);
      await Promise.all([
        utils.pharmacyMedicine.catalogueChanges.invalidate(),
        utils.pharmacyMedicine.get.invalidate(),
        utils.pharmacyMedicine.search.invalidate(),
      ]);
    },
  });
  const denied = changes.error?.data?.code === 'FORBIDDEN';
  const rows = changes.data?.changes ?? [];

  return (
    <SectionCard
      eyebrow="Catalogue review"
      title="Catalogue changes awaiting review"
      titleLevel={2}
    >
      <p className="mb-4 text-sm text-text-muted">
        New ingredients, medicines, packs, printed MRPs, barcodes and aliases are published only
        after a different user with catalogue review permission approves them. A workspace with a
        single administrator may approve its own changes.
      </p>
      {changes.isPending ? (
        <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
          <Loader2 aria-hidden className="size-4 animate-spin" /> Loading catalogue changes…
        </p>
      ) : null}
      {changes.error ? (
        <div role="alert" className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
          {denied
            ? 'Your account cannot view catalogue changes. Ask your workspace administrator for catalogue edit or review permission. No data was changed.'
            : `Could not load catalogue changes: ${changes.error.message}`}
          {!denied ? (
            <Button
              type="button"
              variant="outline"
              className="ml-3 min-h-11"
              onClick={() => void changes.refetch()}
            >
              Retry loading
            </Button>
          ) : null}
        </div>
      ) : null}
      {decide.error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {decide.error.message}
        </p>
      ) : null}
      {changes.data && rows.length === 0 ? (
        <p className="rounded-md bg-surface-sunken p-5 text-sm text-text-muted">
          No catalogue changes are waiting for review.
        </p>
      ) : null}
      <ul className="space-y-3">
        {rows.map((change) => {
          const busy = pendingId === change.id;
          const ownChange = change.proposedBy === changes.data?.viewer.id;
          const reasonId = `catalogue-change-${change.id}-reason`;
          return (
            <li
              key={change.id}
              className="min-w-0 space-y-3 rounded-md border border-border-subtle p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-xs uppercase text-text-muted">
                    {KIND_LABEL[change.kind] ?? change.kind}
                  </p>
                  <p className="mt-1 break-words text-sm font-medium text-text-strong">
                    {change.summary}
                  </p>
                  <p className="mt-1 text-xs text-text-muted">
                    Proposed {ownChange ? 'by you' : `by ${change.proposedBy}`} on{' '}
                    {new Date(change.proposedAt).toLocaleString()}
                  </p>
                </div>
                <StatusPill status="Pending" label="Pending review" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  className="min-h-11"
                  disabled={!change.canDecide || decide.isPending}
                  aria-describedby={change.canDecide ? undefined : reasonId}
                  onClick={() => {
                    setPendingId(change.id);
                    decide.mutate({ changeId: change.id, decision: 'APPROVE' });
                  }}
                >
                  {busy && decide.variables?.decision === 'APPROVE'
                    ? 'Approving…'
                    : 'Approve and publish'}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="min-h-11"
                  disabled={!change.canDecide || decide.isPending}
                  aria-describedby={change.canDecide ? undefined : reasonId}
                  onClick={() => {
                    setPendingId(change.id);
                    decide.mutate({ changeId: change.id, decision: 'REJECT' });
                  }}
                >
                  {busy && decide.variables?.decision === 'REJECT' ? 'Rejecting…' : 'Reject'}
                </Button>
                {!change.canDecide ? (
                  <p id={reasonId} className="text-xs text-text-muted">
                    {ownChange
                      ? 'You proposed this change. A different user with catalogue review permission must decide it.'
                      : 'Deciding needs catalogue review permission.'}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
