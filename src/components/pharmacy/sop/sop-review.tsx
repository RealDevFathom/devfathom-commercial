'use client';

import { useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/lib/trpc';

import { formatWhen, statusCopy, errorMessage, type SopBoardItem } from './sop-model';

export function SopReviewQueue({
  items,
  timezone,
  onOpen,
}: {
  items: SopBoardItem[];
  timezone: string | null;
  onOpen: (occurrenceId: string) => void;
}) {
  return (
    <SectionCard
      title="Waiting for your review"
      actions={
        <span className="font-mono text-xs text-text-muted tabular-nums">{items.length}</span>
      }
    >
      <p className="-mt-2 mb-4 text-sm text-text-muted">
        Check each submitted procedure. You cannot review one you worked on yourself.
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-text-muted" role="status">
          Nothing is waiting for review at this branch.
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {items.map((item) => {
            const status = statusCopy(item.status);
            return (
              <li
                key={item.occurrenceId}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="font-medium break-words text-text-strong">{item.templateName}</p>
                  <p className="mt-1 text-xs text-text-muted">
                    Sent {formatWhen(item.submittedAt ?? item.dueAt, timezone)} ·{' '}
                    {item.stepsCompleted} of {item.stepsTotal} steps done
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={item.status} tone={status.tone} label={status.label} />
                  <Button
                    id={`sop-open-${item.occurrenceId}`}
                    type="button"
                    variant="outline"
                    size="touch"
                    aria-label={`Review ${item.templateName}`}
                    onClick={() => onOpen(item.occurrenceId)}
                  >
                    Review
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

/** Verify or send back one submitted procedure. Sending back always needs a reason. */
export function SopReviewDecision({
  pharmacyBranchId,
  occurrenceId,
  onDone,
}: {
  pharmacyBranchId: string;
  occurrenceId: string;
  onDone: (message: string) => void;
}) {
  const id = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reasonMissing, setReasonMissing] = useState(false);
  const verify = trpc.pharmacySop.verify.useMutation({
    onSuccess: () => onDone('Procedure checked and closed.'),
    onError: (cause) => setError(errorMessage(cause, 'The review could not be saved. Retry.')),
  });
  const reject = trpc.pharmacySop.reject.useMutation({
    onSuccess: () => onDone('Procedure sent back with your reason.'),
    onError: (cause) => setError(errorMessage(cause, 'The review could not be saved. Retry.')),
  });
  const busy = verify.isPending || reject.isPending;

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mt-6 grid gap-3 border-t border-border-subtle pt-5"
    >
      <h3 id={`${id}-title`} className="font-semibold text-text-strong">
        Your review
      </h3>
      <div className="grid gap-1.5">
        <label className="text-sm font-medium text-text-strong" htmlFor={`${id}-reason`}>
          Reason
        </label>
        <Textarea
          ref={reasonRef}
          id={`${id}-reason`}
          className="min-h-24 bg-surface-raised"
          maxLength={2000}
          value={reason}
          disabled={busy}
          aria-invalid={reasonMissing ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            setReason(event.target.value);
            if (event.target.value.trim()) setReasonMissing(false);
          }}
        />
        <span
          id={`${id}-hint`}
          className={reasonMissing ? 'text-xs text-destructive' : 'text-xs text-text-muted'}
        >
          {reasonMissing
            ? 'Write what needs fixing before sending it back.'
            : 'Optional when checking. Required when sending back, so the person knows what to fix.'}
        </span>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="touch"
          disabled={busy}
          onClick={() => {
            setError(null);
            verify.mutate({
              pharmacyBranchId,
              occurrenceId,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            });
          }}
        >
          {verify.isPending ? 'Saving…' : 'Mark as checked'}
        </Button>
        <Button
          type="button"
          size="touch"
          variant="destructive"
          disabled={busy}
          onClick={() => {
            setError(null);
            if (!reason.trim()) {
              setReasonMissing(true);
              reasonRef.current?.focus();
              return;
            }
            reject.mutate({ pharmacyBranchId, occurrenceId, reason: reason.trim() });
          }}
        >
          {reject.isPending ? 'Sending back…' : 'Send back'}
        </Button>
      </div>
    </section>
  );
}
