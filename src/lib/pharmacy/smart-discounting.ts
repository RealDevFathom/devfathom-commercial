import { z } from 'zod';

/** Configurable policy inputs. Research examples must never become runtime defaults. */
export const smartDiscountPolicySchema = z
  .object({
    minimumMarginBps: z.number().int().min(0).max(9_999),
    minimumObservations: z.number().int().min(2).max(1_000),
    targetDemandLiftBps: z.number().int().min(0).max(100_000),
  })
  .strict();

export const competitorObservationSchema = z
  .object({
    competitorPriceMinor: z.number().int().positive(),
    observedDemandUnits: z.number().int().positive(),
  })
  .strict();

export type SmartDiscountPolicy = z.infer<typeof smartDiscountPolicySchema>;
export type CompetitorObservation = z.infer<typeof competitorObservationSchema>;

export type DiscountCandidate = {
  rxOnly: boolean;
  mrpMinor: number;
  unitCostMinor: number;
  observations: CompetitorObservation[];
};

export type DiscountSuggestion =
  | { eligible: false; reason: 'RX_ONLY' | 'INSUFFICIENT_EVIDENCE' | 'NO_MARGIN_ROOM' }
  | {
      eligible: true;
      suggestedPriceMinor: number;
      discountMinor: number;
      estimatedElasticity: number;
      minimumAllowedPriceMinor: number;
      evidenceCount: number;
    };

/**
 * Estimate constant price elasticity with an ordinary least-squares slope over
 * log(price), log(demand). The value is explicitly an estimate, never a fact.
 */
export function estimateItemDiscountElasticity(observations: CompetitorObservation[]) {
  const parsed = z.array(competitorObservationSchema).parse(observations);
  if (parsed.length < 2) return null;
  const points = parsed.map((row) => ({
    x: Math.log(row.competitorPriceMinor),
    y: Math.log(row.observedDemandUnits),
  }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const variance = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (variance <= Number.EPSILON) return null;
  const slope =
    points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) /
    variance;
  return Number.isFinite(slope) ? slope : null;
}

/** Produces an advisory price only; applying it remains in the existing owner approval flow. */
export function suggestSmartDiscount(
  rawCandidate: DiscountCandidate,
  rawPolicy: SmartDiscountPolicy
): DiscountSuggestion {
  const policy = smartDiscountPolicySchema.parse(rawPolicy);
  const candidate = z
    .object({
      rxOnly: z.boolean(),
      mrpMinor: z.number().int().positive(),
      unitCostMinor: z.number().int().nonnegative(),
      observations: z.array(competitorObservationSchema),
    })
    .strict()
    .parse(rawCandidate);

  if (candidate.rxOnly) return { eligible: false, reason: 'RX_ONLY' };
  if (candidate.observations.length < policy.minimumObservations)
    return { eligible: false, reason: 'INSUFFICIENT_EVIDENCE' };
  const elasticity = estimateItemDiscountElasticity(candidate.observations);
  // A non-negative slope does not support the claim that a lower price lifts demand.
  if (elasticity === null || elasticity >= 0)
    return { eligible: false, reason: 'INSUFFICIENT_EVIDENCE' };

  const minimumAllowedPriceMinor = Math.ceil(
    (candidate.unitCostMinor * 10_000) / (10_000 - policy.minimumMarginBps)
  );
  if (minimumAllowedPriceMinor >= candidate.mrpMinor)
    return { eligible: false, reason: 'NO_MARGIN_ROOM' };

  // Q2/Q1=(P2/P1)^elasticity. Use the median competitor price to resist one outlier.
  const prices = candidate.observations
    .map((row) => row.competitorPriceMinor)
    .sort((a, b) => a - b);
  const middle = Math.floor(prices.length / 2);
  const referencePrice =
    prices.length % 2 ? prices[middle] : Math.round((prices[middle - 1] + prices[middle]) / 2);
  const demandRatio = 1 + policy.targetDemandLiftBps / 10_000;
  const estimatedPrice = Math.round(referencePrice * demandRatio ** (1 / elasticity));
  const suggestedPriceMinor = Math.min(
    candidate.mrpMinor,
    Math.max(minimumAllowedPriceMinor, estimatedPrice)
  );
  if (suggestedPriceMinor >= candidate.mrpMinor)
    return { eligible: false, reason: 'NO_MARGIN_ROOM' };
  return {
    eligible: true,
    suggestedPriceMinor,
    discountMinor: candidate.mrpMinor - suggestedPriceMinor,
    estimatedElasticity: elasticity,
    minimumAllowedPriceMinor,
    evidenceCount: candidate.observations.length,
  };
}

/** Policy-safe generic copy: item, salt, category and clinical data are never inputs. */
export function genericDiscountWhatsAppText(discountPercent: number) {
  const percent = z.number().int().min(1).max(99).parse(discountPercent);
  return `Save ${percent}% on an eligible retail purchase in store. Terms apply. Reply STOP to opt out.`;
}
