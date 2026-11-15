import { z } from 'zod';

/**
 * DEV-66: smart discounting below MRP with a minimum-margin guard.
 *
 * Every figure here is a per-branch, owner-configurable value. The defaults are
 * illustrative starting points, not facts about any market: a minimum margin of
 * 0 bps keeps the long-standing "never below cost" floor, so a branch that has
 * not configured a policy behaves exactly as before.
 */
export const BPS = 10_000;

export const discountPolicySchema = z
  .object({
    /** Margin on the discounted selling price, (price - cost) / price, in bps. */
    minMarginBps: z.number().int().min(0).max(9_000).default(0),
    /** The deepest suggestion below MRP, in bps of the undiscounted price. */
    maxSuggestedDiscountBps: z.number().int().min(0).max(5_000).default(1_000),
    /** Sale history window the elasticity estimate reads. */
    lookbackDays: z.number().int().min(7).max(365).default(90),
    /** Distinct selling days each side (full price, discounted) needs before an estimate is made. */
    minObservationDays: z.number().int().min(1).max(60).default(7),
    /** Competitor prices older than this are ignored. */
    competitorPriceMaxAgeDays: z.number().int().min(1).max(90).default(14),
  })
  .strict();

export type DiscountPolicy = z.infer<typeof discountPolicySchema>;

export function parseDiscountPolicy(raw: unknown): DiscountPolicy {
  const parsed = discountPolicySchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : discountPolicySchema.parse({});
}

/** Regulated stock (Rx-only, restricted, controlled) is never promoted. */
export function isRegulatedForDiscount(medicine: {
  rx: boolean;
  restricted: boolean;
  controlled: boolean;
}) {
  return medicine.rx || medicine.restricted || medicine.controlled;
}

/**
 * The lowest net price that keeps at least `minMarginBps` of margin on the
 * selling price, never below cost. Rounded up so the floor is never breached.
 */
export function minimumPriceForMargin(costMinor: number, minMarginBps: number) {
  if (!Number.isSafeInteger(costMinor) || costMinor < 0) throw new RangeError('costMinor');
  if (!Number.isInteger(minMarginBps) || minMarginBps < 0 || minMarginBps >= BPS)
    throw new RangeError('minMarginBps');
  return Math.max(costMinor, Math.ceil((costMinor * BPS) / (BPS - minMarginBps)));
}

export type DiscountDemandObservation = {
  /** Calendar day key of the sale (e.g. 2026-11-15). */
  day: string;
  units: number;
  netMinor: number;
  discounted: boolean;
};

export type DiscountElasticityEstimate = {
  /** Arc (midpoint) price elasticity of daily units. An estimate, not a fact. */
  elasticity: number;
  fullPriceDays: number;
  discountedDays: number;
};

function bucket(rows: readonly DiscountDemandObservation[]) {
  const days = new Set<string>();
  let units = 0;
  let netMinor = 0;
  for (const row of rows) {
    if (row.units <= 0) continue;
    days.add(row.day);
    units += row.units;
    netMinor += row.netMinor;
  }
  return { days: days.size, units, netMinor };
}

/**
 * Per-item discount elasticity: compares average daily units and average net
 * unit price on discounted days against full-price days. Returns null when
 * either side has too little evidence or the discounted price is not lower.
 */
export function estimateDiscountElasticity(
  rows: readonly DiscountDemandObservation[],
  minObservationDays: number
): DiscountElasticityEstimate | null {
  const full = bucket(rows.filter((row) => !row.discounted));
  const disc = bucket(rows.filter((row) => row.discounted));
  if (full.days < minObservationDays || disc.days < minObservationDays) return null;
  if (full.units <= 0 || disc.units <= 0) return null;
  const p1 = full.netMinor / full.units;
  const p2 = disc.netMinor / disc.units;
  if (!(p2 < p1) || p1 <= 0) return null;
  const q1 = full.units / full.days;
  const q2 = disc.units / disc.days;
  const elasticity = (q2 - q1) / ((q1 + q2) / 2) / ((p2 - p1) / ((p1 + p2) / 2));
  if (!Number.isFinite(elasticity)) return null;
  return {
    elasticity: Math.round(elasticity * 100) / 100,
    fullPriceDays: full.days,
    discountedDays: disc.days,
  };
}

export type DiscountSuggestion =
  | { kind: 'EXCLUDED'; reason: 'REGULATED' }
  | {
      kind: 'NONE';
      reason: 'AT_MARGIN_FLOOR' | 'INELASTIC' | 'NO_EVIDENCE';
      floorPriceMinor: number;
      ceilingPriceMinor: number;
    }
  | {
      kind: 'SUGGEST';
      basis: 'COMPETITOR' | 'ELASTICITY';
      suggestedPriceMinor: number;
      discountMinor: number;
      floorPriceMinor: number;
      ceilingPriceMinor: number;
      /** Estimated unit uplift from the elasticity estimate, in bps; null without one. */
      estimatedUnitUpliftBps: number | null;
    };

/**
 * A suggestion is capped at MRP (never above it), floored by the minimum-margin
 * guard (never below it), limited to the configured maximum depth, and never
 * made for regulated stock.
 */
export function suggestDiscount(input: {
  medicine: { rx: boolean; restricted: boolean; controlled: boolean };
  mrpMinor: number;
  unitPriceMinor: number;
  unitCostMinor: number;
  policy: DiscountPolicy;
  elasticity: number | null;
  lowestCompetitorPriceMinor: number | null;
}): DiscountSuggestion {
  if (isRegulatedForDiscount(input.medicine)) return { kind: 'EXCLUDED', reason: 'REGULATED' };
  const ceilingPriceMinor = Math.min(input.mrpMinor, input.unitPriceMinor);
  const floorPriceMinor = minimumPriceForMargin(input.unitCostMinor, input.policy.minMarginBps);
  const none = (reason: 'AT_MARGIN_FLOOR' | 'INELASTIC' | 'NO_EVIDENCE') =>
    ({ kind: 'NONE', reason, floorPriceMinor, ceilingPriceMinor }) as const;
  if (floorPriceMinor >= ceilingPriceMinor) return none('AT_MARGIN_FLOOR');
  const deepestPriceMinor = Math.max(
    floorPriceMinor,
    ceilingPriceMinor - Math.floor((ceilingPriceMinor * input.policy.maxSuggestedDiscountBps) / BPS)
  );
  let target: number;
  let basis: 'COMPETITOR' | 'ELASTICITY';
  if (
    input.lowestCompetitorPriceMinor !== null &&
    input.lowestCompetitorPriceMinor < ceilingPriceMinor
  ) {
    target = Math.max(deepestPriceMinor, input.lowestCompetitorPriceMinor);
    basis = 'COMPETITOR';
  } else if (input.elasticity === null) {
    return none('NO_EVIDENCE');
  } else if (input.elasticity < -1) {
    target = deepestPriceMinor;
    basis = 'ELASTICITY';
  } else {
    return none('INELASTIC');
  }
  if (target >= ceilingPriceMinor) return none('AT_MARGIN_FLOOR');
  const discountMinor = ceilingPriceMinor - target;
  return {
    kind: 'SUGGEST',
    basis,
    suggestedPriceMinor: target,
    discountMinor,
    floorPriceMinor,
    ceilingPriceMinor,
    estimatedUnitUpliftBps:
      input.elasticity === null
        ? null
        : Math.max(0, Math.round((-input.elasticity * discountMinor * BPS) / ceilingPriceMinor)),
  };
}
