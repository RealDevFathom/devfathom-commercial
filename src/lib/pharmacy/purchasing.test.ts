import { describe, expect, it } from 'vitest';
import {
  allocateByWeight,
  assertApprovalAllowed,
  assertPurchaseOrderTransition,
  assertRequisitionTransition,
  assertSupplierEligible,
  compareQuotes,
  costPurchaseOrderLine,
  effectiveCostPerSellableUnit,
  landedCost,
  MICRO,
  type QuoteCandidate,
  type SupplierLicenceEvidence,
} from './purchasing';

const NOW = new Date('2026-09-02T00:00:00.000Z');
const VALID_LICENCE: SupplierLicenceEvidence = {
  expiresAt: new Date('2027-01-01T00:00:00.000Z'),
  verified: true,
  superseded: false,
};

describe('PUR-01 supplier eligibility', () => {
  it('accepts an authorized supplier holding one unexpired verified licence', () => {
    expect(() =>
      assertSupplierEligible({ authorized: true, licences: [VALID_LICENCE], at: NOW })
    ).not.toThrow();
  });

  it('refuses an unauthorized supplier even with a valid licence', () => {
    expect(() =>
      assertSupplierEligible({ authorized: false, licences: [VALID_LICENCE], at: NOW })
    ).toThrow('SUPPLIER_NOT_AUTHORIZED');
  });

  it('refuses an authorized supplier whose only licence has expired', () => {
    expect(() =>
      assertSupplierEligible({
        authorized: true,
        licences: [
          {
            expiresAt: new Date('2026-09-01T23:59:59.999Z'),
            verified: true,
            superseded: false,
          },
        ],
        at: NOW,
      })
    ).toThrow('SUPPLIER_LICENCE_EXPIRED');
  });

  it('does not accept a superseded licence as licence evidence', () => {
    expect(() =>
      assertSupplierEligible({
        authorized: true,
        licences: [{ ...VALID_LICENCE, superseded: true }],
        at: NOW,
      })
    ).toThrow('SUPPLIER_LICENCE_EXPIRED');
  });

  it('does not accept an unverified licence filing as licence evidence', () => {
    expect(() =>
      assertSupplierEligible({
        authorized: true,
        licences: [{ ...VALID_LICENCE, verified: false }],
        at: NOW,
      })
    ).toThrow('SUPPLIER_LICENCE_EXPIRED');
  });

  it('treats a licence expiring at this instant as still valid', () => {
    expect(() =>
      assertSupplierEligible({
        authorized: true,
        licences: [{ expiresAt: NOW, verified: true, superseded: false }],
        at: NOW,
      })
    ).not.toThrow();
  });
});

describe('PUR-02 status machine and approval policy', () => {
  it('walks DRAFT → SUBMITTED → APPROVED → SENT → RECEIVING', () => {
    expect(() => {
      assertPurchaseOrderTransition('DRAFT', 'SUBMITTED');
      assertPurchaseOrderTransition('SUBMITTED', 'APPROVED');
      assertPurchaseOrderTransition('APPROVED', 'SENT');
      assertPurchaseOrderTransition('SENT', 'RECEIVING');
    }).not.toThrow();
  });

  it.each([
    ['DRAFT', 'APPROVED'],
    ['SUBMITTED', 'SENT'],
    ['DRAFT', 'SENT'],
    ['CANCELLED', 'DRAFT'],
    ['RECEIVING', 'SENT'],
  ] as const)('refuses %s → %s, so approval cannot be skipped', (from, to) =>
    expect(() => assertPurchaseOrderTransition(from, to)).toThrow('INVALID_TRANSITION')
  );

  it('refuses a requisition jumping straight from DRAFT to APPROVED', () =>
    expect(() => assertRequisitionTransition('DRAFT', 'APPROVED')).toThrow('INVALID_TRANSITION'));

  it('refuses approval by the person who drafted the order', () =>
    expect(() =>
      assertApprovalAllowed({
        approverId: 'user_a',
        requestedById: 'user_b',
        createdById: 'user_a',
      })
    ).toThrow('SELF_APPROVAL'));

  it('refuses approval by the person who raised the requisition', () =>
    expect(() =>
      assertApprovalAllowed({
        approverId: 'user_b',
        requestedById: 'user_b',
        createdById: 'user_a',
      })
    ).toThrow('SELF_APPROVAL'));

  it('allows a third party to approve', () =>
    expect(() =>
      assertApprovalAllowed({
        approverId: 'user_c',
        requestedById: 'user_b',
        createdById: 'user_a',
      })
    ).not.toThrow());
});

describe('PUR-03 line arithmetic', () => {
  it('applies list → discount → rebate → tax in order', () => {
    expect(
      costPurchaseOrderLine({
        orderedPacks: 10,
        bonusPacks: 0,
        canonicalUnitsPerPack: 10,
        listPricePerPackMinor: 10_000,
        discountBps: 1_000, // 10%
        rebateBps: 500, // 5% of the discounted net
        taxBps: 1_700, // 17% of net less rebate
      })
    ).toEqual({
      grossMinor: 100_000,
      discountMinor: 10_000,
      netMinor: 90_000,
      rebateMinor: 4_500,
      taxMinor: 14_535,
      netCostMinor: 100_035,
      canonicalUnits: 100,
    });
  });

  it('excludes a creditable input tax from stock cost but still reports it', () => {
    const creditable = costPurchaseOrderLine({
      orderedPacks: 1,
      bonusPacks: 0,
      canonicalUnitsPerPack: 1,
      listPricePerPackMinor: 1_000,
      taxBps: 1_700,
      taxCreditable: true,
    });
    expect(creditable.taxMinor).toBe(170);
    expect(creditable.netCostMinor).toBe(1_000);
  });

  it('rounds each money step half-up at the point it is applied', () => {
    // 1 × 333 at 50 bps = 1.665 minor → 2, not 1 and not a fraction carried onward.
    const line = costPurchaseOrderLine({
      orderedPacks: 1,
      bonusPacks: 0,
      canonicalUnitsPerPack: 1,
      listPricePerPackMinor: 333,
      discountBps: 50,
    });
    expect(line.discountMinor).toBe(2);
    expect(line.netMinor).toBe(331);
  });

  it.each([
    { orderedPacks: 0, canonicalUnitsPerPack: 1 },
    { orderedPacks: 1.5, canonicalUnitsPerPack: 1 },
    { orderedPacks: 1, canonicalUnitsPerPack: 0 },
    { orderedPacks: -1, canonicalUnitsPerPack: 1 },
  ])('rejects a non-positive or fractional quantity', (quantities) =>
    expect(() =>
      costPurchaseOrderLine({
        bonusPacks: 0,
        listPricePerPackMinor: 100,
        ...quantities,
      })
    ).toThrow('INVALID_QUANTITY')
  );

  it('rejects a rate above 100%', () =>
    expect(() =>
      costPurchaseOrderLine({
        orderedPacks: 1,
        bonusPacks: 0,
        canonicalUnitsPerPack: 1,
        listPricePerPackMinor: 100,
        discountBps: 10_001,
      })
    ).toThrow('INVALID_RATE'));
});

describe('PUR-03 charge allocation', () => {
  it('splits a charge that does not divide evenly without inventing or losing a paisa', () => {
    const parts = allocateByWeight(100, [1, 1, 1]);
    expect(parts).toEqual([34, 33, 33]);
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(100);
  });

  it('allocates in proportion to line value', () => {
    expect(allocateByWeight(1_000, [7_500, 2_500])).toEqual([750, 250]);
  });

  it('spreads evenly when every line is free of charge', () => {
    expect(allocateByWeight(7, [0, 0])).toEqual([4, 3]);
  });

  it('gives ties to the earlier line so allocation is deterministic', () => {
    expect(allocateByWeight(1, [5, 5])).toEqual([1, 0]);
  });

  it('rejects an allocation with no lines to allocate across', () =>
    expect(() => allocateByWeight(100, [])).toThrow('INVALID_QUANTITY'));
});

describe('PUR-03 landed cost', () => {
  const baseLine = {
    orderedPacks: 10,
    canonicalUnitsPerPack: 10,
    listPricePerPackMinor: 10_000,
  };

  it('raises quantity and lowers unit cost for bonus units, leaving the money untouched', () => {
    const without = landedCost({ lines: [{ ...baseLine, bonusPacks: 0 }] });
    const with2Free = landedCost({ lines: [{ ...baseLine, bonusPacks: 2 }] });

    // Same money paid either way — a free pack is never a money term.
    expect(with2Free.landedCostMinor).toBe(without.landedCostMinor);
    expect(with2Free.payableMinor).toBe(without.payableMinor);
    // More units received.
    expect(without.canonicalUnits).toBe(100);
    expect(with2Free.canonicalUnits).toBe(120);
    // And so a strictly lower cost per canonical unit.
    expect(without.lines[0]!.landedCostPerCanonicalUnitMicroMinor).toBe(1_000 * MICRO);
    expect(with2Free.lines[0]!.landedCostPerCanonicalUnitMicroMinor).toBe(833_333_333);
    expect(with2Free.lines[0]!.landedCostPerCanonicalUnitMicroMinor).toBeLessThan(
      without.lines[0]!.landedCostPerCanonicalUnitMicroMinor
    );
  });

  it('keeps the per-unit cost exact to a millionth of a minor unit', () => {
    // 100,000 minor over 120 units = 833.3333… minor; half-up at 1e-6 resolution.
    const costed = landedCost({ lines: [{ ...baseLine, bonusPacks: 2 }] });
    const [line] = costed.lines;
    expect(line!.landedCostPerCanonicalUnitMicroMinor).toBe(Math.round((100_000 * MICRO) / 120));
  });

  it('allocates freight and other charges across lines by net value and sums exactly', () => {
    const costed = landedCost({
      lines: [
        { ...baseLine, bonusPacks: 0 },
        { orderedPacks: 5, bonusPacks: 0, canonicalUnitsPerPack: 10, listPricePerPackMinor: 6_000 },
      ],
      freightMinor: 900,
      otherChargesMinor: 101,
    });
    const allocated = costed.lines.map((line) => line.allocatedChargeMinor);
    expect(allocated.reduce((sum, part) => sum + part, 0)).toBe(1_001);
    // 100,000 : 30,000 net → 769.2 : 231.8 of 1,001, largest remainder first.
    expect(allocated).toEqual([770, 231]);
    expect(costed.landedCostMinor).toBe(130_000 + 1_001);
  });

  it('adds freight to what is payable and to the landed unit cost', () => {
    const bare = landedCost({ lines: [{ ...baseLine, bonusPacks: 0 }] });
    const freighted = landedCost({ lines: [{ ...baseLine, bonusPacks: 0 }], freightMinor: 5_000 });
    expect(freighted.payableMinor - bare.payableMinor).toBe(5_000);
    expect(freighted.lines[0]!.landedCostPerCanonicalUnitMicroMinor).toBe(1_050 * MICRO);
  });

  it('reports payable separately from stock cost when the tax is creditable', () => {
    const costed = landedCost({
      lines: [{ ...baseLine, bonusPacks: 0, taxBps: 1_700, taxCreditable: true }],
    });
    expect(costed.taxMinor).toBe(17_000);
    expect(costed.netCostMinor).toBe(100_000);
    expect(costed.payableMinor).toBe(117_000);
  });

  it('rejects an order with no lines', () =>
    expect(() => landedCost({ lines: [] })).toThrow('INVALID_QUANTITY'));
});

describe('PUR-02 quote comparison', () => {
  const supplier = (
    id: string,
    name: string
  ): Pick<
    QuoteCandidate,
    'supplierId' | 'supplierName' | 'supplierAuthorized' | 'supplierLicences'
  > => ({
    supplierId: id,
    supplierName: name,
    supplierAuthorized: true,
    supplierLicences: [VALID_LICENCE],
  });

  const base = {
    validUntil: new Date('2026-10-01T00:00:00.000Z'),
    canonicalUnitsPerPack: 10,
    moqPacks: 1,
    leadTimeDays: 3,
    minimumExpiryDays: 365,
    forecastSellThroughPacks: 12,
  };

  it('treats 10+1 as 9.1% equivalent only when the bonus is forecast to sell', () => {
    const allSell = effectiveCostPerSellableUnit({
      costMinor: 100_000,
      paidPacks: 10,
      bonusPacks: 1,
      canonicalUnitsPerPack: 1,
      forecastSellThroughPacks: 11,
    });
    const bonusExpires = effectiveCostPerSellableUnit({
      costMinor: 100_000,
      paidPacks: 10,
      bonusPacks: 1,
      canonicalUnitsPerPack: 1,
      forecastSellThroughPacks: 10,
    });

    expect(allSell.effectiveUnitCostMicroMinor).toBe(9_090_909_091);
    expect(allSell.atRiskBonusPacks).toBe(0);
    expect(bonusExpires.effectiveUnitCostMicroMinor).toBe(10_000 * MICRO);
    expect(bonusExpires.atRiskBonusPacks).toBe(1);
  });

  it('ranks by effective landed unit cost and explains every position', () => {
    const ranking = compareQuotes({
      requiredPacks: 10,
      at: NOW,
      candidates: [
        {
          quoteId: 'q_dear',
          ...supplier('s_1', 'Dear Distributors'),
          ...base,
          pricePerPackMinor: 10_000,
        },
        {
          quoteId: 'q_scheme',
          ...supplier('s_2', 'Scheme Distributors'),
          ...base,
          pricePerPackMinor: 10_000,
          schemeBuyPacks: 5,
          schemeFreePacks: 1,
        },
        {
          quoteId: 'q_discount',
          ...supplier('s_3', 'Discount Distributors'),
          ...base,
          pricePerPackMinor: 10_000,
          discountBps: 1_500,
        },
      ],
    });

    // A buy-5-get-1 scheme (100,000 over 120 units) beats a 15% discount
    // (85,000 over 100 units), which beats list price — bonus units are a real
    // price lever, not a display flourish.
    expect(ranking.map((row) => row.quoteId)).toEqual(['q_scheme', 'q_discount', 'q_dear']);
    expect(ranking.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(ranking.every((row) => row.comparable)).toBe(true);
    expect(ranking.map((row) => row.effectiveUnitCostMicroMinor)).toEqual([
      833_333_333,
      850 * MICRO,
      1_000 * MICRO,
    ]);
    expect(ranking[0]!.reasons).toContainEqual(
      'Scheme adds 2 free packs and the configured forecast sells all before expiry.'
    );
    expect(ranking[1]!.reasons).toContainEqual('Trade discount of 15.00% off list.');
    expect(ranking.every((row) => row.reasons.length > 0)).toBe(true);
  });

  it.each([10, 12])('ranks schemes using the %i-pack sell-through forecast', (forecast) => {
    const ranking = compareQuotes({
      requiredPacks: 10,
      at: NOW,
      candidates: [
        {
          ...base,
          ...supplier('s_scheme', 'Scheme'),
          quoteId: 'q_scheme',
          pricePerPackMinor: 10_000,
          schemeBuyPacks: 5,
          schemeFreePacks: 1,
          forecastSellThroughPacks: forecast,
        },
        {
          ...base,
          ...supplier('s_discount', 'Discount'),
          quoteId: 'q_discount',
          pricePerPackMinor: 10_000,
          discountBps: 1_500,
          forecastSellThroughPacks: forecast,
        },
      ],
    });
    expect(ranking.map((row) => row.quoteId)).toEqual(
      forecast === 10 ? ['q_discount', 'q_scheme'] : ['q_scheme', 'q_discount']
    );
    const scheme = ranking.find((row) => row.quoteId === 'q_scheme')!;
    expect(scheme.atRiskBonusPacks).toBe(forecast === 10 ? 2 : 0);
    expect(scheme.effectiveSellableUnitCostMicroMinor).toBe(
      forecast === 10 ? 1_000 * MICRO : 833_333_333
    );
  });

  it('keeps a legacy scheme quote with no recorded forecast ranked as if all packs sell', () => {
    const ranking = compareQuotes({
      requiredPacks: 10,
      at: NOW,
      candidates: [
        {
          ...base,
          ...supplier('s_scheme', 'Scheme'),
          quoteId: 'q_scheme',
          pricePerPackMinor: 10_000,
          schemeBuyPacks: 5,
          schemeFreePacks: 1,
          forecastSellThroughPacks: null,
        },
        {
          ...base,
          ...supplier('s_discount', 'Discount'),
          quoteId: 'q_discount',
          pricePerPackMinor: 10_000,
          discountBps: 1_500,
          forecastSellThroughPacks: null,
        },
      ],
    });
    expect(ranking.map((row) => row.quoteId)).toEqual(['q_scheme', 'q_discount']);
    const scheme = ranking[0]!;
    expect(scheme.forecastSellThroughPacks).toBeNull();
    expect(scheme.atRiskBonusPacks).toBe(0);
    expect(scheme.effectiveSellableUnitCostMicroMinor).toBe(833_333_333);
    expect(scheme.reasons).toContainEqual(
      'Scheme adds 2 free packs; no sell-through forecast is recorded, so all are assumed to sell.'
    );
  });

  it('flags nothing at risk on a quote that cannot be compared', () => {
    const [row] = compareQuotes({
      requiredPacks: 10,
      at: NOW,
      candidates: [
        {
          ...base,
          ...supplier('s_lapsed', 'Lapsed'),
          supplierAuthorized: false,
          quoteId: 'q_lapsed',
          pricePerPackMinor: 10_000,
          schemeBuyPacks: 5,
          schemeFreePacks: 1,
          forecastSellThroughPacks: 5,
        },
      ],
    });
    expect(row!.comparable).toBe(false);
    expect(row!.atRiskBonusPacks).toBe(0);
    expect(row!.atRiskPaidPacks).toBe(0);
    expect(row!.reasons).toContainEqual('Scheme adds 2 free packs.');
    expect(row!.reasons.some((reason) => reason.includes('expiry risk'))).toBe(false);
  });

  it('reports paid packs at risk when the forecast is below the paid quantity', () => {
    expect(
      effectiveCostPerSellableUnit({
        costMinor: 100_000,
        paidPacks: 10,
        bonusPacks: 2,
        canonicalUnitsPerPack: 1,
        forecastSellThroughPacks: 7,
      })
    ).toMatchObject({ sellablePacks: 7, atRiskPaidPacks: 3, atRiskBonusPacks: 2 });
    const [row] = compareQuotes({
      requiredPacks: 10,
      at: NOW,
      candidates: [
        {
          ...base,
          ...supplier('s_1', 'A'),
          quoteId: 'q_a',
          pricePerPackMinor: 10_000,
          forecastSellThroughPacks: 7,
        },
      ],
    });
    expect(row!.atRiskPaidPacks).toBe(3);
    expect(row!.reasons).toContainEqual(
      '3 paid packs are at expiry risk under the configured sell-through forecast.'
    );
  });

  it('returns a ranked list and never awards a winner', () => {
    const ranking = compareQuotes({
      requiredPacks: 10,
      at: NOW,
      candidates: [
        { quoteId: 'q_a', ...supplier('s_1', 'A'), ...base, pricePerPackMinor: 9_000 },
        { quoteId: 'q_b', ...supplier('s_2', 'B'), ...base, pricePerPackMinor: 10_000 },
      ],
    });
    expect(ranking).toHaveLength(2);
    expect(Object.keys(ranking[0]!)).not.toContain('awarded');
    expect(Object.keys(ranking[0]!)).not.toContain('selected');
  });

  it('ranks an unauthorized or licence-expired supplier last and says why', () => {
    const ranking = compareQuotes({
      requiredPacks: 10,
      at: NOW,
      candidates: [
        {
          quoteId: 'q_cheap_unauthorized',
          ...supplier('s_1', 'Cheapest'),
          supplierAuthorized: false,
          ...base,
          pricePerPackMinor: 1_000,
        },
        {
          quoteId: 'q_expired',
          ...supplier('s_2', 'Lapsed'),
          supplierLicences: [
            {
              expiresAt: new Date('2026-01-01T00:00:00.000Z'),
              verified: true,
              superseded: false,
            },
          ],
          ...base,
          pricePerPackMinor: 2_000,
        },
        { quoteId: 'q_ok', ...supplier('s_3', 'Licensed'), ...base, pricePerPackMinor: 10_000 },
      ],
    });

    expect(ranking[0]!.quoteId).toBe('q_ok');
    expect(ranking.slice(1).map((row) => row.comparable)).toEqual([false, false]);
    expect(ranking.map((row) => row.effectiveUnitCostMicroMinor).slice(1)).toEqual([null, null]);
    expect(ranking[1]!.reasons).toContainEqual(
      'Supplier is not authorized to supply this pharmacy.'
    );
    expect(ranking[2]!.reasons).toContainEqual(
      'Supplier has no unexpired verified licence on file.'
    );
  });

  it('excludes a lapsed quote from comparison and explains it', () => {
    const ranking = compareQuotes({
      requiredPacks: 10,
      at: NOW,
      candidates: [
        {
          quoteId: 'q_lapsed',
          ...supplier('s_1', 'Lapsed quote'),
          ...base,
          validUntil: new Date('2026-08-01T00:00:00.000Z'),
          pricePerPackMinor: 1_000,
        },
        { quoteId: 'q_live', ...supplier('s_2', 'Live quote'), ...base, pricePerPackMinor: 10_000 },
      ],
    });
    expect(ranking[0]!.quoteId).toBe('q_live');
    expect(ranking[1]!.reasons).toContainEqual('Quote validity has lapsed.');
  });

  it('costs an MOQ that overshoots the requirement and flags it', () => {
    const [row] = compareQuotes({
      requiredPacks: 4,
      at: NOW,
      candidates: [
        {
          quoteId: 'q_moq',
          ...supplier('s_1', 'Bulk only'),
          ...base,
          moqPacks: 10,
          pricePerPackMinor: 5_000,
        },
      ],
    });
    expect(row!.packsForRequirement).toBe(10);
    expect(row!.reasons).toContainEqual(
      'Minimum order quantity 10 packs exceeds the 4 packs required.'
    );
  });

  it('breaks a unit-cost tie by lead time, then by shelf life', () => {
    const ranking = compareQuotes({
      requiredPacks: 10,
      at: NOW,
      candidates: [
        {
          quoteId: 'q_slow',
          ...supplier('s_1', 'Slow'),
          ...base,
          leadTimeDays: 9,
          pricePerPackMinor: 10_000,
        },
        {
          quoteId: 'q_fast_short',
          ...supplier('s_2', 'Fast, short dated'),
          ...base,
          leadTimeDays: 2,
          minimumExpiryDays: 90,
          pricePerPackMinor: 10_000,
        },
        {
          quoteId: 'q_fast_long',
          ...supplier('s_3', 'Fast, long dated'),
          ...base,
          leadTimeDays: 2,
          minimumExpiryDays: 720,
          pricePerPackMinor: 10_000,
        },
      ],
    });
    expect(ranking.map((row) => row.quoteId)).toEqual(['q_fast_long', 'q_fast_short', 'q_slow']);
  });

  it('rejects a comparison against a non-positive requirement', () =>
    expect(() => compareQuotes({ requiredPacks: 0, at: NOW, candidates: [] })).toThrow(
      'INVALID_QUANTITY'
    ));
});
