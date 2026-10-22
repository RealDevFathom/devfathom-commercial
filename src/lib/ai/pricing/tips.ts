import type { AITier } from '../tiers';

const BASIS_POINTS = 10_000;

export type MarginBand = Readonly<{
  /** Gross margin lower bound, in basis points (for example, 2_000 = 20%). */
  minimumBps: number;
  /** Gross margin upper bound, in basis points (for example, 3_000 = 30%). */
  maximumBps: number;
}>;

export type PriceTipInput = Readonly<{
  itemId: string;
  currentPriceMinor: number;
  costMinor: number;
  mrpMinor: number;
  targetMargin: MarginBand;
  /** Regulated prices are never eligible for a pricing tip. */
  regulatedPrice: boolean;
}>;

export const PRICING_TIP_SOURCE_LABEL = 'DevFathom AI' as const;

export type PriceTip = Readonly<{
  sourceLabel: typeof PRICING_TIP_SOURCE_LABEL;
  itemId: string;
  currentPriceMinor: number;
  suggestedPriceMinor: number;
  targetMargin: MarginBand;
  direction: 'INCREASE' | 'DECREASE';
  advisory: true;
  requiresOwnerAction: true;
  aiTier: Extract<AITier, 'standard'>;
}>;

function assertMoney(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer in minor units.`);
  }
}

function assertMarginBand(band: MarginBand) {
  if (
    !Number.isSafeInteger(band.minimumBps) ||
    !Number.isSafeInteger(band.maximumBps) ||
    band.minimumBps < 0 ||
    band.minimumBps > band.maximumBps ||
    band.maximumBps >= BASIS_POINTS
  ) {
    throw new RangeError('Target margin must be an ordered basis-point band below 100%.');
  }
}

/** The lowest whole-minor-unit price that reaches a gross-margin target. */
function priceForMinimumMargin(costMinor: number, marginBps: number) {
  return Math.ceil((costMinor * BASIS_POINTS) / (BASIS_POINTS - marginBps));
}

/** The highest whole-minor-unit price that does not exceed a gross-margin target. */
function priceForMaximumMargin(costMinor: number, marginBps: number) {
  return Math.floor((costMinor * BASIS_POINTS) / (BASIS_POINTS - marginBps));
}

/**
 * Produces an advisory price change only when the current price is outside the
 * requested gross-margin band. This function never persists or applies a price;
 * a separate, audited owner action is required to do that.
 *
 * Cost and MRP are hard safety bounds. If the complete target band is not
 * attainable between them, the closest safe boundary is suggested instead.
 */
export function suggestPriceTip(input: PriceTipInput): PriceTip | null {
  if (input.regulatedPrice) return null;

  assertMoney('currentPriceMinor', input.currentPriceMinor);
  assertMoney('costMinor', input.costMinor);
  assertMoney('mrpMinor', input.mrpMinor);
  assertMarginBand(input.targetMargin);

  if (input.costMinor > input.mrpMinor) {
    throw new RangeError('Cost cannot exceed MRP.');
  }

  const bandFloor = priceForMinimumMargin(input.costMinor, input.targetMargin.minimumBps);
  const bandCeiling = priceForMaximumMargin(input.costMinor, input.targetMargin.maximumBps);

  let suggestedPriceMinor: number | null = null;
  if (input.currentPriceMinor < bandFloor) suggestedPriceMinor = bandFloor;
  if (input.currentPriceMinor > bandCeiling) suggestedPriceMinor = bandCeiling;
  if (suggestedPriceMinor === null) return null;

  // Safety bounds are applied last so no target or rounding can bypass them.
  suggestedPriceMinor = Math.max(input.costMinor, Math.min(input.mrpMinor, suggestedPriceMinor));
  if (suggestedPriceMinor === input.currentPriceMinor) return null;

  return {
    sourceLabel: PRICING_TIP_SOURCE_LABEL,
    itemId: input.itemId,
    currentPriceMinor: input.currentPriceMinor,
    suggestedPriceMinor,
    targetMargin: input.targetMargin,
    direction: suggestedPriceMinor > input.currentPriceMinor ? 'INCREASE' : 'DECREASE',
    advisory: true,
    requiresOwnerAction: true,
    aiTier: 'standard',
  };
}
