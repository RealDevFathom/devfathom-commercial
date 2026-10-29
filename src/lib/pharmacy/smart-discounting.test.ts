import { describe, expect, it } from 'vitest';
import {
  estimateItemDiscountElasticity,
  genericDiscountWhatsAppText,
  suggestSmartDiscount,
} from './smart-discounting';

const policy = { minimumMarginBps: 2_000, minimumObservations: 3, targetDemandLiftBps: 1_000 };
const observations = [
  { competitorPriceMinor: 1_000, observedDemandUnits: 10 },
  { competitorPriceMinor: 900, observedDemandUnits: 12 },
  { competitorPriceMinor: 800, observedDemandUnits: 15 },
];

describe('smart pharmacy discounting', () => {
  it('estimates item elasticity from logged price and demand observations', () => {
    expect(estimateItemDiscountElasticity(observations)).toBeLessThan(0);
  });

  it('floors a suggestion at the configured minimum-margin price', () => {
    const result = suggestSmartDiscount(
      { rxOnly: false, mrpMinor: 1_000, unitCostMinor: 760, observations },
      policy
    );
    expect(result).toMatchObject({
      eligible: true,
      suggestedPriceMinor: 950,
      minimumAllowedPriceMinor: 950,
      discountMinor: 50,
    });
  });

  it('never suggests above MRP and blocks when there is no discount room', () => {
    expect(
      suggestSmartDiscount(
        { rxOnly: false, mrpMinor: 900, unitCostMinor: 800, observations },
        policy
      )
    ).toEqual({ eligible: false, reason: 'NO_MARGIN_ROOM' });
  });

  it('excludes Rx-only items before considering their observations', () => {
    expect(
      suggestSmartDiscount({ rxOnly: true, mrpMinor: 1_000, unitCostMinor: 100, observations }, policy)
    ).toEqual({ eligible: false, reason: 'RX_ONLY' });
  });

  it('requires the configurable evidence count and a supported negative estimate', () => {
    expect(
      suggestSmartDiscount(
        { rxOnly: false, mrpMinor: 1_000, unitCostMinor: 100, observations: observations.slice(0, 2) },
        policy
      )
    ).toEqual({ eligible: false, reason: 'INSUFFICIENT_EVIDENCE' });
  });

  it('builds generic WhatsApp copy without accepting item or category text', () => {
    expect(genericDiscountWhatsAppText(10)).toBe(
      'Save 10% on an eligible retail purchase in store. Terms apply. Reply STOP to opt out.'
    );
  });
});
