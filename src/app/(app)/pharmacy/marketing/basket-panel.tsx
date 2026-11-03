import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { bundleProposalWhatsAppText } from '@/lib/pharmacy/basket-analysis';
import type { listBasketInsights } from '@/lib/pharmacy/basket-workflow';
import { MarketingActionForm } from './action-form';
import { formatDisplayDateTime } from '@/lib/display-time';

export function BasketPanel({
  branchId,
  history,
  unavailable,
}: {
  branchId: string;
  history: Awaited<ReturnType<typeof listBasketInsights>> | null;
  unavailable: boolean;
}) {
  return (
    <SectionCard title="Basket bundle proposals" titleLevel={2}>
      <div className="space-y-6">
        <p className="text-sm text-text-body">
          Find OTC and front-shop pairs in completed receipts. Rx, restricted and controlled
          products are excluded. Evidence describes co-purchases; it does not establish sales
          uplift. Owner approval with your own PIN creates a generic campaign draft for further
          review.
        </p>
        {unavailable && (
          <p role="alert" className="text-sm text-text-body">
            Bundle history is unavailable. Reload before retrying a review.
          </p>
        )}
        <MarketingActionForm
          branchId={branchId}
          operation="basket-generate"
          label="Find bundle proposals"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              Basket period start (UTC)
              <Input name="from" type="date" required className="mt-1 min-h-11" />
            </label>
            <label className="text-sm">
              Basket exclusive cutoff (UTC)
              <Input name="cutoff" type="date" required className="mt-1 min-h-11" />
            </label>
            {[
              {
                name: 'minimumPairCount',
                label: 'Minimum paired receipts',
                value: 2,
                min: 1,
                step: 1,
              },
              {
                name: 'minimumSupport',
                label: 'Minimum support (fraction of all receipts)',
                value: 0.3,
                min: 0,
                max: 1,
                step: 0.01,
              },
              {
                name: 'minimumConfidence',
                label: 'Minimum confidence (stronger direction)',
                value: 0.5,
                min: 0,
                max: 1,
                step: 0.01,
              },
              { name: 'minimumLift', label: 'Minimum lift', value: 1, min: 0, step: 0.01 },
              {
                name: 'maximumProposals',
                label: 'Maximum proposals',
                value: 3,
                min: 1,
                max: 3,
                step: 1,
              },
            ].map((field) => (
              <label key={field.name} className="text-sm">
                {field.label}
                <Input
                  name={field.name}
                  type="number"
                  required
                  defaultValue={field.value}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  className="mt-1 min-h-11"
                />
              </label>
            ))}
          </div>
          <p className="text-sm text-text-muted">
            Use one to ninety completed days and at most 5000 receipts. Thresholds are adjustable;
            no AI provider is required.
          </p>
        </MarketingActionForm>
        {history && !history.insights.length && (
          <p className="text-sm">No saved bundle analyses. Choose a completed period above.</p>
        )}
        {history?.insights.map((insight) => (
          <article key={insight.id} className="space-y-4 border-t border-border-subtle pt-4">
            <p className="break-words text-sm text-text-muted">
              {insight.snapshot.from} to {insight.snapshot.cutoff} (exclusive). Saved{' '}
              {formatDisplayDateTime(insight.createdAt)}.
            </p>
            {!insight.output.recommendations.length && (
              <p className="text-sm">
                No eligible pairs met these thresholds. Adjust the period or thresholds and try
                again.
              </p>
            )}
            {insight.output.recommendations.map((proposal, index) => {
              const final = history.reviews.find(
                (review) =>
                  review.insightId === insight.id &&
                  review.recommendation === index &&
                  review.decision !== 'EDIT'
              );
              return (
                <section key={index} className="space-y-3">
                  <h3 className="break-words font-medium">{proposal.productNames.join(' + ')}</h3>
                  <StatusPill
                    status={
                      final?.decision === 'REJECT' ? 'REJECTED' : final ? 'APPROVED' : 'PENDING'
                    }
                    label={
                      final?.decision === 'REJECT'
                        ? 'Rejected'
                        : final
                          ? 'Bundle approved'
                          : 'Pending owner approval'
                    }
                  />
                  <p className="text-sm tabular-nums">
                    Paired receipts: {proposal.evidence.pairCount} / {proposal.evidence.basketCount}
                    . Support: {proposal.evidence.support.toFixed(3)}. Confidence (stronger
                    direction): {proposal.evidence.confidence.toFixed(3)}. Lift:{' '}
                    {proposal.evidence.lift.toFixed(3)}.
                  </p>
                  {final ? (
                    final.campaignId ? (
                      <Link
                        className="inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:outline-ring"
                        href={`/pharmacy/marketing?branch=${encodeURIComponent(branchId)}&campaign=${encodeURIComponent(final.campaignId)}`}
                      >
                        Open bundle campaign review
                      </Link>
                    ) : (
                      <p className="text-sm">Rejected. No campaign created.</p>
                    )
                  ) : (
                    <>
                      <p className="text-sm text-text-body">
                        Generic WhatsApp copy: {bundleProposalWhatsAppText()}
                      </p>
                      <MarketingActionForm
                        branchId={branchId}
                        operation="basket-review"
                        label="Approve bundle and create draft"
                        disabled={unavailable}
                      >
                        <input type="hidden" name="insightId" value={insight.id} />
                        <input type="hidden" name="recommendation" value={index} />
                        <input type="hidden" name="decision" value="APPROVE" />
                        <label className="block text-sm">
                          Bundle campaign schedule (UTC ISO)
                          <Input
                            name="scheduledAt"
                            required
                            placeholder="2026-11-01T12:00:00Z"
                            className="mt-1 min-h-11"
                          />
                        </label>
                        <label className="block text-sm">
                          Your owner PIN
                          <Input
                            name="pin"
                            type="password"
                            inputMode="numeric"
                            pattern="[0-9]{4,8}"
                            minLength={4}
                            maxLength={8}
                            autoComplete="off"
                            required
                            className="mt-1 min-h-11"
                          />
                        </label>
                        <label className="flex items-start gap-2 text-sm">
                          <input type="checkbox" name="reviewed" required className="mt-1 size-5" />
                          I reviewed the pair, evidence and generic copy. The campaign still
                          requires review before sending.
                        </label>
                      </MarketingActionForm>
                      <MarketingActionForm
                        branchId={branchId}
                        operation="basket-review"
                        label="Reject bundle"
                        disabled={unavailable}
                      >
                        <input type="hidden" name="insightId" value={insight.id} />
                        <input type="hidden" name="recommendation" value={index} />
                        <input type="hidden" name="decision" value="REJECT" />
                        <input type="hidden" name="reviewed" value="on" />
                      </MarketingActionForm>
                    </>
                  )}
                </section>
              );
            })}
          </article>
        ))}
      </div>
    </SectionCard>
  );
}
