import { SelectField as StudioSelect } from '@/components/ui/select-field';
import Link from 'next/link';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Input } from '@/components/ui/input';
import { GROWTH_METRICS, presentGrowthRecommendation } from '@/lib/ai/growth-recommendations';
import type { listGrowthInsights } from '@/lib/pharmacy/growth-insights';
import {
  localInputValue,
  recentCompletedDays,
  timeZoneLabel,
} from '@/lib/pharmacy/marketing-dates';
import { formatWorkspaceDateTime, workspaceTimezone } from '@/lib/timezone';
import { pharmacyCalendarDay } from '@/lib/pharmacy/business-day';
import { MarketingActionForm } from './action-form';

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
/** Owner-facing names for saved evidence; definitions stay server-owned in GROWTH_METRICS. */
const METRIC_LABELS: Record<keyof typeof GROWTH_METRICS, string> = {
  settled_sales_minor: 'Sales after refunds',
  posted_margin_minor: 'Profit margin',
  receipt_count: 'Receipts for known customers',
  consent_eligible_retail_count: 'Customers who agreed to messages',
  repeat_visit_count: 'Repeat visits',
  meta_delivered_count: 'Messages delivered',
  meta_attributed_sales_minor: 'Sales linked to messages',
  refunds_minor: 'Refunds',
  comps_minor: 'Free items given',
  discounts_minor: 'Discounts',
  daypart_sales_minor: 'Sales by time of day',
  family_sales_minor: 'Sales by menu group',
  recipe_cost_coverage_count: 'Receipts with known recipe cost',
  wastage_minor: 'Stock written off',
  inventory_value_minor: 'Stock value',
  loyalty_eligible_count: 'Loyalty members who can be contacted',
  catering_quote_count: 'Catering quotes',
  catering_confirmed_count: 'Confirmed catering bookings',
  catering_fulfilled_count: 'Completed catering bookings',
  catering_headcount: 'Catering guests',
  catering_capacity_count: 'Catering capacity',
  catering_estimated_margin_minor: 'Estimated catering margin',
};
const PERIOD_LABELS = { CURRENT: 'chosen days', COMPARISON: 'days before' } as const;
const COVERAGE_LABELS = {
  COMPLETE: 'complete data',
  PARTIAL: 'incomplete data',
  ESTIMATED: 'estimated',
} as const;
/** Failures that a later run can clear once AI is set up or the service recovers. */
const RETRYABLE_FAILURES = new Set(['CONFIGURATION', 'PROVIDER', 'TIMEOUT']);
type SavedInsight = NonNullable<History>['insights'][number];
type SavedFact = SavedInsight['snapshot']['facts'][number];

/** Stored values stay exact; money is shown in the currency's main unit (all are 2-decimal). */
function factValue(fact: Pick<SavedFact, 'metric' | 'value'>, currency: string) {
  const value = Number(fact.value);
  if (!Number.isFinite(value)) return fact.value;
  if (!fact.metric.endsWith('_minor')) return new Intl.NumberFormat('en-GB').format(value);
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value / 100);
}

/** An exclusive [from, cutoff) period as the inclusive local days the owner chose. */
function localDays(period: { from: string; cutoff: string }, zone: string) {
  const first = new Date(period.from);
  const last = new Date(new Date(period.cutoff).getTime() - 1);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return null;
  const label = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatRange(first, last);
  return {
    firstDay: pharmacyCalendarDay(zone, first),
    lastDay: pharmacyCalendarDay(zone, last),
    label,
  };
}

function FactLine({
  fact,
  currency,
  zone,
  definition,
  showGroup,
}: {
  fact: SavedFact;
  currency: string;
  zone: string;
  definition?: string;
  showGroup?: boolean;
}) {
  return (
    <li className="break-words">
      <strong>
        {METRIC_LABELS[fact.metric] ?? fact.metric}: {factValue(fact, currency)}
      </strong>{' '}
      · {PERIOD_LABELS[fact.period]} · {COVERAGE_LABELS[fact.coverage]}
      {showGroup ? ` · group size: ${fact.cohortSize}` : ''} · updated{' '}
      {formatWorkspaceDateTime(fact.freshAt, zone)}
      {definition && <span className="block text-text-muted">{definition}</span>}
    </li>
  );
}

const control =
  'mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';
export function GrowthPanel({
  branchId,
  history,
  templates,
  unavailable = false,
  timeZone,
}: {
  branchId: string;
  history: History | null;
  templates: Array<{ id: string; name: string }>;
  unavailable?: boolean;
  /** Workspace zone: periods and schedules are entered as local days and times. */
  timeZone?: string;
}) {
  const zone = workspaceTimezone(timeZone);
  const zoneLabel = timeZoneLabel(zone);
  const recent = recentCompletedDays(zone, 30);
  return (
    <SectionCard title="AI growth insights" titleLevel={2}>
      <div className="space-y-6">
        <p className="text-sm text-text-body">
          Review hypotheses grounded in aggregate receipt counts, consented loyalty cohorts, posted
          Finance amounts and estimated stock valuation. Small cohorts are withheld. Evidence is
          observational; message cost and causal uplift are unknown. Live Meta outcomes exclude
          sandbox.
        </p>
        {unavailable && (
          <p role="alert" className="text-sm text-text-body">
            Insight history is unavailable. Manual campaign drafting remains available below. Reload
            before retrying a review.
          </p>
        )}
        <p id="growth-ai-setup" className="text-sm text-text-body">
          AI insights need Ask Fathom turned on for your company.{' '}
          <Link
            className="underline focus-visible:outline-2 focus-visible:outline-ring"
            href="/organization"
          >
            Turn on AI in Organization settings
          </Link>
          . If insights still say AI isn&apos;t set up, contact DevFathom support to connect the AI
          service. Manual campaigns below work without AI.
        </p>
        <MarketingActionForm
          branchId={branchId}
          operation="growth-generate"
          label="Generate insights"
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
                aria-describedby="growth-period-help"
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
                aria-describedby="growth-period-help"
                className="mt-1 min-h-11"
              />
            </label>
          </div>
          <p id="growth-period-help" className="text-sm text-text-muted">
            Pre-filled with the last 30 full days. Choose 1 to 90 full days ending yesterday or
            earlier, in {zoneLabel}. Results are compared with the same number of days just before.
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
              {localDays(insight.snapshot.current, zone)?.label ?? 'Unknown days'}, {zoneLabel}.
              Saved {formatWorkspaceDateTime(insight.createdAt, zone)}.
            </p>
            <section className="space-y-3" aria-label="Saved aggregate evidence">
              <h3 className="font-medium">Saved evidence</h3>
              <p className="break-words text-sm text-text-muted">
                Comparison: {localDays(insight.snapshot.comparison, zone)?.label ?? 'unknown days'}.
                Amounts in {insight.snapshot.currency}. Figures that are missing or hidden for
                privacy are unknown, not zero.
              </p>
              {!insight.snapshot.facts.length ? (
                <p className="text-sm">
                  No publishable facts in this snapshot. Small cohorts are withheld; unavailable
                  evidence cannot support a recommendation. Use a manual generic draft below.
                </p>
              ) : (
                <ul className="space-y-3 text-sm">
                  {insight.snapshot.facts.map((fact) => (
                    <FactLine
                      key={fact.ref}
                      fact={fact}
                      currency={insight.snapshot.currency}
                      zone={zone}
                      definition={GROWTH_METRICS[fact.metric]}
                      showGroup
                    />
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
            {insight.status === 'UNAVAILABLE' &&
              RETRYABLE_FAILURES.has(insight.failureCode ?? '') &&
              (() => {
                const days = localDays(insight.snapshot.current, zone);
                if (!days) return null;
                return (
                  <MarketingActionForm
                    branchId={branchId}
                    operation="growth-generate"
                    label="Generate again for these days"
                    timeZone={zone}
                  >
                    <input type="hidden" name="from" value={days.firstDay} />
                    <input type="hidden" name="lastDay" value={days.lastDay} />
                    <p className="text-sm text-text-body">
                      This is a saved result. If AI has been set up or is working again, generate
                      fresh suggestions for {days.label}. Evidence is rebuilt from current records.
                    </p>
                  </MarketingActionForm>
                );
              })()}
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
                        <FactLine
                          key={f.ref}
                          fact={f}
                          currency={insight.snapshot.currency}
                          zone={zone}
                          definition={f.definition}
                        />
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
                          timeZone={zone}
                        >
                          <input type="hidden" name="insightId" value={insight.id} />
                          <input type="hidden" name="recommendation" value={index} />
                          <label className="block text-sm">
                            Decision
                            <StudioSelect name="decision" className={control} defaultValue="EDIT">
                              <option value="EDIT">Save edits for review</option>
                              <option value="APPROVE" disabled={!templates.length}>
                                Approve insight and create draft
                              </option>
                              <option value="REJECT">Reject insight</option>
                            </StudioSelect>
                          </label>
                          <div className="grid gap-4 sm:grid-cols-2">
                            <label className="text-sm">
                              Draft name
                              <Input
                                name="name"
                                defaultValue={edit?.name ?? 'Retail outreach review'}
                                maxLength={100}
                                className="mt-1 min-h-11"
                              />
                            </label>
                            <label className="text-sm">
                              Reviewed template
                              <StudioSelect
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
                              </StudioSelect>
                            </label>
                            <label className="text-sm">
                              Send date and time ({zoneLabel})
                              <Input
                                name="scheduledAt"
                                type="datetime-local"
                                defaultValue={localInputValue(edit?.scheduledAt, zone)}
                                className="mt-1 min-h-11"
                              />
                            </label>
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
