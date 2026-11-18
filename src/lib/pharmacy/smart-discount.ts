import { z } from 'zod';

/**
 * DEV-66: smart discounting below MRP with a minimum-margin guard.
 *
 * Every figure here is an owner-configurable value. The branch policy defaults
 * are illustrative starting points, not facts about any market: a minimum margin
 * of 0 bps keeps the long-standing "never below cost" floor, so a branch that has
 * not configured a policy behaves exactly as before. The deepest discount anyone
 * may give is the organization's owner-set maximum (`pharmacyMaxDiscountBps`),
 * never a number fixed here.
 */
export const BPS = 10_000;

export const discountPolicySchema = z
  .object({
    /** Margin on the discounted selling price, (price - cost) / price, in bps. */
    minMarginBps: z.number().int().min(0).max(9_000).default(0),
    /** Sale history window the elasticity estimate reads. */
    lookbackDays: z.number().int().min(7).max(365).default(90),
    /** Distinct selling days each side (full price, discounted) needs before an estimate is made. */
    minObservationDays: z.number().int().min(1).max(60).default(7),
    /** Competitor prices older than this are ignored. */
    competitorPriceMaxAgeDays: z.number().int().min(1).max(90).default(14),
  })
  .strict();

/**
 * The stored default: no maximum set yet (100%), so the limit does not bite until the owner
 * sets one. The minimum-margin guard and the cost floor apply regardless.
 */
export const NO_MAXIMUM_DISCOUNT_BPS = BPS;

/** The owner's maximum discount on a line, in bps of the undiscounted price (100% = 10,000). */
export const maxDiscountBpsSchema = z.number().int().min(0).max(BPS);

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

/** The most a line may be discounted under the owner's maximum, rounded down. */
export function maxDiscountMinorFor(grossMinor: number, maxDiscountBps: number) {
  if (!Number.isSafeInteger(grossMinor) || grossMinor < 0) throw new RangeError('grossMinor');
  // A missing or corrupt maximum fails closed: no discount at all.
  if (!Number.isInteger(maxDiscountBps) || maxDiscountBps <= 0) return 0;
  return Math.floor((grossMinor * Math.min(maxDiscountBps, BPS)) / BPS);
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
 * guard (never below it), limited to the owner's maximum discount, and never
 * made for regulated stock.
 */
export function suggestDiscount(input: {
  medicine: { rx: boolean; restricted: boolean; controlled: boolean };
  mrpMinor: number;
  unitPriceMinor: number;
  unitCostMinor: number;
  policy: DiscountPolicy;
  /** The organization's owner-set maximum discount, in bps. */
  maxDiscountBps: number;
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
    ceilingPriceMinor - maxDiscountMinorFor(ceilingPriceMinor, input.maxDiscountBps)
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
    // The price change is measured on the same midpoint basis as the arc elasticity.
    estimatedUnitUpliftBps:
      input.elasticity === null
        ? null
        : Math.max(
            0,
            Math.round(
              (-input.elasticity * discountMinor * BPS) / ((ceilingPriceMinor + target) / 2)
            )
          ),
  };
}
