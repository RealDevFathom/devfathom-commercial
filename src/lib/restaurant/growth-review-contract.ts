import { z } from 'zod';

const id = z.string().min(1).max(200);
export const growthReadInput = z.object({ branchId: id, insightId: id }).strict();
export const growthSettings = z
  .object({
    priority: z.enum(['NORMAL', 'HIGH']),
    objective: z.enum(['REVIEW_DEMAND', 'REVIEW_RETENTION', 'REVIEW_COST_COVERAGE']),
  })
  .strict();
export const growthReviewInput = growthReadInput
  .extend({
    recommendation: z.number().int().min(0).max(2),
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedVersion: z.literal(1),
    expectedRevision: z.number().int().min(0).max(99),
    requestId: z.uuid(),
    decision: z.enum(['EDIT', 'REJECT', 'APPROVE']),
    settings: growthSettings,
  })
  .strict();
export type GrowthReviewInput = z.infer<typeof growthReviewInput>;
export const RESTAURANT_GROWTH_ACTIONS = {
  LOYALTY_REVIEW: {
    label: 'Review loyalty eligibility',
    path: '/restaurant/loyalty',
    objective: 'REVIEW_RETENTION',
  },
  CATERING_REVIEW: {
    label: 'Review catering demand',
    path: '/restaurant/catering',
    objective: 'REVIEW_DEMAND',
  },
  INVENTORY_COST_REVIEW: {
    label: 'Review inventory cost coverage',
    path: '/restaurant/inventory',
    objective: 'REVIEW_COST_COVERAGE',
  },
} as const;
export const GROWTH_EVIDENCE_LABELS = {
  gross_sales_minor: 'Settled gross before comps and discounts; bill business date',
  settled_sales_minor: 'Settled net after comps, discounts and processing-date refunds; not profit',
  refunds_minor: 'Processing-date refunds, already deducted from settled net',
  comps_minor: 'Settled comps; bill business date',
  discounts_minor: 'Settled discounts; bill business date',
  loyalty_eligible_count: 'Qualifying loyalty cohort; recheck current consent before capture',
  catering_confirmed_count: 'Currently confirmed bookings by event date; not settled revenue',
  recipe_cost_coverage_count: 'Known recipe-cost coverage; not profit',
} as const;
export function growthEvidenceLink(branchId: string, period: { from: string; cutoff: string }) {
  const to = new Date(Date.parse(period.cutoff) - 86400000).toISOString().slice(0, 10);
  return `/restaurant/reports?${new URLSearchParams({ branch: branchId, from: period.from.slice(0, 10), to })}`;
}
export const reviewProjection = z
  .object({
    currency: z.enum(['USD', 'PKR']),
    current: z.object({ from: z.iso.datetime(), cutoff: z.iso.datetime() }).strict(),
    comparison: z.object({ from: z.iso.datetime(), cutoff: z.iso.datetime() }).strict(),
    recommendations: z
      .array(
        z
          .object({
            action: z.enum(['LOYALTY_REVIEW', 'CATERING_REVIEW', 'INVENTORY_COST_REVIEW']),
            evidence: z
              .array(
                z
                  .object({
                    key: z.enum([
                      'gross_sales_minor',
                      'settled_sales_minor',
                      'refunds_minor',
                      'comps_minor',
                      'discounts_minor',
                      'loyalty_eligible_count',
                      'catering_confirmed_count',
                      'recipe_cost_coverage_count',
                    ]),
                    period: z.enum(['CURRENT', 'COMPARISON']),
                    value: z.string().regex(/^-?\d{1,18}(?:\.\d{1,4})?$/),
                    unit: z.enum(['INTEGER_MINOR', 'COUNT']),
                    coverage: z.enum(['COMPLETE', 'PARTIAL', 'ESTIMATED']),
                  })
                  .strict()
              )
              .min(1)
              .max(30),
          })
          .strict()
      )
      .min(1)
      .max(3),
  })
  .strict();
export type ReviewProjection = z.infer<typeof reviewProjection>;
export type GrowthView =
  | { status: 'DENIED' | 'UNAVAILABLE' | 'INSUFFICIENT_DATA' | 'INVALID' | 'NOT_FOUND' | 'STALE' }
  | {
      status: 'READY';
      insightId: string;
      branchId: string;
      hash: string;
      version: 1;
      diagnostic?: boolean;
      projection: ReviewProjection;
      reviews: Array<{
        recommendation: number;
        revision: number;
        decision: 'EDIT' | 'REJECT' | 'APPROVE';
        settings: z.infer<typeof growthSettings>;
        draftId: string | null;
      }>;
    };
