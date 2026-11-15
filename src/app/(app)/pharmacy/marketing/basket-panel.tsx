import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { bundleProposalWhatsAppText } from '@/lib/pharmacy/basket-analysis';
import type { listBasketInsights } from '@/lib/pharmacy/basket-workflow';
import { recentCompletedDays, timeZoneLabel } from '@/lib/pharmacy/marketing-dates';
import { workspaceTimezone } from '@/lib/timezone';
import { MarketingActionForm } from './action-form';

export function BasketPanel({
  branchId,
  history,
  unavailable,
  timeZone,
}: {
  branchId: string;
  history: Awaited<ReturnType<typeof listBasketInsights>> | null;
  unavailable: boolean;
  /** Workspace zone: periods and schedules are entered as local days and times. */
  timeZone?: string;
}) {
  const zone = workspaceTimezone(timeZone);
  const zoneLabel = timeZoneLabel(zone);
  const recent = recentCompletedDays(zone, 7);
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
          timeZone={zone}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              First day
              <Input
                name="from"
                type="date"
                required
                defaultValue={recent.firstDay}
                max={recent.lastDay}
                aria-describedby="basket-period-help"
                className="mt-1 min-h-11"
              />
            </label>
            <label className="text-sm">
              Last day
              <Input
                name="lastDay"
                type="date"
                required
                defaultValue={recent.lastDay}
                max={recent.lastDay}
                aria-describedby="basket-period-help"
                className="mt-1 min-h-11"
              />
            </label>
          </div>
          <p id="basket-period-help" className="text-sm text-text-muted">
            Pre-filled with the last 7 full days. Choose 1 to 90 full days ending yesterday or
            earlier, in {zoneLabel}, with at most 5000 receipts. No AI service is required.
          </p>
          <details className="border-t border-border-subtle pt-4">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
              Advanced matching rules (optional)
            </summary>
            <p className="mt-2 text-sm text-text-muted">
              Standard rules are already filled in. Relax them only if no pairs are found.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {[
                {
                  name: 'minimumPairCount',
                  label: 'Bought together on at least this many receipts',
                  value: 2,
                  min: 1,
                  step: 1,
                },
                {
                  name: 'minimumSupport',
                  label: 'Share of all receipts with both items (0–1)',
                  value: 0.3,
                  min: 0,
                  max: 1,
                  step: 0.01,
                },
                {
                  name: 'minimumConfidence',
                  label: 'How often buyers of one item also buy the other (0–1)',
                  value: 0.5,
                  min: 0,
                  max: 1,
                  step: 0.01,
                },
                {
                  name: 'minimumLift',
                  label: 'Bought together more often than by chance (1 = same as chance)',
                  value: 1,
                  min: 0,
                  step: 0.01,
                },
                {
                  name: 'maximumProposals',
                  label: 'Number of bundle ideas (1–3)',
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
          </details>
        </MarketingActionForm>
        {history && !history.insights.length && (
          <p className="text-sm">No saved bundle analyses. Choose a completed period above.</p>
        )}
        {history?.insights.map((insight) => (
          <article key={insight.id} className="space-y-4 border-t border-border-subtle pt-4">
            <p className="break-words text-sm text-text-muted">
              {insight.snapshot.from} to {insight.snapshot.cutoff} (exclusive). Saved{' '}
              {insight.createdAt.toISOString()}.
            </p>
            {!insight.output.recommendations.length && (
              <p className="text-sm">
                No eligible pairs met these rules. Try a longer period or relax the advanced
                matching rules.
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
                        timeZone={zone}
                      >
                        <input type="hidden" name="insightId" value={insight.id} />
                        <input type="hidden" name="recommendation" value={index} />
                        <input type="hidden" name="decision" value="APPROVE" />
                        <label className="block text-sm">
                          Bundle campaign send date and time ({zoneLabel})
                          <Input
                            name="scheduledAt"
                            type="datetime-local"
                            required
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
