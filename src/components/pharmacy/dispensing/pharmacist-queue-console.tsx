'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { QueueActions, type ReviewKind } from './queue-actions';
import { WorkspaceState } from './field';

export function PharmacistQueueConsole() {
  const utils = trpc.useUtils();
  const queue = trpc.pharmacyDispensing.reviewQueue.useQuery();
  const [activeId, setActiveId] = useState<string | null>(null);
  const decide = trpc.pharmacyDispensing.decideReview.useMutation({
    onSuccess: async () => {
      await utils.pharmacyDispensing.reviewQueue.invalidate();
    },
  });
  const active = queue.data?.items.find((item) => item.id === activeId) ?? queue.data?.items[0];
  async function act(kind: ReviewKind, reason?: string) {
    if (active) await decide.mutateAsync({ reviewItemId: active.id, kind, reason });
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
                  onClick={() => setActiveId(item.id)}
                  className="min-h-16 rounded-sm border border-border-subtle p-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
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
            <QueueActions
              canApprove={active.requestedByUserId !== queue.data.currentUserId}
              pending={decide.isPending}
              onAction={act}
            />
            {decide.error ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {decide.error.message}
              </p>
            ) : null}
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
