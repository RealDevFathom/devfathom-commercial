import { describe, expect, it } from 'vitest';
import { suggestPriceTip, type PriceTipInput } from './tips';

const input: PriceTipInput = {
  itemId: 'item-1',
  currentPriceMinor: 1_000,
  costMinor: 800,
  mrpMinor: 1_500,
  targetMargin: { minimumBps: 2_000, maximumBps: 3_000 },
  regulatedPrice: false,
};

describe('DevFathom AI pricing tips', () => {
  it('suggests the nearest edge of the target margin band as advice only', () => {
    expect(suggestPriceTip({ ...input, currentPriceMinor: 900 })).toMatchObject({
      sourceLabel: 'DevFathom AI',
      suggestedPriceMinor: 1_000,
      direction: 'INCREASE',
      advisory: true,
      requiresOwnerAction: true,
      aiTier: 'standard',
    });
    expect(suggestPriceTip({ ...input, currentPriceMinor: 1_200 })).toMatchObject({
      suggestedPriceMinor: 1_142,
      direction: 'DECREASE',
    });
    expect(suggestPriceTip(input)).toBeNull();
  });

  it('hard-clamps an increase to MRP when the minimum target margin is unattainable', () => {
    const tip = suggestPriceTip({
      ...input,
      currentPriceMinor: 850,
      costMinor: 900,
      mrpMinor: 1_000,
      targetMargin: { minimumBps: 2_000, maximumBps: 3_000 },
    });

    expect(tip?.suggestedPriceMinor).toBe(1_000);
    expect(tip!.suggestedPriceMinor).toBeLessThanOrEqual(1_000);
  });

  it('hard-clamps a decrease to cost when the maximum target margin is unattainable', () => {
    const tip = suggestPriceTip({
      ...input,
      currentPriceMinor: 1_500,
      costMinor: 1_000,
      mrpMinor: 1_500,
      targetMargin: { minimumBps: 0, maximumBps: 0 },
    });

    expect(tip?.suggestedPriceMinor).toBe(1_000);
    expect(tip!.suggestedPriceMinor).toBeGreaterThanOrEqual(1_000);
  });

  it('does not produce tips for regulated-price items', () => {
    expect(suggestPriceTip({ ...input, regulatedPrice: true })).toBeNull();
  });
});
