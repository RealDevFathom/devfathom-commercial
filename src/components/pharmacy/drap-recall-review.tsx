'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import type { drapRecallReviewQueue } from '@/lib/pharmacy/drap-monitoring';
import { trpc } from '@/lib/trpc';
import { batchPhrase } from '@/lib/pharmacy/unrecorded-batch';

type QueueData = Awaited<ReturnType<typeof drapRecallReviewQueue>>;
type QueueItem = QueueData['pending'][number];

const MATCH_LABEL = {
  MATCHED: { label: 'Matched to stock', tone: 'warning' },
  AMBIGUOUS: { label: 'Ambiguous match', tone: 'danger' },
  NO_MATCH: { label: 'No catalog match', tone: 'neutral' },
} as const;

const day = (value: Date | string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
};

function medicineLabel(medicine: { productName: string; brandName: string | null }) {
  return medicine.brandName
    ? `${medicine.brandName} (${medicine.productName})`
    : medicine.productName;
}

function AlertEvidence({ item }: { item: QueueItem }) {
  const { alert } = item;
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      <div>
        <dt className="font-mono text-xs uppercase text-text-muted">Product in alert</dt>
        <dd>{alert.productName ?? '—'}</dd>
      </div>
      <div>
        <dt className="font-mono text-xs uppercase text-text-muted">DRAP registration no.</dt>
        <dd className="tabular-nums">{alert.registrationNumber || 'Not named in the alert'}</dd>
      </div>
      <div>
        <dt className="font-mono text-xs uppercase text-text-muted">Batch numbers</dt>
        <dd className="tabular-nums">
          {alert.batchNumbers.length
            ? alert.batchNumbers.join(', ')
            : alert.batchNumbersUnresolved
              ? 'Named in the DRAP document but not read; check it'
              : 'None named'}
        </dd>
      </div>
      <div>
        <dt className="font-mono text-xs uppercase text-text-muted">Alert / published</dt>
        <dd>
          {alert.alertNumber ?? item.sourceReference} · {day(alert.publishedAt)}
        </dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="font-mono text-xs uppercase text-text-muted">Reason</dt>
        <dd>{alert.reason || '—'}</dd>
      </div>
      {alert.sourceUrl || alert.documentUrl ? (
        <div className="flex flex-wrap gap-4 sm:col-span-2">
          {alert.sourceUrl ? (
            <a
              className="underline underline-offset-4"
              href={alert.sourceUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              Open DRAP alert page
            </a>
          ) : null}
          {alert.documentUrl ? (
            <a
              className="underline underline-offset-4"
              href={alert.documentUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              Open DRAP PDF
            </a>
          ) : null}
        </div>
      ) : null}
    </dl>
  );
}

function MatchSummary({ item }: { item: QueueItem }) {
  if (item.matchStatus === 'MATCHED' && item.medicine) {
    const units = item.batches.reduce((sum, batch) => sum + batch.availableUnits, 0);
    return (
      <div className="rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-3 text-sm">
        <p>
          <span className="font-medium">{medicineLabel(item.medicine)}</span> ·{' '}
          {item.recallScope === 'BATCH'
            ? 'one batch'
            : `every batch of this medicine (${item.batches.length})`}
        </p>
        <ul className="mt-2 space-y-1">
          {item.batches.map((batch) => (
            <li key={batch.id} className="flex justify-between gap-4 tabular-nums">
              <span>{batchPhrase(batch.batchNumber)}</span>
              <span>{batch.availableUnits} units available</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-text-muted">
          Confirming opens a recall and moves {units} available units to quarantine.
          {item.alert.batchNumbers.length
            ? ''
            : ' The alert names no batch, so every batch of this medicine is included.'}
        </p>
      </div>
    );
  }
  if (item.matchStatus === 'AMBIGUOUS')
    return (
      <p className="text-sm text-text-muted">
        {item.alert.batchNumbersUnresolved
          ? 'The batch numbers could not be read from the DRAP document, so this alert cannot be confirmed as a recall of every batch.'
          : item.candidateMedicines.length > 1
            ? `${item.candidateMedicines.length} catalog medicines share this registration number (${item.candidateMedicines.map(medicineLabel).join(', ')}).`
            : 'Some named batches are not in stock records, or the batches cover only part of this medicine.'}{' '}
        Fix the catalog or issue a manual recall from Inventory, then dismiss this alert.
      </p>
    );
  return (
    <p className="text-sm text-text-muted">
      No catalog medicine carries this DRAP registration number. If you stock this product, add its
      registration number and issue a manual recall from Inventory; otherwise dismiss the alert.
    </p>
  );
}

function PendingAlert({
  item,
  pending,
  onConfirm,
  onDismiss,
}: {
  item: QueueItem;
  pending?: boolean;
  onConfirm: (ingestId: string, note?: string) => Promise<unknown>;
  onDismiss: (ingestId: string, reason: string) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<'idle' | 'confirm' | 'dismiss'>('idle');
  const [text, setText] = useState('');
  const match = MATCH_LABEL[item.matchStatus];
  const inputId = `drap-${item.id}-${mode}`;
  return (
    <li className="space-y-4 py-5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{item.alert.productName ?? item.sourceReference}</h3>
        <StatusPill status={item.matchStatus} tone={match.tone} label={match.label} />
      </div>
      <AlertEvidence item={item} />
      <MatchSummary item={item} />
      {mode === 'idle' ? (
        <div className="flex flex-wrap gap-2">
          {item.matchStatus === 'MATCHED' ? (
            <Button size="touch" variant="destructive" onClick={() => setMode('confirm')}>
              Review recall and quarantine
            </Button>
          ) : null}
          <Button size="touch" variant="outline" onClick={() => setMode('dismiss')}>
            Dismiss alert
          </Button>
        </div>
      ) : (
        <form
          className="space-y-3 rounded-[var(--radius-sm)] border border-border-default p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              if (mode === 'confirm') await onConfirm(item.id, text.trim() || undefined);
              else await onDismiss(item.id, text.trim());
              setMode('idle');
              setText('');
            } catch {
              // The error is shown above the queue; keep the form open to retry.
            }
          }}
        >
          <p className="text-sm">
            {mode === 'confirm'
              ? 'This opens the recall, marks the batches recalled and quarantines their available stock. A safety-authorized reversal can undo the quarantine.'
              : 'Dismissing leaves stock untouched. Record why so the decision is auditable.'}
          </p>
          <label className="block text-sm" htmlFor={inputId}>
            {mode === 'confirm' ? 'Note (optional)' : 'Reason for dismissing'}
          </label>
          <Input
            id={inputId}
            maxLength={500}
            required={mode === 'dismiss'}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="touch"
              type="submit"
              variant={mode === 'confirm' ? 'destructive' : 'default'}
              disabled={pending || (mode === 'dismiss' && !text.trim())}
            >
              {mode === 'confirm' ? 'Confirm recall and quarantine' : 'Dismiss alert'}
            </Button>
            <Button
              size="touch"
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setMode('idle');
                setText('');
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

export function DrapRecallReviewView({
  data,
  loading,
  error,
  forbidden,
  pending,
  mutationError,
  onRetry,
  onConfirm,
  onDismiss,
}: {
  data?: QueueData;
  loading?: boolean;
  error?: boolean;
  forbidden?: boolean;
  pending?: boolean;
  mutationError?: string;
  onRetry: () => void;
  onConfirm: (ingestId: string, note?: string) => Promise<unknown>;
  onDismiss: (ingestId: string, reason: string) => Promise<unknown>;
}) {
  if (forbidden)
    return (
      <SectionCard title="Recall review permission required" titleLevel={2}>
        <p role="alert">Ask your administrator for pharmacy safety access.</p>
      </SectionCard>
    );
  if (loading)
    return (
      <SectionCard title="Loading DRAP recall alerts" titleLevel={2}>
        <p role="status">Loading alerts and matching stock…</p>
      </SectionCard>
    );
  if (error || !data)
    return (
      <SectionCard title="DRAP recall alerts unavailable" titleLevel={2}>
        <p role="alert">Could not load the review queue. No stock has been changed.</p>
        <Button className="mt-3" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </SectionCard>
    );
  return (
    <div className="min-w-0 space-y-6">
      <SectionCard title="Alerts waiting for review" titleLevel={2}>
        <p className="mb-4 text-sm text-text-muted">
          Each alert is parsed from DRAP&apos;s recall pages and matched by registration and batch
          number. Nothing is recalled or quarantined until you confirm it here.
        </p>
        {mutationError ? (
          <p className="mb-4 text-sm text-destructive" role="alert">
            {mutationError}
          </p>
        ) : null}
        {data.pending.length ? (
          <ul className="divide-y divide-border-subtle">
            {data.pending.map((item) => (
              <PendingAlert
                key={item.id}
                item={item}
                pending={pending}
                onConfirm={onConfirm}
                onDismiss={onDismiss}
              />
            ))}
          </ul>
        ) : (
          <p>No DRAP recall alerts are waiting. New alerts appear here after the daily check.</p>
        )}
      </SectionCard>
      <SectionCard title="Recent decisions" titleLevel={2}>
        {data.decided.length ? (
          <div
            tabIndex={0}
            role="region"
            aria-label="Recent DRAP recall decisions"
            className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <table className="w-full text-sm">
              <caption className="sr-only">Recent DRAP recall decisions</caption>
              <thead className="border-b border-border-default text-left font-mono text-xs uppercase">
                <tr>
                  {['Alert', 'Product', 'Decision', 'Decided', 'Note'].map((h) => (
                    <th key={h} scope="col" className="p-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.decided.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-border-subtle hover:bg-surface-sunken"
                  >
                    <td className="p-3">{item.alert.alertNumber ?? item.sourceReference}</td>
                    <td className="p-3">{item.alert.productName ?? '—'}</td>
                    <td className="p-3">
                      <StatusPill
                        status={item.reviewStatus === 'CONFIRMED' ? 'active' : 'neutral'}
                        tone={item.reviewStatus === 'CONFIRMED' ? 'warning' : 'neutral'}
                        label={item.reviewStatus === 'CONFIRMED' ? 'Recall confirmed' : 'Dismissed'}
                      />
                    </td>
                    <td className="whitespace-nowrap p-3">{day(item.reviewedAt)}</td>
                    <td className="p-3">{item.reviewNote ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>No recall alerts have been confirmed or dismissed yet.</p>
        )}
      </SectionCard>
    </div>
  );
}

export function DrapRecallReview() {
  const query = trpc.pharmacyInventory.drapRecallQueue.useQuery(undefined, { retry: false });
  const confirm = trpc.pharmacyInventory.confirmDrapRecall.useMutation();
  const dismiss = trpc.pharmacyInventory.dismissDrapRecall.useMutation();
  const code = query.error?.data?.code;
  return (
    <DrapRecallReviewView
      data={query.data}
      loading={query.isLoading}
      error={query.isError}
      forbidden={code === 'FORBIDDEN' || code === 'UNAUTHORIZED'}
      pending={confirm.isPending || dismiss.isPending}
      mutationError={confirm.error?.message ?? dismiss.error?.message}
      onRetry={() => void query.refetch()}
      onConfirm={async (ingestId, note) => {
        await confirm.mutateAsync({ ingestId, ...(note ? { note } : {}) });
        await query.refetch();
      }}
      onDismiss={async (ingestId, reason) => {
        await dismiss.mutateAsync({ ingestId, reason });
        await query.refetch();
      }}
    />
  );
}
