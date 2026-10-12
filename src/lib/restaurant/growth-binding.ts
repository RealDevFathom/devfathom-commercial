import 'server-only';
import { validateGrowthOutput } from '@/lib/ai/growth-recommendations';
import { lockRestaurantGrowthSource, readRestaurantGrowthSource } from './growth-source';
import { parseRestaurantGrowthSnapshot, restaurantGrowthInputHash } from './growth-snapshot';
import { reviewProjection } from './growth-review-contract';
import type { GrowthActor, RestaurantGrowthBinding } from './growth-review';

// Exact supported semantic intersection with shared a6f0adda. Business-date money,
// receipt counts and inferred customer cohorts are deliberately absent.
const supported = new Set([
  'loyalty_eligible_count',
  'catering_confirmed_count',
  'recipe_cost_coverage_count',
]);
export function validateRestaurantGrowthPersisted(snapshot: unknown, output: unknown) {
  const { input } = parseRestaurantGrowthSnapshot(snapshot);
  if (
    input.vertical !== 'RESTAURANT' ||
    !input.facts.length ||
    input.facts.some((fact) => !supported.has(fact.metric) || !/^\d+$/.test(fact.value)) ||
    input.actions.some((action) => action.kind === 'RETAIL_REVIEW')
  )
    throw new Error('Unsupported Restaurant evidence');
  const result = validateGrowthOutput(output, input);
  const metricForAction = {
    LOYALTY_REVIEW: 'loyalty_eligible_count',
    CATERING_REVIEW: 'catering_confirmed_count',
    INVENTORY_COST_REVIEW: 'recipe_cost_coverage_count',
  };
  for (const rec of result.recommendations) {
    const kind = input.actions.find((action) => action.ref === rec.actionRef)!.kind;
    if (
      kind === 'RETAIL_REVIEW' ||
      rec.evidenceRefs.some(
        (ref) => input.facts.find((fact) => fact.ref === ref)!.metric !== metricForAction[kind]
      )
    )
      throw new Error('Incompatible Restaurant evidence');
  }
  return reviewProjection.parse({
    currency: input.currency,
    current: input.current,
    comparison: input.comparison,
    recommendations: result.recommendations.map((rec) => ({
      action: input.actions.find((action) => action.ref === rec.actionRef)!.kind,
      evidence: rec.evidenceRefs.map((ref) => {
        const fact = input.facts.find((item) => item.ref === ref)!;
        return {
          key: fact.metric,
          period: fact.period,
          value: fact.value,
          unit: 'COUNT',
          coverage: fact.coverage,
        };
      }),
    })),
  });
}
export function restaurantGrowthBinding(h: GrowthActor): RestaurantGrowthBinding {
  return {
    validatePersisted: validateRestaurantGrowthPersisted,
    async evidenceIsCurrent(db, scope, hash, snapshot) {
      try {
        const { input, metadata } = parseRestaurantGrowthSnapshot(snapshot);
        const saved = metadata.provenance!;
        if (
          scope.organizationId !== h.ctx.organizationId ||
          saved.scope.organizationId !== scope.organizationId ||
          saved.scope.branchId !== scope.branchId ||
          restaurantGrowthInputHash(input) !== hash
        )
          return false;
        const actor = { ...h, db };
        await lockRestaurantGrowthSource(actor, saved.request);
        const current = await readRestaurantGrowthSource(actor, saved.request);
        return (
          current.sourceHash === metadata.sourceHash &&
          restaurantGrowthInputHash(current.input) === hash
        );
      } catch {
        return false;
      }
    },
  };
}
