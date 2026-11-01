import Link from 'next/link';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { Input } from '@/components/ui/input';
import { GROWTH_METRICS, presentGrowthRecommendation } from '@/lib/ai/growth-recommendations';
import type { listGrowthInsights } from '@/lib/pharmacy/growth-insights';
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
export function GrowthPanel({
  branchId,
  history,
  templates,
  unavailable = false,
}: {
  branchId: string;
  history: History | null;
  templates: Array<{ id: string; name: string }>;
  unavailable?: boolean;
}) {
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
              Exclusive cutoff (UTC)
              <Input name="cutoff" type="date" required className="mt-1 min-h-11" />
            </label>
          </div>
          <p className="text-sm text-text-muted">
            One to ninety completed days, compared with the preceding equal period. Requires enabled
            AI settings and a configured provider.
          </p>
        </MarketingActionForm>
        {history && !history.insights.length && (
          <p className="text-sm text-text-body">
            No saved insights. Generate a completed period to inspect available evidence.
          </p>
        )}
        {history?.insights.map((insight) => (
          <article key={insight.id} className="space-y-4 border-t border-border-subtle pt-4">
            <StatusPill status={insight.status} label={insight.status.replaceAll('_', ' ')} />
            <p className="break-words text-sm text-text-muted">
              {insight.snapshot.current.from} to {insight.snapshot.current.cutoff} (exclusive).
              Saved {insight.createdAt.toISOString()}.{' '}
              {insight.provider && insight.model
                ? `${insight.provider} / ${insight.model}`
                : 'No model output.'}
            </p>
            <section className="space-y-3" aria-label="Saved aggregate evidence">
              <h3 className="font-medium">Saved evidence</h3>
              <p className="break-words text-sm text-text-muted">
                Comparison: {insight.snapshot.comparison.from} to{' '}
                {insight.snapshot.comparison.cutoff} (exclusive). Currency:{' '}
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
                      {fact.freshAt}.
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
                  : `AI insight unavailable (${insight.failureCode ?? 'OUTPUT'}). No substitute recommendation generated. Manual drafts remain available.`}
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
                          {f.coverage.toLowerCase()}; fresh at {f.freshAt}.
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
