import Link from 'next/link';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Input } from '@/components/ui/input';
import { GROWTH_METRICS, presentGrowthRecommendation } from '@/lib/ai/growth-recommendations';
import type { listGrowthInsights } from '@/lib/pharmacy/growth-insights';
import { isIanaTimezone } from '@/lib/timezone';
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
const control =
  'mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring';
const coverageLabels = {
  COMPLETE: 'Data is complete',
  PARTIAL: 'Data is incomplete',
  ESTIMATED: 'Estimated figures',
};
const moneyUnits = {
  PKR: 'paisa',
  USD: 'cents',
  GBP: 'pence',
  EUR: 'cents',
  AED: 'fils',
  SAR: 'halalas',
};
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
  timeZone?: string | null;
}) {
  const zone = timeZone && isIanaTimezone(timeZone) ? timeZone : 'Asia/Karachi';
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const dateTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const dateRange = ({ from, cutoff }: { from: string; cutoff: string }) =>
    date.formatRange(new Date(from), new Date(new Date(cutoff).getTime() - 1));
  return (
    <SectionCard title="AI growth insights" titleLevel={2}>
      <div className="space-y-6">
        <p className="text-sm text-text-body">
          Review suggestions based on receipt totals, eligible loyalty customers, recorded finances
          and estimated stock value. Small groups are hidden to protect privacy. These figures show
          what happened, but cannot prove what caused it.
        </p>
        {unavailable && (
          <p role="alert" className="text-sm text-text-body">
            Saved suggestions could not be loaded. You can still write a draft below. Reload before
            trying a review again.
          </p>
        )}
        <MarketingActionForm
          branchId={branchId}
          operation="growth-generate"
          label="Generate insights"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              Period start (UTC)
              <Input name="from" type="date" required className="mt-1 min-h-11" />
            </label>
            <label className="text-sm">
              First day after period (UTC)
              <Input name="cutoff" type="date" required className="mt-1 min-h-11" />
            </label>
          </div>
          <p className="text-sm text-text-muted">
            Choose 1–90 completed days. We compare the same number of days before this period. AI
            must be enabled and connected.
          </p>
        </MarketingActionForm>
        {history && !history.insights.length && (
          <p className="text-sm text-text-body">
            No saved suggestions. Choose a completed period to review its evidence.
          </p>
        )}
        {history?.insights.map((insight) => (
          <article key={insight.id} className="space-y-4 border-t border-border-subtle pt-4">
            <StatusPill
              status={insight.status}
              label={
                insight.status === 'READY'
                  ? 'Ready'
                  : insight.status === 'INSUFFICIENT_DATA'
                    ? 'More evidence needed'
                    : 'Suggestions unavailable'
              }
            />
            <p className="break-words text-sm text-text-muted">
              {dateRange(insight.snapshot.current)}. Saved {dateTime.format(insight.createdAt)} (
              {zone}).
            </p>
            {insight.status !== 'READY' && (
              <p className="text-sm text-text-body">
                {insight.status === 'INSUFFICIENT_DATA'
                  ? 'There is not enough evidence to suggest an action after protecting small groups. No suggestion was created.'
                  : 'AI suggestions are not available right now. You can still write a draft below.'}
              </p>
            )}
            {insight.status === 'UNAVAILABLE' &&
              ['CONFIGURATION', 'PROVIDER', 'TIMEOUT'].includes(insight.failureCode ?? '') && (
                <MarketingActionForm branchId={branchId} operation="growth-retry" label="Try again">
                  <input type="hidden" name="insightId" value={insight.id} />
                </MarketingActionForm>
              )}
            {(insight.failureCode || insight.provider || insight.model) && (
              <details className="break-words text-sm text-text-muted">
                <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring">
                  Technical details
                </summary>
                {insight.failureCode && <p>Reason: {insight.failureCode}</p>}
                {insight.provider && <p>Provider: {insight.provider}</p>}
                {insight.model && <p>Model: {insight.model}</p>}
              </details>
            )}
            <section className="space-y-3" aria-label="Saved aggregate evidence">
              <h3 className="font-medium">Saved evidence</h3>
              <p className="break-words text-sm text-text-muted">
                Comparison: {dateRange(insight.snapshot.comparison)}. Currency:{' '}
                {insight.snapshot.currency}. Facts that are missing or hidden for privacy are
                unknown, not zero.
              </p>
              {!insight.snapshot.facts.length ? (
                <p className="text-sm">
                  No evidence can be shown from this saved period. Small groups are hidden to
                  protect privacy. We cannot suggest an action without evidence. You can write a
                  draft below.
                </p>
              ) : (
                <ul className="space-y-3 text-sm">
                  {insight.snapshot.facts.map((fact) => (
                    <li key={fact.ref} className="break-words">
                      <strong>
                        {fact.ref}: {fact.value}
                      </strong>{' '}
                      {fact.metric.endsWith('_minor')
                        ? `${moneyUnits[insight.snapshot.currency]} (${insight.snapshot.currency})`
                        : 'count'}{' '}
                      · {fact.period === 'CURRENT' ? 'Selected period' : 'Comparison period'} ·{' '}
                      {GROWTH_METRICS[fact.metric]} {coverageLabels[fact.coverage]}; group size:{' '}
                      {fact.cohortSize}; updated {dateTime.format(new Date(fact.freshAt))} ({zone}).
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-sm text-text-muted">
                These figures cannot prove what caused a change. Messaging costs and extra sales
                caused by a campaign are unknown. Sandbox results are tests. They do not prove that
                Meta delivered live messages or that a campaign led to sales.
              </p>
            </section>
            {(insight.status === 'UNAVAILABLE' || insight.status === 'INVALID') && (
              <p className="text-sm text-text-body">No replacement suggestion was created.</p>
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
                            ? `${moneyUnits[insight.snapshot.currency]} (${insight.snapshot.currency})`
                            : 'count'}{' '}
                          · {f.period === 'CURRENT' ? 'Selected period' : 'Comparison period'} ·{' '}
                          {f.definition} {coverageLabels[f.coverage]}; updated{' '}
                          {dateTime.format(new Date(f.freshAt))} ({zone}).
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
                        This suggestion is for review. It does not create a campaign, select
                        recipients, or change points, stock or prices.
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
                                className="mt-1 min-h-11"
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
                            <label className="text-sm">
                              Scheduled at (UTC ISO)
                              <Input
                                name="scheduledAt"
                                placeholder="2026-10-10T12:00:00Z"
                                defaultValue={edit?.scheduledAt}
                                className="mt-1 min-h-11"
                              />
                            </label>
                          </div>
                          <p className="text-sm text-text-muted">
                            The draft requires at least one completed receipt and allows one message
                            per week, outside 22:00–08:00 quiet hours. Consent, STOP requests and
                            eligibility are checked again when preparing and sending messages.
                            Approving this draft does not approve sending.
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
