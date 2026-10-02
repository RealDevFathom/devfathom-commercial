import { describe, expect, it } from 'vitest';
import {
  approveForecastDraft,
  compareReplenishment,
  forecastSettingForOrganization,
  type ForecastFixtureLine,
  simulateReplenishmentDecision,
  type DecisionStockLot,
  type ReplenishmentDecisionInput,
} from './forecasting';

const fixture: ForecastFixtureLine = {
  medicineId: 'medicine-a',
  demandUnits: 300,
  demandWindowDays: 30,
  seasonalityBps: 12_000,
  leadTimeDays: 10,
  fillRateBps: 8_000,
  openPurchaseOrderUnits: 20,
  openTransferUnits: 10,
  onHandUnits: 40,
  expiringBeforeLeadTimeUnits: 10,
  packSize: 10,
  cashLimitUnits: 200,
  storageLimitUnits: 150,
  unfulfilledDemandUnits: 12,
  deterministicSafetyStockUnits: 140,
  suppliers: [
    { supplierId: 'supplier-slow', unitCostMinor: 12, leadTimeDays: 5, fillRateBps: 9_000 },
    { supplierId: 'supplier-value', unitCostMinor: 10, leadTimeDays: 7, fillRateBps: 8_500 },
  ],
  branches: [
    { branchId: 'branch-short', availableUnits: 10, forecastDemandUnits: 50, safetyStockUnits: 10 },
    {
      branchId: 'branch-dead-stock',
      availableUnits: 100,
      forecastDemandUnits: 20,
      safetyStockUnits: 20,
    },
  ],
};

describe('PUR-09 comparison harness', () => {
  it('runs both methods on one window but keeps PUR-07 selected by default', () => {
    const result = compareReplenishment(
      [fixture],
      forecastSettingForOrganization('organization-a')
    );
    expect(result).toMatchObject({
      forecastingEnabled: false,
      selectedSource: 'DETERMINISTIC_BASELINE',
      deterministicBaseline: [{ medicineId: 'medicine-a', quantityUnits: 70 }],
      drafts: [],
      rebalanceDrafts: [],
    });
    expect(result.forecast[0]).toMatchObject({
      medicineId: 'medicine-a',
      forecastQuantityUnits: 110,
      deterministicBaselineUnits: 70,
      estimate: { label: 'ESTIMATE', windowDays: 30, confidence: 'MEDIUM' },
    });
  });

  it('names every required input, compares suppliers, and emits DRAFT documents only', () => {
    const result = compareReplenishment([fixture], {
      organizationId: 'organization-a',
      enabled: true,
    });
    expect(result.forecast[0]!.reasons.map((reason) => reason.input)).toEqual([
      'DEMAND_VELOCITY',
      'SEASONALITY',
      'LEAD_TIME_AND_FILL_HISTORY',
      'OPEN_INBOUND',
      'EXPIRY_RISK',
      'PACK_ROUNDING',
      'CASH_AND_STORAGE_CONSTRAINTS',
      'UNFULFILLED_DEMAND',
    ]);
    expect(result.forecast[0]!.supplierComparison.map((supplier) => supplier.supplierId)).toEqual([
      'supplier-value',
      'supplier-slow',
    ]);
    expect(result.drafts[0]).toMatchObject({ documentType: 'REQUISITION', status: 'DRAFT' });
    expect(result.rebalanceDrafts[0]).toMatchObject({
      documentType: 'TRANSFER',
      status: 'DRAFT',
      fromBranchId: 'branch-dead-stock',
      toBranchId: 'branch-short',
      quantityUnits: 50,
      estimate: { label: 'ESTIMATE' },
    });
  });
});

const decisionSource = {
  kind: 'SYNTHETIC_FIXTURE' as const,
  reference: 'decision-unit-test',
  asOf: '2026-09-12T00:00:00Z',
};
const decisionLot = (
  inventoryLotId: string,
  availableUnits: number,
  expiresAt = '2026-10-01T00:00:00Z'
): DecisionStockLot => ({
  inventoryLotId,
  stockLocationId: 'shelf',
  medicineId: 'medicine-a',
  organizationId: 'organization-a',
  branchId: 'branch-a',
  availableUnits,
  expiresAt: new Date(expiresAt),
  receivedAt: new Date('2026-09-01T00:00:00Z'),
  batchState: 'ACTIVE',
  disposition: 'AVAILABLE',
});
const decisionInput = (): ReplenishmentDecisionInput => ({
  demand: {
    scope: { organizationId: 'organization-a', branchId: 'branch-a', medicineId: 'medicine-a' },
    source: decisionSource,
    originDate: '2026-09-12',
    historyStartDate: '2026-09-10',
    horizonDays: 2,
    method: 'RECENT_MEAN',
    days: [
      { date: '2026-09-10', knownAt: '2026-09-11T00:00:00Z', state: 'OBSERVED', units: 4 },
      { date: '2026-09-11', knownAt: '2026-09-12T00:00:00Z', state: 'OBSERVED', units: 4 },
    ],
  },
  currency: 'PKR',
  inventorySource: decisionSource,
  stock: [decisionLot('expiring', 5, '2026-09-13T00:00:00Z'), decisionLot('good', 5)],
  inbound: [],
  policies: { source: 'MANUAL_SCENARIO', currentQuantityUnits: 0, proposedQuantityUnits: 12 },
  orderTerms: {
    source: decisionSource,
    packSize: 6,
    minimumOrderUnits: 0,
    unitCostMinor: 10,
    budgetMinor: 100,
    storageLimitUnits: 100,
    arrivalAt: '2026-09-12T00:00:00Z',
    expiresAt: '2026-10-01T00:00:00Z',
  },
});

describe('evidence-aware replenishment decision', () => {
  it('fulfills [4,4] through canonical dated FEFO: eight fulfilled, one expired, one remaining', () => {
    const result = simulateReplenishmentDecision(decisionInput());
    const scenario = result.scenarios[0]!;
    expect(scenario.outcome).toEqual({
      demandUnits: 8,
      fulfilledUnits: 8,
      shortageUnits: 0,
      expiredUnits: 1,
      endingStockUnits: 1,
      pendingInboundUnits: 0,
    });
    expect(
      scenario.allocations.map((allocation) => [allocation.inventoryLotId, allocation.units])
    ).toEqual([
      ['expiring', 4],
      ['good', 4],
    ]);
    expect(scenario.order.committedCashMinor).toBe(0);
    expect(result.money).toMatchObject({
      currency: 'PKR',
      scale: 'MINOR_UNITS',
      period: { startDate: '2026-09-12', endDateExclusive: '2026-09-14' },
      scope: decisionInput().demand.scope,
      source: decisionSource,
      coverage: 'SUPPLIED_ORDER_TERMS_ONLY',
    });
    expect(result.approvalRequired).toBe(true);
  });

  it('caps pack-six, unit-cost-ten, budget-one-hundred at one pack', () => {
    const result = simulateReplenishmentDecision(decisionInput());
    expect(result.scenarios[2]!.order).toMatchObject({
      status: 'CONSTRAINED',
      requestedUnits: 12,
      quantityUnits: 6,
      committedCashMinor: 60,
    });
  });

  it('makes MOQ twelve infeasible when only one six-pack is affordable', () => {
    const input = decisionInput();
    input.orderTerms.minimumOrderUnits = 12;
    const result = simulateReplenishmentDecision(input);
    expect(result.scenarios[2]!.order).toMatchObject({
      status: 'INFEASIBLE',
      quantityUnits: 0,
      committedCashMinor: 0,
    });
    expect(result.scenarios[2]!.outcome).toEqual(result.scenarios[0]!.outcome);
  });

  it('raises a nonzero request to pack-rounded MOQ, while zero remains no order', () => {
    const input = decisionInput();
    input.policies = {
      source: 'MANUAL_SCENARIO',
      currentQuantityUnits: 0,
      proposedQuantityUnits: 1,
    };
    input.orderTerms.minimumOrderUnits = 7;
    input.orderTerms.budgetMinor = 200;
    const result = simulateReplenishmentDecision(input);
    expect(result.scenarios[2]!.order).toMatchObject({
      quantityUnits: 12,
      committedCashMinor: 120,
    });
    expect(result.scenarios[1]!.order.quantityUnits).toBe(0);
  });

  it('does not let day-three inbound cover earlier shortages', () => {
    const input = decisionInput();
    input.stock = [];
    input.demand.horizonDays = 3;
    input.inbound = [
      {
        id: 'po',
        confirmed: true,
        knownAt: decisionSource.asOf,
        arrivalAt: '2026-09-14T00:00:00Z',
        lot: decisionLot('inbound', 12),
      },
    ];
    const result = simulateReplenishmentDecision(input).scenarios[0]!;
    expect(result.days.map((day) => day.shortageUnits)).toEqual([4, 4, 0]);
    expect(result.outcome).toMatchObject({
      fulfilledUnits: 4,
      shortageUnits: 8,
      endingStockUnits: 8,
    });
  });

  it('respects intraday arrivals and the end-exclusive receipt boundary', () => {
    const input = decisionInput();
    input.stock = [];
    input.inbound = [
      {
        id: 'midday',
        confirmed: true,
        knownAt: decisionSource.asOf,
        arrivalAt: '2026-09-12T12:00:00Z',
        lot: decisionLot('midday', 4),
      },
      {
        id: 'closing',
        confirmed: true,
        knownAt: decisionSource.asOf,
        arrivalAt: '2026-09-14T00:00:00Z',
        lot: decisionLot('closing', 7),
      },
    ];
    const result = simulateReplenishmentDecision(input).scenarios[0]!;
    expect(result.days.map((day) => day.fulfilledUnits)).toEqual([0, 4]);
    expect(result.outcome).toMatchObject({
      shortageUnits: 4,
      pendingInboundUnits: 7,
      endingStockUnits: 0,
    });
  });

  it('excludes unconfirmed, late-known and unknown-arrival inbound', () => {
    const input = decisionInput();
    input.stock = [];
    input.inbound = [
      {
        id: 'a',
        confirmed: false,
        knownAt: decisionSource.asOf,
        arrivalAt: decisionSource.asOf,
        lot: decisionLot('a', 100),
      },
      {
        id: 'b',
        confirmed: true,
        knownAt: '2026-09-13T00:00:00Z',
        arrivalAt: decisionSource.asOf,
        lot: decisionLot('b', 100),
      },
      {
        id: 'c',
        confirmed: true,
        knownAt: decisionSource.asOf,
        arrivalAt: null,
        lot: decisionLot('c', 100),
      },
    ];
    const result = simulateReplenishmentDecision(input);
    expect(result.excludedInbound.map((row) => row.reason)).toEqual([
      'UNCONFIRMED',
      'NOT_KNOWN_AT_ORIGIN',
      'UNKNOWN_ARRIVAL',
    ]);
    expect(result.scenarios[0]!.outcome!.shortageUnits).toBe(8);
  });

  it('uses inventory provenance for inbound availability independently of demand provenance', () => {
    const input = decisionInput();
    input.stock = [];
    input.demand.source = { ...decisionSource, asOf: '2026-09-11T00:00:00Z' };
    input.inbound = [
      {
        id: 'po',
        confirmed: true,
        knownAt: '2026-09-11T12:00:00Z',
        arrivalAt: decisionSource.asOf,
        lot: decisionLot('receipt', 8),
      },
    ];
    expect(simulateReplenishmentDecision(input).scenarios[0]!.outcome!.fulfilledUnits).toBe(8);
    input.inventorySource = { ...decisionSource, asOf: '2026-09-11T00:00:00Z' };
    const olderInventory = simulateReplenishmentDecision(input);
    expect(olderInventory.excludedInbound[0]!.reason).toBe('NOT_KNOWN_AT_ORIGIN');
    expect(olderInventory.scenarios[0]!.outcome!.fulfilledUnits).toBe(0);
  });

  it('blocks quarantined, recalled, expired, unreceived and unknown-expiry lots', () => {
    const input = decisionInput();
    input.stock = [
      { ...decisionLot('quarantine', 100), disposition: 'QUARANTINE' },
      { ...decisionLot('recall', 100), batchState: 'RECALLED' },
      decisionLot('expired', 100, decisionSource.asOf),
      { ...decisionLot('unreceived', 100), receivedAt: null },
      { ...decisionLot('unknown', 100), expiresAt: null },
    ];
    const result = simulateReplenishmentDecision(input);
    expect(result.excludedStock.map((lot) => lot.reason)).toEqual([
      'QUARANTINED',
      'RECALLED',
      'EXPIRED',
      'UNRECEIVED',
      'UNKNOWN_EXPIRY',
    ]);
    expect(result.scenarios[0]!.outcome).toMatchObject({
      fulfilledUnits: 0,
      shortageUnits: 8,
      expiredUnits: 0,
      endingStockUnits: 0,
    });
  });

  it('uses canonical receipt/id ties and does not mutate input across repeated calls', () => {
    const input = decisionInput();
    input.stock = [decisionLot('b', 5), decisionLot('a', 5)];
    const before = JSON.stringify(input);
    const first = simulateReplenishmentDecision(input);
    expect(first.scenarios[0]!.allocations.map((allocation) => allocation.inventoryLotId)).toEqual([
      'a',
      'a',
      'b',
    ]);
    expect(simulateReplenishmentDecision(input)).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('reports closing-boundary expiry as exposure rather than ending usable stock', () => {
    const input = decisionInput();
    input.stock = [decisionLot('closing', 10, '2026-09-14T00:00:00Z')];
    const result = simulateReplenishmentDecision(input).scenarios[0]!;
    expect(result.outcome).toMatchObject({
      fulfilledUnits: 8,
      expiredUnits: 2,
      endingStockUnits: 0,
    });
    expect(result.days[1]).toMatchObject({ expiredUnits: 2, endingStockUnits: 0 });
  });

  it('does not invent outcomes for unknown demand, cost, arrival or expiry', () => {
    const noHistory = decisionInput();
    noHistory.demand.days = [];
    expect(
      simulateReplenishmentDecision(noHistory).scenarios.every(
        (scenario) => scenario.outcome === null
      )
    ).toBe(true);
    for (const field of [
      'unitCostMinor',
      'budgetMinor',
      'storageLimitUnits',
      'arrivalAt',
      'expiresAt',
    ] as const) {
      const input = decisionInput();
      input.orderTerms[field] = null;
      const result = simulateReplenishmentDecision(input);
      expect(result.scenarios[2]!.outcome).toBeNull();
      expect(result.scenarios[2]!.order.status).toBe('UNKNOWN');
      expect(result.scenarios[0]!.outcome).not.toBeNull();
      if (field === 'unitCostMinor')
        expect(result.scenarios[2]!.order.committedCashMinor).toBeNull();
    }
  });

  it('reuses existing comparison quantities and preserves disabled forecast selection', () => {
    const input = decisionInput();
    input.policies = {
      source: 'EXISTING_COMPARISON',
      comparison: compareReplenishment([fixture], forecastSettingForOrganization('organization-a')),
    };
    const result = simulateReplenishmentDecision(input);
    expect(result.selectedSource).toBe('DETERMINISTIC_BASELINE');
    expect(result.scenarios.map((scenario) => scenario.order.requestedUnits)).toEqual([0, 70, 110]);
    expect(result.unknowns).toContain(
      'Policy quantities come from the existing fixture comparison, not a verified live demand adapter.'
    );
    expect('drafts' in result).toBe(false);
  });

  it('rejects cross-organization, cross-branch and cross-medicine stock', () => {
    for (const field of ['organizationId', 'branchId', 'medicineId'] as const) {
      const input = decisionInput();
      input.stock = [{ ...decisionLot('wrong', 100), [field]: 'other' }];
      expect(() => simulateReplenishmentDecision(input)).toThrow(
        'Stock scope does not match demand scope'
      );
    }
  });

  it('rejects duplicate stock/inbound, invalid quantities and unsafe aggregate units', () => {
    const duplicate = decisionInput();
    duplicate.stock = [decisionLot('same', 1), decisionLot('same', 2)];
    expect(() => simulateReplenishmentDecision(duplicate)).toThrow(
      'Duplicate or reserved stock identity'
    );
    const overlap = decisionInput();
    overlap.inbound = [
      {
        id: 'po',
        confirmed: true,
        knownAt: decisionSource.asOf,
        arrivalAt: decisionSource.asOf,
        lot: decisionLot('good', 5),
      },
    ];
    expect(() => simulateReplenishmentDecision(overlap)).toThrow(
      'Duplicate or reserved stock identity'
    );
    const unsafe = decisionInput();
    unsafe.stock = [decisionLot('max', Number.MAX_SAFE_INTEGER), decisionLot('extra', 1)];
    expect(() => simulateReplenishmentDecision(unsafe)).toThrow(
      'Demand units and totals must be non-negative safe integers'
    );
    const fractional = decisionInput();
    fractional.orderTerms.unitCostMinor = 0.1;
    expect(() => simulateReplenishmentDecision(fractional)).toThrow(RangeError);
  });

  it('rejects later source snapshots and a mismatched legacy comparison', () => {
    const future = decisionInput();
    future.inventorySource = { ...decisionSource, asOf: '2026-09-13T00:00:00Z' };
    expect(() => simulateReplenishmentDecision(future)).toThrow(
      'Decision source must be explicit and available at origin'
    );
    const wrong = decisionInput();
    wrong.policies = {
      source: 'EXISTING_COMPARISON',
      comparison: compareReplenishment([fixture], forecastSettingForOrganization('wrong')),
    };
    expect(() => simulateReplenishmentDecision(wrong)).toThrow(
      'Comparison must match organization and exactly one medicine'
    );
  });
});

describe('PUR-09 / invariant 29 approval property', () => {
  it('never turns any generated draft into an order without a distinct approver', () => {
    for (let seed = 1; seed <= 250; seed += 1) {
      const varied = {
        ...fixture,
        demandUnits: seed,
        unfulfilledDemandUnits: seed % 17,
        packSize: (seed % 12) + 1,
      };
      const draft = compareReplenishment([varied], {
        organizationId: 'organization-a',
        enabled: true,
      }).drafts[0]!;
      expect(draft.documentType).toBe('REQUISITION');
      expect(draft.status).toBe('DRAFT');
      expect(() => approveForecastDraft(draft, { createdById: `creator-${seed}` })).toThrowError(
        'APPROVER_REQUIRED'
      );
      expect(() =>
        approveForecastDraft(draft, { createdById: 'same-user', approverId: 'same-user' })
      ).toThrowError('SELF_APPROVAL');
      expect(
        approveForecastDraft(draft, { createdById: 'creator', approverId: 'approver' })
      ).toEqual({
        documentType: 'REQUISITION',
        status: 'APPROVED',
        approvedById: 'approver',
      });
    }
  });
});
