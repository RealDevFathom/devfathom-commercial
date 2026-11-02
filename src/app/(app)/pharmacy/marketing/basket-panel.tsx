import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { bundleProposalWhatsAppText } from '@/lib/pharmacy/basket-analysis';
import type { listBasketInsights } from '@/lib/pharmacy/basket-workflow';
import { MarketingActionForm } from './action-form';
import { inputControl } from './controls';
import { localTime } from './period';
import { PeriodFields, SendTimeField } from './period-fields';

// Matching thresholds sit behind "Advanced" (DEV-591); these defaults are the safe starting point.
const THRESHOLDS = [
  {
    name: 'minimumPairCount',
    label: 'Fewest receipts with both products',
    help: 'A pair must appear together on at least this many receipts.',
    value: 2,
    min: 1,
    step: 1,
  },
  {
    name: 'minimumSupport',
    label: 'Share of all receipts with the pair (support)',
    help: '0.3 means the pair is on at least 3 in 10 receipts.',
    value: 0.3,
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    name: 'minimumConfidence',
    label: 'How often one product brings the other (confidence)',
    help: '0.5 means at least half the receipts with one product also have the other.',
    value: 0.5,
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    name: 'minimumLift',
    label: 'Bought together more than by chance (lift)',
    help: '1 means no more often than chance; higher is a stronger link.',
    value: 1,
    min: 0,
    step: 0.01,
  },
  {
    name: 'maximumProposals',
    label: 'Most bundles to suggest',
    help: 'Up to three per analysis.',
    value: 3,
    min: 1,
    max: 3,
    step: 1,
  },
];

export function BasketPanel({
  branchId,
  history,
  unavailable,
  unavailableReason,
  timeZone,
  zone,
  period,
  sendDefault,
}: {
  branchId: string;
  history: Awaited<ReturnType<typeof listBasketInsights>> | null;
  unavailable: boolean;
  unavailableReason?: string;
  timeZone: string;
  /** `zoneLabel(timeZone)` */
  zone: string;
  /** Default whole-day period; `lastDay` is also the latest day that has ended. */
  period: { firstDay: string; lastDay: string };
  /** Default `datetime-local` send time. */
  sendDefault: string;
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
            {unavailableReason ?? 'Bundle history is unavailable. Reload before retrying a review.'}
          </p>
        )}
        <MarketingActionForm
          branchId={branchId}
          operation="basket-generate"
          label="Find bundle proposals"
        >
          <PeriodFields timeZone={timeZone} {...period} />
          <p className="text-sm text-text-muted">
            Whole days in {zone}, up to 90 days that have already ended and at most 5000 receipts.
            The last 30 days are filled in for you. No AI provider is needed.
          </p>
          <details className="rounded-md border border-border-subtle p-4">
            <summary className="min-h-11 cursor-pointer content-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
              Advanced: how strong a pair must be
            </summary>
            <p className="mt-2 text-sm text-text-muted">
              The defaults suit most pharmacies. Raise them for fewer, stronger bundles.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {THRESHOLDS.map((field) => (
                <div key={field.name} className="text-sm">
                  <label className="block">
                    {field.label}
                    <Input
                      name={field.name}
                      type="number"
                      required
                      defaultValue={field.value}
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      aria-describedby={`basket-${field.name}-help`}
                      className={inputControl}
                    />
                  </label>
                  <p id={`basket-${field.name}-help`} className="mt-1 text-text-muted">
                    {field.help}
                  </p>
                </div>
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
              {localTime(insight.snapshot.from, timeZone)} up to{' '}
              {localTime(insight.snapshot.cutoff, timeZone)} ({zone}). Saved{' '}
              {localTime(insight.createdAt, timeZone)}.
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
                        <SendTimeField
                          timeZone={timeZone}
                          zone={zone}
                          label="Bundle campaign send date and time"
                          defaultValue={sendDefault}
                        />
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
                            className={inputControl}
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
