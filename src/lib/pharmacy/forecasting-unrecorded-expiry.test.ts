/**
 * DEV-853 — the replenishment scenario simulation counts legacy stock whose
 * expiry was never recorded as sellable on-hand stock that never expires, and
 * still excludes stock whose KNOWN expiry has passed.
 */
import { describe, expect, it } from 'vitest';

import { demandDateAfter, type DemandEvidenceDay } from './demand-evidence';
import { simulateReplenishmentDecision, type DecisionStockLot } from './forecasting';

const scope = { organizationId: 'org', branchId: 'branch', medicineId: 'med' };
const source = {
  kind: 'SYNTHETIC_FIXTURE' as const,
  reference: 'DEV-853 fixture',
  asOf: '2026-01-01T00:00:00Z',
};

/** A flat 10 units a day through 2025. */
function history(): DemandEvidenceDay[] {
  return Array.from({ length: 365 }, (_, i) => {
    const date = demandDateAfter('2025-01-01', i);
    return { date, knownAt: `${date}T23:00:00Z`, state: 'OBSERVED' as const, units: 10 };
  });
}

function lot(overrides: Partial<DecisionStockLot>): DecisionStockLot {
  return {
    inventoryLotId: 'lot',
    stockLocationId: 'shelf',
    organizationId: 'org',
    branchId: 'branch',
    medicineId: 'med',
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    expiresAt: null,
    receivedAt: new Date('2025-06-01T00:00:00Z'),
    availableUnits: 20,
    ...overrides,
  };
}

function simulate(stock: DecisionStockLot[]) {
  return simulateReplenishmentDecision({
    demand: {
      scope,
      source,
      originDate: '2026-01-01',
      historyStartDate: '2025-01-01',
      horizonDays: 5,
      method: 'RECENT_MEAN',
      days: history(),
    },
    currency: 'PKR',
    inventorySource: { kind: 'SYNTHETIC_FIXTURE', reference: 'fixture', asOf: source.asOf },
    stock,
    inbound: [],
    policies: { source: 'MANUAL_SCENARIO', currentQuantityUnits: 0, proposedQuantityUnits: 0 },
    orderTerms: {
      source,
      packSize: 1,
      minimumOrderUnits: 0,
      unitCostMinor: null,
      budgetMinor: null,
      storageLimitUnits: null,
      arrivalAt: null,
      expiresAt: null,
    },
  });
}

describe('DEV-853 replenishment simulation with unrecorded expiry', () => {
  it('draws unrecorded-expiry stock to meet demand and never expires it', () => {
    const decision = simulate([lot({ inventoryLotId: 'legacy', availableUnits: 20 })]);
    expect(decision.excludedStock).toEqual([]);
    const outcome = decision.scenarios.find((row) => row.policy === 'NO_ORDER')!.outcome!;
    expect(outcome.demandUnits).toBeGreaterThan(20);
    expect(outcome.fulfilledUnits).toBe(20);
    expect(outcome.expiredUnits).toBe(0);
    expect(outcome.shortageUnits).toBe(outcome.demandUnits - 20);
  });

  it('still excludes stock whose known expiry has passed, and uses known expiry first', () => {
    const decision = simulate([
      lot({ inventoryLotId: 'legacy', availableUnits: 20 }),
      lot({
        inventoryLotId: 'dated',
        availableUnits: 5,
        expiresAt: new Date('2027-01-01T00:00:00Z'),
      }),
      lot({
        inventoryLotId: 'expired',
        availableUnits: 7,
        expiresAt: new Date('2025-12-01T00:00:00Z'),
      }),
    ]);
    expect(decision.excludedStock).toEqual([
      { inventoryLotId: 'expired', stockLocationId: 'shelf', reason: 'EXPIRED' },
    ]);
    const scenario = decision.scenarios.find((row) => row.policy === 'NO_ORDER')!;
    expect(scenario.outcome!.fulfilledUnits).toBe(25);
    expect(scenario.allocations[0]).toMatchObject({ inventoryLotId: 'dated' });
  });
});
