'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useState } from 'react';
import { browserUuid } from '@/lib/browser-uuid';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import {
  RESTAURANT_GROWTH_ACTIONS,
  GROWTH_EVIDENCE_LABELS,
  growthEvidenceLink,
  type GrowthView,
  type GrowthReviewInput,
} from '@/lib/restaurant/growth-review-contract';

const messages = {
  DENIED: 'You do not have access to review growth insights for this branch.',
  UNAVAILABLE: 'Recommendations are unavailable. Existing reports remain available.',
  INSUFFICIENT_DATA:
    'There is not enough qualifying evidence for a recommendation. Small or unknown customer cohorts are withheld.',
  INVALID: 'This saved result cannot be reviewed. Open the source reports for verified figures.',
  NOT_FOUND: 'No saved recommendation was found for this branch.',
  STALE: 'The saved evidence has changed. A new generation is required before review.',
};
export function GrowthReviewPanel({
  view,
  onReview,
  loading = false,
  children,
}: {
  children?: React.ReactNode;
  view: GrowthView;
  onReview?: (input: GrowthReviewInput) => Promise<GrowthView>;
  loading?: boolean;
}) {
  const [updated, setUpdated] = useState<GrowthView | null>(null);
  const [priorities, setPriorities] = useState<Record<number, 'NORMAL' | 'HIGH'>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirm, setConfirm] = useState<{ index: number; decision: 'APPROVE' | 'REJECT' } | null>(
    null
  );
  // Preserve exact request across unknown failures; never mint a second decision on retry.
  const [pending, setPending] = useState<GrowthReviewInput | null>(null);
  const current = updated ?? view;
  async function submit(index: number, decision: GrowthReviewInput['decision']) {
    if (current.status !== 'READY' || !onReview) return;
    const input = pending ?? {
      branchId: current.branchId,
      insightId: current.insightId,
      recommendation: index,
      expectedHash: current.hash,
      expectedVersion: current.version,
      expectedRevision: current.reviews.find((r) => r.recommendation === index)?.revision ?? 0,
      requestId: browserUuid(),
      decision,
      settings: {
        priority:
          priorities[index] ??
          current.reviews.find((r) => r.recommendation === index)?.settings.priority ??
          'NORMAL',
        objective:
          RESTAURANT_GROWTH_ACTIONS[current.projection.recommendations[index].action].objective,
      },
    };
    setPending(input);
    setBusy(true);
    setError(false);
    try {
      setUpdated(await onReview(input));
      setPending(null);
      setConfirm(null);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Restaurant"
        heading="Growth review"
        description="Review saved recommendations against their evidence before creating an internal draft."
      />
      {children}
      <SectionCard title="Recommendation review" titleLevel={2}>
        <p className="mb-4 text-sm text-text-muted">
          Observational evidence does not establish causal lift or ROI. Message cost is unknown.
          Approval creates an internal draft; publishing and delivery require separate workflows.
        </p>
        {loading ? (
          <p role="status">Loading saved recommendations…</p>
        ) : current.status !== 'READY' ? (
          <p role="status">{messages[current.status]}</p>
        ) : (
          <>
            {current.diagnostic && (
              <p className="mb-4 text-sm text-text-muted" role="note">
                Synthetic diagnostic: deterministic model double. Configured provider not verified.
              </p>
            )}
            <p className="mb-4 break-words text-sm text-text-muted">
              Current: {current.projection.current.from} — {current.projection.current.cutoff}{' '}
              (exclusive). Comparison: {current.projection.comparison.from} —{' '}
              {current.projection.comparison.cutoff} (exclusive).
            </p>
            {current.projection.recommendations.map((rec, index) => {
              const action = RESTAURANT_GROWTH_ACTIONS[rec.action];
              const saved = current.reviews.find((r) => r.recommendation === index);
              const final = saved?.decision === 'APPROVE' || saved?.decision === 'REJECT';
              return (
                <section key={index} className="space-y-3 border-t border-border-subtle py-5">
                  <h3 className="font-semibold">{action.label}</h3>
                  <StatusPill status={saved?.decision ?? 'Awaiting review'} />
                  <ul className="space-y-2 text-sm">
                    {rec.evidence.map((fact, i) => (
                      <li key={i}>
                        {GROWTH_EVIDENCE_LABELS[fact.key]}:{' '}
                        <span className="font-mono tabular-nums">{fact.value}</span> {fact.unit}{' '}
                        {fact.unit === 'INTEGER_MINOR' ? current.projection.currency : ''} ·{' '}
                        {fact.coverage} · {fact.period}
                      </li>
                    ))}
                  </ul>
                  <a
                    className="underline focus-visible:ring-2 focus-visible:ring-ring"
                    href={action.path}
                  >
                    Open source workspace
                  </a>
                  {rec.evidence.some((fact) => fact.unit === 'INTEGER_MINOR') &&
                    (['current', 'comparison'] as const).map((period) => (
                      <a
                        key={period}
                        className="ml-3 underline focus-visible:ring-2 focus-visible:ring-ring"
                        href={growthEvidenceLink(current.branchId, current.projection[period])}
                      >
                        Open {period} financial evidence
                      </a>
                    ))}
                  <p className="text-sm text-text-muted">
                    Objective: {action.objective}. Recipient selection, prices, budgets and
                    schedules are unavailable.
                  </p>
                  {saved?.draftId && (
                    <p role="status">Internal draft created. Nothing published or sent.</p>
                  )}
                  <label className="block text-sm">
                    Review priority
                    <StudioSelect
                      className="ml-3 min-h-11 rounded-sm border border-border-default bg-surface-page px-3 focus-visible:ring-2 focus-visible:ring-ring"
                      value={priorities[index] ?? saved?.settings.priority ?? 'NORMAL'}
                      disabled={busy || final || !!pending || !onReview}
                      onChange={(event) =>
                        setPriorities({
                          ...priorities,
                          [index]: event.target.value as 'NORMAL' | 'HIGH',
                        })
                      }
                    >
                      <option value="NORMAL">Normal</option>
                      <option value="HIGH">High</option>
                    </StudioSelect>
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      variant="outline"
                      disabled={busy || final || !onReview || !!pending}
                      onClick={() => void submit(index, 'EDIT')}
                    >
                      Save reviewed settings
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={busy || final || !onReview || !!pending}
                      onClick={() => setConfirm({ index, decision: 'REJECT' })}
                    >
                      Reject
                    </Button>
                    <Button
                      disabled={busy || final || !onReview || !!pending}
                      onClick={() => setConfirm({ index, decision: 'APPROVE' })}
                    >
                      Approve to draft
                    </Button>
                  </div>
                  {confirm?.index === index && (
                    <div className="space-y-3" role="group" aria-label="Confirm decision">
                      <p>
                        {confirm.decision === 'APPROVE'
                          ? 'Create this internal draft?'
                          : 'Reject this recommendation?'}{' '}
                        This decision is final.
                      </p>
                      <Button
                        disabled={busy || !!pending}
                        onClick={() => void submit(index, confirm.decision)}
                      >
                        Confirm {confirm.decision.toLowerCase()}
                      </Button>{' '}
                      <Button
                        variant="outline"
                        disabled={busy || !!pending}
                        onClick={() => setConfirm(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </section>
              );
            })}
          </>
        )}
        {error && (
          <p role="alert">Review outcome is unknown. Retry the same request to reconcile.</p>
        )}
        {error && pending && (
          <Button
            disabled={busy}
            onClick={() => void submit(pending.recommendation, pending.decision)}
          >
            Reconcile review
          </Button>
        )}
        {busy && <p role="status">Saving review…</p>}
      </SectionCard>
    </div>
  );
}
