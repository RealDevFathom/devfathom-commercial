import Link from 'next/link';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Input } from '@/components/ui/input';
import { GROWTH_METRICS, presentGrowthRecommendation } from '@/lib/ai/growth-recommendations';
import type { listGrowthInsights } from '@/lib/pharmacy/growth-insights';
import { MarketingActionForm } from './action-form';
import { AiNextStep, aiReady, type MarketingAiAvailability } from './ai-next-step';
import { nativeControl as control, inputControl } from './controls';
import { instantToLocalDateTime, localTime } from './period';
import { PeriodFields, SendTimeField } from './period-fields';

type History = Awaited<ReturnType<typeof listGrowthInsights>>;
const REVIEW_WORKSPACES: Partial<
  Record<
    ReturnType<typeof presentGrowthRecommendation>['kind'],
    { label: string; href: (branchId: string) => string }
  >
> = {
  LOYALTY_REVIEW: {
    label: 'Open loyalty review',
    href: (branchId) => `/pharmacy/loyalty?branchId=${encodeURIComponent(branchId)}`,
  },
  INVENTORY_COST_REVIEW: {
    label: 'Open inventory review',
    href: (branchId) => `/pharmacy/inventory?branch=${encodeURIComponent(branchId)}`,
  },
};
export function GrowthPanel({
  branchId,
  history,
  templates,
  unavailable = false,
  unavailableReason,
  timeZone,
  zone,
  period,
  sendDefault,
  ai,
}: {
  branchId: string;
  history: History | null;
  templates: Array<{ id: string; name: string }>;
  unavailable?: boolean;
  /** A denial the router explained (missing report permission, inactive owner). */
  unavailableReason?: string;
  timeZone: string;
  /** `zoneLabel(timeZone)` */
  zone: string;
  /** Default whole-day period; `lastDay` is also the latest day that has ended. */
  period: { firstDay: string; lastDay: string };
  /** Default `datetime-local` send time. */
  sendDefault: string;
  ai: MarketingAiAvailability;
}) {
  return (
    <SectionCard title="AI growth insights" titleLevel={2}>
      <div className="space-y-6">
        <p className="text-sm text-text-body">
          Get review ideas from your own totals: completed receipts, consented loyalty groups,
          posted Finance amounts and estimated stock value. Groups too small to stay anonymous are
          hidden. These are observations, not proof that a campaign will work, and message cost is
          unknown. Sandbox results never count.
        </p>
        {unavailable && (
          <p role="alert" className="text-sm text-text-body">
            {unavailableReason ??
              'Insight history is unavailable. Reload before retrying a review.'}{' '}
            Manual campaign drafting remains available below.
          </p>
        )}
        <AiNextStep id="growth-ai-next-step" availability={ai} feature="AI growth insights" />
        <MarketingActionForm
          branchId={branchId}
          operation="growth-generate"
          label="Generate AI growth insights"
          disabled={ai !== null && !aiReady(ai)}
        >
          <PeriodFields timeZone={timeZone} {...period} />
          <p className="text-sm text-text-muted">
            Whole days in {zone}, up to 90 days that have already ended. The last 30 days are filled
            in for you. Results are compared with the same number of days just before.
          </p>
        </MarketingActionForm>
        {history && !history.insights.length && (
          <p className="text-sm text-text-body">
            No saved insights. Generate a completed period to inspect available evidence.
          </p>
        )}
        {history?.insights.map((insight) => (
          <article key={insight.id} className="space-y-4 border-t border-border-subtle pt-4">
            <StatusPill
              status={insight.status}
              label={
                {
                  READY: 'Ready to review',
                  UNAVAILABLE: 'Suggestions unavailable',
                  INVALID: 'No suggestion generated',
                  INSUFFICIENT_DATA: 'More evidence needed',
                }[insight.status]
              }
            />
            <p className="break-words text-sm text-text-muted">
              {localTime(insight.snapshot.current.from, timeZone)} up to{' '}
              {localTime(insight.snapshot.current.cutoff, timeZone)} ({zone}). Saved{' '}
              {localTime(insight.createdAt, timeZone)}.
            </p>
            <section className="space-y-3" aria-label="Saved aggregate evidence">
              <h3 className="font-medium">Saved evidence</h3>
              <p className="break-words text-sm text-text-muted">
                Comparison: {localTime(insight.snapshot.comparison.from, timeZone)} up to{' '}
                {localTime(insight.snapshot.comparison.cutoff, timeZone)}. Currency:{' '}
                {insight.snapshot.currency}. Missing or suppressed facts are unknown, not zero.
              </p>
              {!insight.snapshot.facts.length ? (
                <p className="text-sm">
                  No publishable facts in this snapshot. Small cohorts are withheld; unavailable
                  evidence cannot support a recommendation. Use a manual generic draft below.
                </p>
              ) : (
                <ul className="space-y-3 text-sm">
                  {insight.snapshot.facts.map((fact) => (
                    <li key={fact.ref} className="break-words">
                      <strong>
                        {fact.ref}: {fact.value}
                      </strong>{' '}
                      {fact.metric.endsWith('_minor')
                        ? `${insight.snapshot.currency} minor units`
                        : 'count'}{' '}
                      · {fact.period.toLowerCase()} · {GROWTH_METRICS[fact.metric]} Coverage:{' '}
                      {fact.coverage.toLowerCase()}; cohort: {fact.cohortSize}; fresh at{' '}
                      {localTime(fact.freshAt, timeZone)}.
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-sm text-text-muted">
                Observational evidence only. Message cost and causal uplift are unknown. Sandbox
                outcomes never establish live Meta delivery or attributed sales.
              </p>
            </section>
            {insight.status !== 'READY' && (
              <p className="text-sm text-text-body">
                {insight.status === 'INSUFFICIENT_DATA'
                  ? 'Insufficient aggregate evidence after privacy suppression. No recommendation generated.'
                  : insight.failureCode === 'CONFIGURATION'
                    ? "AI suggestions aren't set up yet. Contact support."
                    : insight.failureCode === 'PROVIDER' || insight.failureCode === 'TIMEOUT'
                      ? 'AI suggestions are not available right now. Manual drafts remain available.'
                      : 'No suggestion could be generated from this evidence. Manual drafts remain available.'}
              </p>
            )}
            {insight.status === 'READY' &&
              insight.output?.recommendations.map((rec, index) => {
                const card = presentGrowthRecommendation(insight.snapshot, rec);
                const workspace = REVIEW_WORKSPACES[card.kind];
                const records = history.reviews.filter(
                  (r) => r.insightId === insight.id && r.recommendation === index
                );
                const final = records.find((r) => r.decision !== 'EDIT');
                const edit = records.find((r) => r.decision === 'EDIT')?.settings;
                return (
                  <section key={index} className="space-y-3">
                    <h3 className="font-medium">
                      {index + 1}. {card.hypothesis}
                    </h3>
                    <p className="text-sm">{card.action}</p>
                    <ul className="space-y-2 text-sm">
                      {card.facts.map((f) => (
                        <li key={f.ref} className="break-words">
                          <strong>
                            {f.ref}: {f.value}
                          </strong>{' '}
                          {f.metric.endsWith('_minor')
                            ? `${insight.snapshot.currency} minor units`
                            : 'count'}{' '}
                          · {f.period.toLowerCase()} · {f.definition} Coverage:{' '}
                          {f.coverage.toLowerCase()}; fresh at {localTime(f.freshAt, timeZone)}.
                        </li>
                      ))}
                    </ul>
                    <ul className="space-y-1 text-sm text-text-muted">
                      {card.limitations.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                    {workspace && (
                      <p className="text-sm">
                        <Link
                          className="underline focus-visible:outline-2 focus-visible:outline-ring"
                          href={workspace.href(branchId)}
                        >
                          {workspace.label}
                        </Link>{' '}
                        Review-only: no campaign, recipients, points, stock or price changes are
                        created from this insight.
                      </p>
                    )}
                    {final ? (
                      <p className="text-sm">
                        {final.decision === 'REJECT' ? (
                          'Rejected. No campaign created.'
                        ) : (
                          <>
                            Draft created.{' '}
                            <Link
                              className="underline focus-visible:outline-2 focus-visible:outline-ring"
                              href={`/pharmacy/marketing?branch=${encodeURIComponent(branchId)}&campaign=${encodeURIComponent(final.campaignId!)}`}
                            >
                              Open campaign review
                            </Link>
                          </>
                        )}
                      </p>
                    ) : card.kind !== 'RETAIL_REVIEW' ? (
                      <MarketingActionForm
                        branchId={branchId}
                        operation="growth-review"
                        label="Reject insight"
                      >
                        <input type="hidden" name="insightId" value={insight.id} />
                        <input type="hidden" name="recommendation" value={index} />
                        <input type="hidden" name="decision" value="REJECT" />
                        <label className="flex items-start gap-2 text-sm">
                          <input name="reviewed" type="checkbox" required className="mt-1 size-5" />
                          I reviewed the evidence and limitations.
                        </label>
                      </MarketingActionForm>
                    ) : (
                      <div className="space-y-4">
                        <MarketingActionForm
                          branchId={branchId}
                          operation="growth-review"
                          label="Save review decision"
                        >
                          <input type="hidden" name="insightId" value={insight.id} />
                          <input type="hidden" name="recommendation" value={index} />
                          <label className="block text-sm">
                            Decision
                            <select name="decision" className={control} defaultValue="EDIT">
                              <option value="EDIT">Save edits for review</option>
                              <option value="APPROVE" disabled={!templates.length}>
                                Approve insight and create draft
                              </option>
                              <option value="REJECT">Reject insight</option>
                            </select>
                          </label>
                          <div className="grid gap-4 sm:grid-cols-2">
                            <label className="text-sm">
                              Draft name
                              <Input
                                name="name"
                                defaultValue={edit?.name ?? 'Retail outreach review'}
                                maxLength={100}
                                className={inputControl}
                              />
                            </label>
                            <label className="text-sm">
                              Reviewed template
                              <select
                                name="templateId"
                                defaultValue={edit?.templateId ?? templates[0]?.id ?? ''}
                                className={control}
                              >
                                <option value="">Select a reviewed template</option>
                                {templates.map((t) => (
                                  <option value={t.id} key={t.id}>
                                    {t.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <SendTimeField
                              timeZone={timeZone}
                              zone={zone}
                              required={false}
                              defaultValue={
                                edit?.scheduledAt
                                  ? instantToLocalDateTime(new Date(edit.scheduledAt), timeZone)
                                  : sendDefault
                              }
                            />
                          </div>
                          <p className="text-sm text-text-muted">
                            Draft uses completed receipt count ≥ 1, a weekly cap of one, and quiet
                            hours 22:00–08:00. Current consent, STOP and eligibility are rechecked
                            during capture and dispatch. This decision never approves sending.
                          </p>
                          {!templates.length && (
                            <p className="text-sm">
                              Approve a generic template below before creating a draft.
                            </p>
                          )}
                          <label className="flex items-start gap-2 text-sm">
                            <input
                              name="reviewed"
                              type="checkbox"
                              required
                              className="mt-1 size-5"
                            />
                            I reviewed the evidence, limitations and draft settings.
                          </label>
                        </MarketingActionForm>
                      </div>
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
