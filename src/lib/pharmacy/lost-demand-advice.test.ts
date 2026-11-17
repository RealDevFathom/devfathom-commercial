import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOST_DEMAND_TRIGGERS,
  buildLostDemandAdvice,
  evaluateLostDemandTriggers,
  isAdviceSuppressed,
  lostDemandTriggerConfigSchema,
  resolveLostDemandTriggerConfig,
  suggestTransfer,
  suggestedOrderQuantity,
  walkOutRateBps,
  type DistributorFact,
  type LostDemandEventFact,
  type LostDemandTriggerConfig,
} from './lost-demand-advice';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

function event(overrides: Partial<LostDemandEventFact> = {}): LostDemandEventFact {
  return {
    id: `e_${Math.random()}`,
    createdAt: daysAgo(1),
    demandKey: 'sku:med_a',
    medicineId: 'med_a',
    label: 'Brand A 500 mg',
    canonicalUnits: 10,
    estimatedValueMinor: 10_000,
    walkOut: false,
    ...overrides,
  };
}

const QUIET_VISITS = { completedSales: 100, walkOuts: 0 };

describe('trigger configuration', () => {
  it('uses the research figures only as defaults', () => {
    expect(resolveLostDemandTriggerConfig(null)).toEqual(DEFAULT_LOST_DEMAND_TRIGGERS);
    expect(DEFAULT_LOST_DEMAND_TRIGGERS).toMatchObject({
      requestCountThreshold: 3,
      requestWindowDays: 7,
      estimatedLossThresholdMinor: 1_000_000,
      lossWindowDays: 30,
      walkOutRateThresholdBps: 1_000,
    });
  });

  it('lets a branch override every value', () => {
    const stored = { requestCountThreshold: 5, safetyStockDays: 2 };
    expect(resolveLostDemandTriggerConfig(stored)).toEqual({
      ...DEFAULT_LOST_DEMAND_TRIGGERS,
      ...stored,
    });
  });

  it('rejects impossible thresholds', () => {
    expect(
      lostDemandTriggerConfigSchema.safeParse({
        ...DEFAULT_LOST_DEMAND_TRIGGERS,
        requestCountThreshold: 0,
      }).success
    ).toBe(false);
    expect(resolveLostDemandTriggerConfig({ walkOutRateThresholdBps: 20_000 } as never)).toEqual(
      DEFAULT_LOST_DEMAND_TRIGGERS
    );
  });
});

describe('evaluateLostDemandTriggers', () => {
  const config = DEFAULT_LOST_DEMAND_TRIGGERS;

  it('fires on 3 requests in 7 days and not on 2', () => {
    const two = [event({ estimatedValueMinor: 1 }), event({ estimatedValueMinor: 1 })];
    expect(evaluateLostDemandTriggers(two, QUIET_VISITS, config, NOW)).toEqual([]);
    const three = [...two, event({ estimatedValueMinor: 1 })];
    const [result] = evaluateLostDemandTriggers(three, QUIET_VISITS, config, NOW);
    expect(result).toMatchObject({ demandKey: 'sku:med_a', requestCount: 3 });
    expect(result!.fired).toEqual(['REQUEST_COUNT']);
  });

  it('ignores requests older than the request window for the count', () => {
    const events = [
      event({ createdAt: daysAgo(8), estimatedValueMinor: 1 }),
      event({ createdAt: daysAgo(9), estimatedValueMinor: 1 }),
      event({ estimatedValueMinor: 1 }),
    ];
    expect(evaluateLostDemandTriggers(events, QUIET_VISITS, config, NOW)).toEqual([]);
  });

  it('fires on the estimated loss over 30 days and leaves unvalued requests out', () => {
    const events = [
      event({ createdAt: daysAgo(20), estimatedValueMinor: 600_000 }),
      event({ createdAt: daysAgo(25), estimatedValueMinor: 400_000 }),
      event({ createdAt: daysAgo(10), estimatedValueMinor: null }),
      event({ createdAt: daysAgo(40), estimatedValueMinor: 900_000 }),
    ];
    const [result] = evaluateLostDemandTriggers(events, QUIET_VISITS, config, NOW);
    expect(result!.fired).toEqual(['ESTIMATED_LOSS']);
    expect(result).toMatchObject({ estimatedLossMinor: 1_000_000, unvaluedEvents: 1 });
    const below = events.map((row) =>
      row.estimatedValueMinor === 600_000 ? { ...row, estimatedValueMinor: 599_999 } : row
    );
    expect(evaluateLostDemandTriggers(below, QUIET_VISITS, config, NOW)).toEqual([]);
  });

  it('fires on a walk-out rate above 10% of visits only for groups with walk-outs', () => {
    const events = [
      event({ walkOut: true, estimatedValueMinor: 1 }),
      event({ demandKey: 'sku:med_b', medicineId: 'med_b', estimatedValueMinor: 1 }),
    ];
    expect(walkOutRateBps({ completedSales: 8, walkOuts: 2 })).toBe(2_000);
    const results = evaluateLostDemandTriggers(
      events,
      { completedSales: 8, walkOuts: 2 },
      config,
      NOW
    );
    expect(results.map((row) => [row.demandKey, row.fired])).toEqual([
      ['sku:med_a', ['WALK_OUT_RATE']],
    ]);
    // Exactly 10% does not exceed the threshold.
    expect(
      evaluateLostDemandTriggers(events, { completedSales: 9, walkOuts: 1 }, config, NOW)
    ).toEqual([]);
    expect(walkOutRateBps({ completedSales: 0, walkOuts: 0 })).toBeNull();
  });

  it('follows each branch configuration', () => {
    const strict: LostDemandTriggerConfig = {
      ...config,
      requestCountThreshold: 1,
      requestWindowDays: 2,
    };
    const events = [event({ createdAt: daysAgo(1), estimatedValueMinor: 1 })];
    expect(evaluateLostDemandTriggers(events, QUIET_VISITS, strict, NOW)[0]!.fired).toEqual([
      'REQUEST_COUNT',
    ]);
    const loose: LostDemandTriggerConfig = { ...config, requestCountThreshold: 10 };
    const many = Array.from({ length: 9 }, () => event({ estimatedValueMinor: 1 }));
    expect(evaluateLostDemandTriggers(many, QUIET_VISITS, loose, NOW)).toEqual([]);
  });
});

describe('suggestedOrderQuantity', () => {
  it('is forecast over lead time + safety stock - on-hand - on-order, in whole packs', () => {
    const result = suggestedOrderQuantity({
      dailyDemandUnits: 10,
      leadTimeDays: 5,
      safetyStockUnits: 30,
      onHandUnits: 12,
      onOrderUnits: 8,
      canonicalUnitsPerPack: 10,
    });
    // 50 + 30 - 12 - 8 = 60 units → 6 packs
    expect(result).toEqual({
      forecastLeadTimeUnits: 50,
      netRequiredUnits: 60,
      requiredPacks: 6,
      orderedPacks: 6,
      bonusPacks: 0,
      suppliedUnits: 60,
    });
  });

  it('rounds a part pack up and never goes below zero', () => {
    expect(
      suggestedOrderQuantity({
        dailyDemandUnits: 1.5,
        leadTimeDays: 3,
        safetyStockUnits: 0,
        onHandUnits: 0,
        onOrderUnits: 0,
        canonicalUnitsPerPack: 10,
      })
    ).toMatchObject({ forecastLeadTimeUnits: 5, netRequiredUnits: 5, requiredPacks: 1 });
    expect(
      suggestedOrderQuantity({
        dailyDemandUnits: 2,
        leadTimeDays: 3,
        safetyStockUnits: 4,
        onHandUnits: 100,
        onOrderUnits: 0,
        canonicalUnitsPerPack: 10,
      })
    ).toMatchObject({ netRequiredUnits: 0, orderedPacks: 0, bonusPacks: 0 });
  });

  it('rounds to the bonus scheme: the fewest paid packs whose paid + bonus cover the need', () => {
    const base = {
      leadTimeDays: 1,
      safetyStockUnits: 0,
      onHandUnits: 0,
      onOrderUnits: 0,
      canonicalUnitsPerPack: 1,
      scheme: { buyPacks: 10, bonusPacks: 1 },
    };
    expect(suggestedOrderQuantity({ ...base, dailyDemandUnits: 11 })).toMatchObject({
      orderedPacks: 10,
      bonusPacks: 1,
    });
    expect(suggestedOrderQuantity({ ...base, dailyDemandUnits: 12 })).toMatchObject({
      orderedPacks: 11,
      bonusPacks: 1,
    });
    expect(suggestedOrderQuantity({ ...base, dailyDemandUnits: 21 })).toMatchObject({
      orderedPacks: 20,
      bonusPacks: 2,
      suppliedUnits: 22,
    });
    expect(suggestedOrderQuantity({ ...base, dailyDemandUnits: 5 })).toMatchObject({
      orderedPacks: 5,
      bonusPacks: 0,
    });
    // Exhaustive: never under-supplies and never pays for an avoidable pack.
    for (let need = 1; need <= 60; need += 1) {
      const result = suggestedOrderQuantity({ ...base, dailyDemandUnits: need });
      expect(result.orderedPacks + result.bonusPacks).toBeGreaterThanOrEqual(need);
      const fewer = result.orderedPacks - 1;
      expect(fewer + Math.floor(fewer / 10)).toBeLessThan(need);
    }
  });

  it('refuses impossible inputs', () => {
    const base = {
      dailyDemandUnits: 1,
      leadTimeDays: 1,
      safetyStockUnits: 0,
      onHandUnits: 0,
      onOrderUnits: 0,
      canonicalUnitsPerPack: 1,
    };
    expect(() => suggestedOrderQuantity({ ...base, canonicalUnitsPerPack: 0 })).toThrow(RangeError);
    expect(() => suggestedOrderQuantity({ ...base, onHandUnits: -1 })).toThrow(RangeError);
    expect(() => suggestedOrderQuantity({ ...base, dailyDemandUnits: Number.NaN })).toThrow(
      RangeError
    );
  });
});

describe('suggestTransfer', () => {
  it('picks the branch with the largest surplus above its own cover', () => {
    const donors = [
      { branchId: 'b1', branchName: 'North', availableUnits: 50, dailyDemandUnits: 5 },
      { branchId: 'b2', branchName: 'South', availableUnits: 80, dailyDemandUnits: 2 },
      { branchId: 'b3', branchName: 'East', availableUnits: 5, dailyDemandUnits: 1 },
    ];
    expect(suggestTransfer(donors, 30, 10)).toEqual({
      fromBranchId: 'b2',
      fromBranchName: 'South',
      surplusUnits: 60,
      quantityUnits: 30,
    });
  });

  it('measures each donor against its own cover when it has one', () => {
    const donors = [
      {
        branchId: 'b2',
        branchName: 'South',
        availableUnits: 250,
        dailyDemandUnits: 10,
        coverageDays: 30,
      },
    ];
    expect(suggestTransfer(donors, 150, 10)).toBeNull();
    expect(suggestTransfer([{ ...donors[0]!, coverageDays: undefined }], 150, 10)).toMatchObject({
      surplusUnits: 150,
    });
  });

  it('suggests nothing without surplus or need', () => {
    const donors = [{ branchId: 'b1', branchName: 'N', availableUnits: 10, dailyDemandUnits: 1 }];
    expect(suggestTransfer(donors, 5, 10)).toBeNull();
    expect(suggestTransfer(donors, 0, 1)).toBeNull();
  });
});

describe('buildLostDemandAdvice', () => {
  const trigger = evaluateLostDemandTriggers(
    [event(), event(), event({ walkOut: true, estimatedValueMinor: null })],
    QUIET_VISITS,
    DEFAULT_LOST_DEMAND_TRIGGERS,
    NOW
  )[0]!;
  const distributor = (overrides: Partial<DistributorFact> = {}): DistributorFact => ({
    supplierId: 'sup_a',
    supplierName: 'Alpha Distributors',
    medicineId: 'med_a',
    packLevelId: 'pack_a',
    canonicalUnitsPerPack: 10,
    lastListPricePerPackMinor: 50_000,
    lastDiscountBps: 1_000,
    lastOrderedAt: daysAgo(30),
    scheme: { buyPacks: 10, bonusPacks: 1 },
    leadTimeDays: 2,
    ...overrides,
  });

  const advice = buildLostDemandAdvice({
    trigger,
    config: DEFAULT_LOST_DEMAND_TRIGGERS,
    medicineId: 'med_a',
    dailyDemandUnits: 10,
    onHandUnits: 5,
    onOrderUnits: 0,
    distributors: [
      distributor(),
      distributor({
        supplierId: 'sup_b',
        supplierName: 'Beta Pharma',
        lastListPricePerPackMinor: 40_000,
        lastDiscountBps: 0,
        scheme: null,
        leadTimeDays: null,
      }),
      distributor({ supplierId: 'sup_x', medicineId: 'other' }),
    ],
    alternates: [
      { medicineId: 'alt_low', label: 'Low', availableUnits: 3, marginPerUnitMinor: 100 },
      { medicineId: 'alt_none', label: 'None', availableUnits: 0, marginPerUnitMinor: null },
      { medicineId: 'alt_high', label: 'High', availableUnits: 9, marginPerUnitMinor: 900 },
    ],
    donors: [{ branchId: 'b2', branchName: 'South', availableUnits: 500, dailyDemandUnits: 1 }],
    currency: 'PKR',
  });

  it('computes each distributor with its own lead time, scheme and last price', () => {
    expect(advice.safetyStockUnits).toBe(70);
    const alpha = advice.distributors.find((row) => row.supplierId === 'sup_a')!;
    // 20 + 70 - 5 = 85 units → 9 packs → scheme 10+1 → pay 9
    expect(alpha).toMatchObject({
      leadTimeSource: 'RECORDED',
      effectiveLeadTimeDays: 2,
      quantity: { netRequiredUnits: 85, requiredPacks: 9, orderedPacks: 9, bonusPacks: 0 },
      estimatedCostMinor: 405_000,
    });
    const beta = advice.distributors.find((row) => row.supplierId === 'sup_b')!;
    // default lead time 3: 30 + 70 - 5 = 95 → 10 packs at 400.00
    expect(beta).toMatchObject({
      leadTimeSource: 'CONFIGURED_DEFAULT',
      effectiveLeadTimeDays: 3,
      quantity: { orderedPacks: 10 },
      estimatedCostMinor: 400_000,
    });
    expect(advice.distributors.map((row) => row.supplierId)).toEqual(['sup_b', 'sup_a']);
  });

  it('lists same-salt alternates by margin and offers a transfer from surplus', () => {
    expect(advice.alternates.map((row) => row.medicineId)).toEqual([
      'alt_high',
      'alt_low',
      'alt_none',
    ]);
    expect(advice.transfer).toMatchObject({ fromBranchId: 'b2', quantityUnits: 95 });
  });

  it('offers only draft actions, built from real computed values', () => {
    expect(advice.actions).toEqual(['DRAFT_PURCHASE_ORDER', 'TRANSFER_REQUEST', 'IGNORE']);
    expect(advice.draftOnly).toBe(true);
    expect(advice.summary).toContain('3 requests in 7 days');
    expect(advice.summary).toContain('10 pack(s) from Beta Pharma, about PKR 4,000');
    expect(advice.summary).toContain('South has 490 surplus unit(s)');
    expect(advice.limitations.join(' ')).toMatch(/1 lost request\(s\) have no recorded value/);
    expect(advice.limitations.join(' ')).toMatch(/branch default/);
  });

  it('only offers Ignore for a request that matches no catalogue item', () => {
    const unknown = buildLostDemandAdvice({
      trigger: { ...trigger, demandKey: 'text:something|', medicineIds: [] },
      config: DEFAULT_LOST_DEMAND_TRIGGERS,
      medicineId: null,
      dailyDemandUnits: 0,
      onHandUnits: 0,
      onOrderUnits: 0,
      distributors: [distributor()],
      alternates: [],
      donors: [{ branchId: 'b2', branchName: 'South', availableUnits: 500, dailyDemandUnits: 0 }],
      currency: 'PKR',
    });
    expect(unknown.actions).toEqual(['IGNORE']);
    expect(unknown.distributors).toEqual([]);
    expect(unknown.transfer).toBeNull();
  });
});

describe('isAdviceSuppressed', () => {
  it('hides ignored advice until a newer request arrives', () => {
    expect(isAdviceSuppressed({ latestEventAt: daysAgo(2) }, daysAgo(1))).toBe(true);
    expect(isAdviceSuppressed({ latestEventAt: daysAgo(1) }, daysAgo(2))).toBe(false);
    expect(isAdviceSuppressed({ latestEventAt: daysAgo(1) }, null)).toBe(false);
  });
});
