'use client';

import { useRef, useState, type FormEvent } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Field, WorkspaceState, fieldClass } from '@/components/pharmacy/dispensing/field';

function date(value: Date | string) {
  return new Date(value).toLocaleDateString(undefined, { timeZone: 'UTC' });
}

// The candidate queue's review/skip affordance is intentionally reused without
// its AI/provider calls. The RX-07 calculator and CRM-W03 mock scheduler own the
// clinical dates and delivery respectively; this page only records decisions.
export function RefillReviewQueue() {
  const [branchId, setBranchId] = useState('');
  const [fillId, setFillId] = useState('');
  const [directionsUrdu, setDirectionsUrdu] = useState('');
  const [notice, setNotice] = useState('');
  const captureKey = useRef<{ value: string; key: string } | null>(null);
  const workspace = trpc.pharmacyPrescriptions.workspace.useQuery({
    ...(branchId ? { branchId } : {}),
  });
  const selectedBranch = branchId || workspace.data?.branches[0]?.id || '';
  const queue = trpc.pharmacyPrescriptions.refillReminderReviews.useQuery(
    { branchId: selectedBranch },
    { enabled: Boolean(selectedBranch) }
  );
  const capture = trpc.pharmacyPrescriptions.captureRefillReminderForReview.useMutation({
    onSuccess: () => {
      setNotice('Captured for review. Approval is required before mock scheduling.');
      void queue.refetch();
    },
  });
  const review = trpc.pharmacyPrescriptions.reviewRefillReminder.useMutation({
    onSuccess: (value) => {
      setNotice(
        value.status === 'APPROVED'
          ? 'Approved for the existing due-reminder mock scheduler. Consent and STOP are checked again at dispatch.'
          : 'Skipped. This reminder will not be scheduled.'
      );
      void queue.refetch();
    },
  });
  const pending = capture.isPending || review.isPending;
  const error = workspace.error || queue.error || capture.error || review.error;
  const fills = (workspace.data?.prescriptions ?? []).flatMap((prescription) =>
    prescription.lines.flatMap((line) =>
      line.fills.map((fill) => ({
        id: fill.id,
        label: `${prescription.patient.displayName} · ${line.medicine.productName} · ${fill.quantityCanonicalUnits} units · ${date(fill.dispensedAt)}`,
      }))
    )
  );

  function changeBranch(value: string) {
    setBranchId(value);
    setFillId('');
    setDirectionsUrdu('');
    setNotice('');
    captureKey.current = null;
    capture.reset();
    review.reset();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedBranch || !fillId || !directionsUrdu.trim() || pending) return;
    const value = JSON.stringify([selectedBranch, fillId, directionsUrdu.trim()]);
    if (captureKey.current?.value !== value)
      captureKey.current = { value, key: `refill-review:${crypto.randomUUID()}` };
    setNotice('');
    capture.mutate({
      branchId: selectedBranch,
      fillId,
      directionsUrdu: directionsUrdu.trim(),
      idempotencyKey: captureKey.current.key,
    });
  }

  return (
    <div className="space-y-6">
      <SectionCard title="Capture for review">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Branch">
            <select
              id="refill-branch"
              className={fieldClass}
              value={selectedBranch}
              onChange={(event) => changeBranch(event.target.value)}
              disabled={pending}
            >
              {(workspace.data?.branches ?? []).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Dispensed prescription fill">
            <select
              id="refill-fill"
              className={fieldClass}
              value={fillId}
              onChange={(event) => setFillId(event.target.value)}
              disabled={pending || workspace.isFetching}
              required
            >
              <option value="">Choose a fill</option>
              {fills.map((fill) => (
                <option key={fill.id} value={fill.id}>
                  {fill.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Urdu directions">
            <textarea
              id="refill-urdu"
              className={fieldClass}
              value={directionsUrdu}
              onChange={(event) => setDirectionsUrdu(event.target.value)}
              disabled={pending}
              required
              maxLength={500}
              dir="rtl"
            />
          </Field>
          <p className="text-sm text-text-muted">
            Uses the existing deterministic refill calculation and current WhatsApp reminder
            consent. Enrolls the tenant fill in the selected branch, with branch-specific pharmacist
            approval for Rx medicines. An existing legacy capture is not re-enrolled or overwritten.
          </p>
          <Button type="submit" disabled={pending || !fillId || !directionsUrdu.trim()}>
            Capture for review
          </Button>
        </form>
      </SectionCard>
      {notice ? (
        <p role="status" className="text-sm text-text-muted">
          {notice}
        </p>
      ) : null}
      {error ? (
        <WorkspaceState title="Reminder action unavailable" tone="danger">
          {error.message}
        </WorkspaceState>
      ) : null}
      <SectionCard title="Review queue">
        <p className="mb-4 text-sm text-text-muted">
          First 100 reminders in this branch. Drafts first, then due date. Approved rows are
          prepared only by the existing configured mock scheduler; provider delivery remains
          disabled.
        </p>
        {!selectedBranch || workspace.isLoading || queue.isLoading ? (
          <WorkspaceState title="Loading reminders">
            Choose an available branch to review its reminders.
          </WorkspaceState>
        ) : null}
        {queue.data?.length === 0 ? (
          <WorkspaceState title="No reminders for review">
            Capture a dispensed fill above. Consent is required.
          </WorkspaceState>
        ) : null}
        <div className="space-y-4">
          {(queue.data ?? []).map((row) => (
            <article
              key={row.captureId}
              className="rounded-lg border border-border-subtle bg-surface-raised p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-text-strong">{row.medicineName}</h2>
                  <p className="text-sm text-text-muted">
                    Patient {row.patientId} · Due {date(row.reminderAt)} · Exhaustion{' '}
                    {date(row.expectedExhaustionAt)}
                  </p>
                </div>
                <StatusPill status={row.status.toLowerCase()} />
              </div>
              {row.dispatchStatus ? (
                <p className="mt-2 text-sm text-text-muted">
                  Mock dispatch: {row.dispatchStatus}
                  {row.dispatchError ? ` · ${row.dispatchError}` : ''}
                </p>
              ) : null}
              {row.status === 'DRAFT' ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    disabled={pending}
                    onClick={() => {
                      setNotice('');
                      review.mutate({
                        branchId: selectedBranch,
                        captureId: row.captureId,
                        decision: 'APPROVED',
                      });
                    }}
                  >
                    Approve mock schedule
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() => {
                      setNotice('');
                      review.mutate({
                        branchId: selectedBranch,
                        captureId: row.captureId,
                        decision: 'SKIPPED',
                      });
                    }}
                  >
                    Skip
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
