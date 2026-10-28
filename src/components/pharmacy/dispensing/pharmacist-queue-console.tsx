'use client';

import { useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { QueueActions, type ReviewKind } from './queue-actions';
import { WorkspaceState } from './field';

export function PharmacistQueueConsole() {
  const utils = trpc.useUtils();
  const queue = trpc.pharmacyDispensing.reviewQueue.useQuery();
  type ReviewItem = NonNullable<typeof queue.data>['items'][number];
  // Keep the selected identity when a refresh removes it; never fall through to another patient.
  const [selected, setSelected] = useState<ReviewItem | null>(null);
  const [dirtyId, setDirtyId] = useState<string | null>(null);
  const [switchTarget, setSwitchTarget] = useState<ReviewItem | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const activeButtonRef = useRef<HTMLButtonElement | null>(null);
  const switchButtonRef = useRef<HTMLButtonElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const stayRef = useRef<HTMLButtonElement | null>(null);
  const [refreshErrorId, setRefreshErrorId] = useState<string | null>(null);
  const decide = trpc.pharmacyDispensing.decideReview.useMutation();
  if (!selected && queue.data?.items[0]) setSelected(queue.data.items[0]);
  const current = queue.data?.items.find((item) => item.id === selected?.id);
  const active = current ?? selected;

  function select(item: ReviewItem, button: HTMLButtonElement) {
    if (pendingRef.current || item.id === active?.id) return;
    if (dirtyId === active?.id) {
      switchButtonRef.current = button;
      setSwitchTarget(item);
    } else setSelected(item);
  }

  async function act(reviewItemId: string, kind: ReviewKind, reason?: string, pin?: string) {
    if (pendingRef.current || !current || current.id !== reviewItemId) {
      throw new Error('This review is unavailable. Reload the queue before recording a decision.');
    }
    pendingRef.current = reviewItemId;
    setPendingId(reviewItemId);
    setRefreshErrorId(null);
    try {
      await decide.mutateAsync({ reviewItemId, kind, reason, pin });
      // A refresh failure must not turn a confirmed write into a retryable decision draft.
      try {
        await utils.pharmacyDispensing.reviewQueue.invalidate();
      } catch {
        setRefreshErrorId(reviewItemId);
      }
    } finally {
      pendingRef.current = null;
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Pharmacy · RX-03"
        heading="Pharmacist queue"
        description="Triage in request order, leave an explicit clinical decision, then sign to release."
      />
      {queue.isLoading ? (
        <WorkspaceState title="Loading review queue">
          Checking pharmacist-required lines.
        </WorkspaceState>
      ) : null}
      {queue.error ? (
        <WorkspaceState title="Review queue could not be loaded" tone="danger">
          {queue.error.message}
        </WorkspaceState>
      ) : null}
      {queue.data?.items.length === 0 ? (
        <WorkspaceState title="Queue clear">
          No medicine lines are waiting for pharmacist review.
        </WorkspaceState>
      ) : null}
      {queue.data && active ? (
        <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <SectionCard title="Waiting" titleLevel={2}>
            <div className="grid gap-2" role="list">
              {queue.data.items.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  ref={item.id === active.id ? activeButtonRef : undefined}
                  disabled={pendingId !== null}
                  onClick={(event) => select(item, event.currentTarget)}
                  className="min-h-16 rounded-sm border border-border-subtle p-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-current={item.id === active.id}
                >
                  <span className="font-mono text-xs text-text-muted">#{index + 1}</span>
                  <span className="block font-semibold text-text-strong">
                    {item.line.medicine.productName}
                  </span>
                  <span className="block text-xs text-text-muted">
                    {item.line.prescription.patient.displayName}
                  </span>
                </button>
              ))}
            </div>
          </SectionCard>
          <SectionCard
            title={active.line.medicine.productName}
            titleLevel={2}
            actions={
              <StatusPill
                status={active.decisions.some((d) => d.kind === 'SIGN') ? 'signed' : 'in review'}
              />
            }
          >
            <dl className="mb-5 grid gap-4 border-b border-border-subtle pb-5 sm:grid-cols-3">
              <div>
                <dt className="font-mono text-xs text-text-muted uppercase">Patient</dt>
                <dd className="mt-1 font-medium">{active.line.prescription.patient.displayName}</dd>
              </div>
              <div>
                <dt className="font-mono text-xs text-text-muted uppercase">Prescriber</dt>
                <dd className="mt-1">{active.line.prescription.prescriber.name}</dd>
              </div>
              <div>
                <dt className="font-mono text-xs text-text-muted uppercase">Directions</dt>
                <dd className="mt-1">{active.line.directions}</dd>
              </div>
            </dl>
            {active.decisions.length ? (
              <ol className="mb-5 space-y-2" aria-label="Decision history">
                {active.decisions.map((decision) => (
                  <li key={decision.id} className="flex items-start justify-between gap-3 text-sm">
                    <StatusPill status={decision.kind} />
                    <span className="text-right text-text-muted">
                      {decision.reason ??
                        (decision.kind === 'SIGN' ? 'Signed release' : 'Recorded')}
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
            {!current ? (
              <WorkspaceState title="Selected review is no longer in the queue">
                {pendingId === active.id
                  ? 'Waiting for the decision on this item to finish. Selection is locked.'
                  : 'This item cannot accept another decision. Select a waiting item to continue.'}
              </WorkspaceState>
            ) : null}
            <div ref={actionsRef} tabIndex={-1}>
              <QueueActions
                key={active.id}
                canApprove={
                  active.requestedByUserId !== queue.data.currentUserId ||
                  queue.data.soloOwner ||
                  Boolean(queue.data.soloOwnerReviewItemIds?.includes(active.id))
                }
                requirePin={
                  active.requestedByUserId === queue.data.currentUserId &&
                  (queue.data.soloOwner ||
                    Boolean(queue.data.soloOwnerReviewItemIds?.includes(active.id)))
                }
                pending={pendingId === active.id}
                disabled={!current}
                onDirtyChange={(dirty) =>
                  setDirtyId((id) => (dirty ? active.id : id === active.id ? null : id))
                }
                onAction={(kind, reason, pin) => act(active.id, kind, reason, pin)}
              />
            </div>
            {refreshErrorId === active.id ? (
              <p role="status" className="mt-3 text-sm text-text-muted">
                Decision recorded. The queue could not refresh; reload it before the next decision.
              </p>
            ) : null}
          </SectionCard>
        </div>
      ) : null}
      <Dialog
        open={switchTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSwitchTarget(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          initialFocus={stayRef}
          finalFocus={() =>
            switchButtonRef.current?.isConnected
              ? switchButtonRef.current
              : (activeButtonRef.current ?? actionsRef.current)
          }
        >
          <DialogHeader>
            <DialogTitle>Discard this review draft?</DialogTitle>
            <DialogDescription>
              Switching items will discard the unsent review for{' '}
              {active?.line.prescription.patient.displayName} ({active?.line.medicine.productName}),
              including its reason and counselling checks.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button ref={stayRef} variant="outline" onClick={() => setSwitchTarget(null)}>
              Stay
            </Button>
            <Button
              variant="destructive"
              disabled={
                pendingId !== null ||
                !queue.data?.items.some((item) => item.id === switchTarget?.id)
              }
              onClick={() => {
                if (pendingRef.current || !switchTarget) return;
                const target = queue.data?.items.find((item) => item.id === switchTarget.id);
                if (!target) return;
                setSelected(target);
                setDirtyId(null);
                setSwitchTarget(null);
              }}
            >
              Discard and switch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
