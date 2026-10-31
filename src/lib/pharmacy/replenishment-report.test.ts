import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { AllocationCandidate } from './inventory';
import {
  readPharmacyReplenishmentReport,
  type PharmacyReplenishmentReportReaderInput,
} from './replenishment-report';

const mocks = vi.hoisted(() => ({ stock: vi.fn() }));
vi.mock('./stock-ledger', () => ({ loadStockCandidatesForRead: mocks.stock }));

const readAt = new Date('2026-09-14T12:00:00Z');
const scope = { organizationId: 'org', branchId: 'branch', medicineId: 'medicine' };
const input: PharmacyReplenishmentReportReaderInput = {
  ...scope,
  authorizedBranchIds: ['branch'],
  financial: true,
  historyStartDate: '2026-09-10',
  originDate: '2026-09-13',
  horizonDays: 2,
  method: 'RECENT_MEAN',
};
const manualScenario = {
  originDate: '2026-09-15',
  dailyDemandUnits: 6,
  currentQuantityUnits: 0,
  proposedQuantityUnits: 12,
  currency: 'PKR',
  goals: { salesMinor: 18000, marginMinor: 6000 },
  pricing: { currentUnitPriceMinor: 1200, proposedUnitPriceMinor: 1500 },
  orderTerms: {
    packSize: 6,
    minimumOrderUnits: 0,
    unitCostMinor: 500,
    budgetMinor: 6000,
    storageLimitUnits: 12,
    arrivalAt: '2026-09-15T00:00:00Z',
    expiresAt: '2027-01-01T00:00:00Z',
  },
};
const lot: AllocationCandidate = {
  organizationId: 'org',
  branchId: 'branch',
  inventoryLotId: 'lot',
  stockLocationId: 'shelf',
  batchState: 'ACTIVE',
  disposition: 'AVAILABLE',
  availableUnits: 6,
  expiresAt: new Date('2027-01-01T00:00:00Z'),
  receivedAt: new Date('2026-09-01T00:00:00Z'),
};
function database() {
  const reads = {
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch', organizationId: 'org', active: true }),
    },
    pharmacySeasonalCalendarWindow: { findMany: vi.fn().mockResolvedValue([]) },
    medicineStrengthComponent: { findMany: vi.fn().mockResolvedValue([]) },
    medicine: { findFirst: vi.fn().mockResolvedValue({ id: 'medicine', organizationId: 'org' }) },
    pharmacySaleLine: {
      findMany: vi.fn().mockResolvedValue([
        {
          ...scope,
          id: 'line',
          canonicalUnits: 12,
          createdAt: new Date('2026-09-10T10:00:00Z'),
          sale: {
            organizationId: 'org',
            branchId: 'branch',
            status: 'COMPLETED',
            businessDate: new Date('2026-09-10T00:00:00Z'),
            completedAt: new Date('2026-09-10T10:00:00Z'),
            createdAt: new Date('2026-09-10T10:00:00Z'),
            updatedAt: new Date('2026-09-10T10:00:00Z'),
          },
        },
      ]),
    },
    unfulfilledDemandEvent: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'stockout',
          organizationId: 'org',
          branchId: 'branch',
          requestedMedicineId: 'medicine',
          reason: 'STOCKOUT',
          createdAt: new Date('2026-09-11T12:00:00Z'),
        },
      ]),
    },
    pharmacyPurchaseOrderLine: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyInterbranchTransferLine: { findMany: vi.fn().mockResolvedValue([]) },
    // An empty eligible-lot read still needs a scoped ledger observation.
    // This recorded zero does not establish complete stock or demand coverage.
    pharmacyStockBalance: {
      findFirst: vi.fn().mockResolvedValue({
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        onHandUnits: 0,
        lot: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          batch: { organizationId: scope.organizationId, medicineId: scope.medicineId },
        },
      }),
    },
  };
  const forbidden = vi.fn((key: PropertyKey): never => {
    throw new Error(`Unexpected DB access: ${String(key)}`);
  });
  const delegates = Object.fromEntries(
    Object.entries(reads).map(([key, value]) => [
      key,
      new Proxy(value, {
        get(target, property) {
          if (!(property in target)) return forbidden(property);
          return Reflect.get(target, property);
        },
      }),
    ])
  );
  const db = new Proxy(delegates, {
    get(target, property) {
      if (!(property in target)) return forbidden(property);
      return Reflect.get(target, property);
    },
  }) as unknown as ScopedDb;
  return { db, reads, forbidden };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(readAt);
  vi.clearAllMocks();
  mocks.stock.mockResolvedValue([lot]);
});
afterEach(() => vi.useRealTimers());

describe('live replenishment report composition', () => {
  it('joins real demand and supply readers without converting consumption into a forecast', async () => {
    const { db, reads, forbidden } = database();
    const result = await readPharmacyReplenishmentReport(db, input, readAt);
    expect(
      result.observations.demand.consumption.days.map((day) => day.observedCanonicalUnits)
    ).toEqual([12, null, null]);
    expect(result.observations.demand.coverage).toMatchObject({
      observedDemandDays: 0,
      unknownDays: 2,
      censoredDays: 1,
    });
    expect(
      result.observations.demand.days.every(
        (day) => day.estimatedDemandUnits === null && day.knownAt === null
      )
    ).toBe(true);
    expect(result.observations.supply.stock).toEqual([{ ...lot, medicineId: 'medicine' }]);
    expect(result.observations.supply.constraints).toEqual({
      budgetMinor: null,
      storageLimitUnits: null,
    });
    expect(result.forecast).toEqual({ status: 'INSUFFICIENT_EVIDENCE', result: null });
    expect(result.backtest).toMatchObject({ status: 'INELIGIBLE', result: null });
    expect(result.backtest.reasons).not.toHaveLength(0);
    expect(result.planning).toMatchObject({ status: 'NOT_REQUESTED', decision: null });
    expect(result.observations.demand.provenance.kind).toBe('OBSERVED_TRANSACTIONS');
    expect(result.observations.supply.inventorySource.asOf).toBe(readAt.toISOString());
    expect(reads.pharmacySaleLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(scope) })
    );
    expect(mocks.stock.mock.calls[0][0]).toBe(db);
    expect(mocks.stock.mock.calls[0].slice(1)).toEqual([scope, 'medicine']);
    expect(forbidden).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/patient|prescription|customer|forecastInput/);
  });

  it('keeps an empty demand period unknown despite a recorded zero stock balance', async () => {
    const { db, reads } = database();
    reads.pharmacySaleLine.findMany.mockResolvedValue([]);
    reads.unfulfilledDemandEvent.findMany.mockResolvedValue([]);
    mocks.stock.mockResolvedValue([]);
    const result = await readPharmacyReplenishmentReport(db, input, readAt);
    expect(result.observations.demand.consumption.observedCanonicalUnits).toBeNull();
    expect(result.observations.demand.coverage.unknownDays).toBe(3);
    expect(result.observations.supply.stock).toEqual([]);
    expect(result.forecast.result).toBeNull();
  });

  it('does not simulate an empty stock read as evidenced zero inventory', async () => {
    const { db } = database();
    mocks.stock.mockResolvedValue([]);
    const result = await readPharmacyReplenishmentReport(db, { ...input, manualScenario }, readAt);
    expect(result.observations.supplyCoverage).toMatchObject({
      status: 'UNKNOWN',
      recordedEligibleLots: 0,
    });
    expect(result.planning).toMatchObject({
      status: 'INSUFFICIENT_STOCK_EVIDENCE',
      decision: null,
    });
    expect(result.forecast.result).toBeNull();
  });

  it('refuses an empty stock read without a scoped ledger observation', async () => {
    const { db, reads } = database();
    mocks.stock.mockResolvedValue([]);
    reads.pharmacyStockBalance.findFirst.mockResolvedValue(null);
    await expect(readPharmacyReplenishmentReport(db, input, readAt)).rejects.toThrow(
      'Stock evidence is unavailable'
    );
  });

  it('runs the accepted engine only as separately labeled manual planning', async () => {
    const { db, forbidden } = database();
    const before = structuredClone(manualScenario);
    const result = await readPharmacyReplenishmentReport(db, { ...input, manualScenario }, readAt);
    expect(result.forecast.result).toBeNull();
    expect(result.backtest.result).toBeNull();
    expect(result.planning).toMatchObject({
      status: 'AVAILABLE',
      basis: 'USER_SUPPLIED_ASSUMPTIONS',
      dailyDemandUnits: 6,
    });
    const decision = result.planning.decision!;
    expect(decision).toMatchObject({
      label: 'CONDITIONAL_SCENARIO',
      policySource: 'MANUAL_SCENARIO',
      approvalRequired: true,
    });
    expect(decision.demand.source).toMatchObject({
      kind: 'MANUAL_SCENARIO',
      asOf: readAt.toISOString(),
    });
    expect(decision.inventorySource.kind).toBe('OBSERVED_TRANSACTIONS');
    expect(decision.scenarios[0].outcome).toMatchObject({
      demandUnits: 12,
      fulfilledUnits: 6,
      shortageUnits: 6,
    });
    expect(decision.scenarios[2].order.committedCashMinor).toBe(6000);
    expect(decision.scenarios[2].outcome).toMatchObject({ shortageUnits: 0, endingStockUnits: 6 });
    expect(result.planning.goalComparison).toEqual({
      label: 'ILLUSTRATIVE_ESTIMATE',
      definition:
        'Sales and margin estimates use fulfilled units and user-supplied unit prices and unit cost; they are not recorded or forecast results.',
      scenarios: [
        expect.objectContaining({
          policy: 'NO_ORDER',
          label: 'ESTIMATE',
          fulfilledUnits: 6,
          salesMinor: 7200,
          marginMinor: 4200,
          goals: expect.objectContaining({ salesMet: false, marginMet: false }),
        }),
        expect.objectContaining({
          policy: 'CURRENT',
          salesMinor: 7200,
          marginMinor: 4200,
        }),
        expect.objectContaining({
          policy: 'PROPOSED',
          fulfilledUnits: 12,
          salesMinor: 18000,
          marginMinor: 12000,
          goals: expect.objectContaining({ salesMet: true, marginMet: true }),
        }),
      ],
    });
    expect(result.observations.demand.coverage.observedDemandDays).toBe(0);
    expect(result.limitations.join(' ')).toContain('not empirical performance');
    expect(manualScenario).toEqual(before);
    expect(lot.availableUnits).toBe(6);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('redacts all manual quantities, terms and financial outputs without financial authority', async () => {
    const { db } = database();
    const result = await readPharmacyReplenishmentReport(
      db,
      { ...input, financial: false, manualScenario },
      readAt
    );
    expect(result.permissions.financial).toBe(false);
    expect(result.planning).toEqual({
      status: 'REDACTED',
      basis: 'USER_SUPPLIED_ASSUMPTIONS',
      dailyDemandUnits: null,
      decision: null,
      goalComparison: null,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /6000|500|PKR|committedCashMinor|unitCostMinor|orderTerms/
    );
    expect(result.observations.supply.stock).toHaveLength(1);
  });

  it('keeps unknown planning constraints unknown and separate from observed supply', async () => {
    const { db } = database();
    const result = await readPharmacyReplenishmentReport(
      db,
      {
        ...input,
        manualScenario: {
          ...manualScenario,
          orderTerms: { ...manualScenario.orderTerms, budgetMinor: null, arrivalAt: null },
        },
      },
      readAt
    );
    expect(result.planning.decision!.scenarios[2]).toMatchObject({
      order: { status: 'UNKNOWN', quantityUnits: null, committedCashMinor: null },
      outcome: null,
    });
    expect(result.observations.supply.constraints.budgetMinor).toBeNull();
  });

  it('retains excluded stock and unknown inbound rather than treating them as available', async () => {
    const { db, reads } = database();
    mocks.stock.mockResolvedValue([{ ...lot, disposition: 'QUARANTINED' }]);
    reads.pharmacyPurchaseOrderLine.findMany.mockResolvedValue([
      {
        id: 'po-line',
        organizationId: 'org',
        medicineId: 'medicine',
        orderedCanonicalUnits: 10,
        bonusCanonicalUnits: 2,
        purchaseOrder: {
          id: 'po',
          organizationId: 'org',
          branchId: 'branch',
          expectedDeliveryAt: null,
        },
        goodsReceiptLines: [{ acceptedCanonicalUnits: 3 }],
      },
    ]);
    const result = await readPharmacyReplenishmentReport(db, { ...input, manualScenario }, readAt);
    expect(result.observations.supply.stock).toHaveLength(0);
    expect(result.observations.supply.excludedStock).toHaveLength(1);
    expect(result.observations.supply.inbound[0]).toMatchObject({
      arrivalAt: null,
      lot: { availableUnits: 9, expiresAt: null },
      evidence: { kind: 'PURCHASE_ORDER', postedAcceptedUnits: 3 },
    });
    expect(result.planning).toMatchObject({
      status: 'INSUFFICIENT_STOCK_EVIDENCE',
      decision: null,
    });
  });

  it.each(['branch', 'medicine'])(
    'rejects inactive/foreign %s before supply reads',
    async (kind) => {
      const { db, reads } = database();
      if (kind === 'branch') reads.pharmacyBranch.findFirst.mockResolvedValue(null);
      else
        reads.medicine.findFirst.mockResolvedValue({ id: 'medicine', organizationId: 'foreign' });
      await expect(readPharmacyReplenishmentReport(db, input, readAt)).rejects.toThrow(/scope/);
      expect(mocks.stock).not.toHaveBeenCalled();
      expect(reads.pharmacySaleLine.findMany).not.toHaveBeenCalled();
    }
  );

  it('denies unauthorized branch before every reader', async () => {
    const { db, reads } = database();
    await expect(
      readPharmacyReplenishmentReport(db, { ...input, authorizedBranchIds: [] }, readAt)
    ).rejects.toThrow(/authorized scope/);
    expect(reads.pharmacyBranch.findFirst).not.toHaveBeenCalled();
    expect(mocks.stock).not.toHaveBeenCalled();
  });

  it.each([
    { historyStartDate: '2026-02-30' },
    { historyStartDate: '2026-01-01' },
    { historyStartDate: '2026-09-13' },
    { originDate: '2026-09-15' },
    { horizonDays: 367 },
    { horizonDays: 0 },
    { horizonDays: 1.5 },
    { manualScenario: { ...manualScenario, originDate: '2026-09-14' } },
    { manualScenario: { ...manualScenario, originDate: '2026-12-15' } },
    { manualScenario: { ...manualScenario, dailyDemandUnits: Number.MAX_SAFE_INTEGER } },
    {
      manualScenario: {
        ...manualScenario,
        orderTerms: { ...manualScenario.orderTerms, packSize: 0 },
      },
    },
  ])('validates bounded input before reads: %j', async (overrides) => {
    const { db, reads } = database();
    await expect(
      readPharmacyReplenishmentReport(db, { ...input, ...overrides }, readAt)
    ).rejects.toThrow();
    expect(reads.pharmacyBranch.findFirst).not.toHaveBeenCalled();
    expect(mocks.stock).not.toHaveBeenCalled();
  });
});

describe('persisted seasonal calendar in the live report', () => {
  it('feeds branch salt sales into a separate recorded-sales projection without inventing demand evidence', async () => {
    const { db, reads } = database();
    reads.pharmacySeasonalCalendarWindow.findMany.mockResolvedValue([
      {
        id: 'season',
        organizationId: 'org',
        branchId: 'branch',
        name: 'Local season',
        startDate: new Date('2026-09-08T00:00:00Z'),
        endDate: new Date('2026-09-30T00:00:00Z'),
        enabled: true,
      },
    ]);
    reads.medicineStrengthComponent.findMany.mockResolvedValue([{ ingredientId: 'salt' }]);
    reads.unfulfilledDemandEvent.findMany.mockResolvedValue([]);
    const lines = Array.from({ length: 9 }, (_, index) => {
      const date = `2026-09-${String(index + 1).padStart(2, '0')}`;
      return {
        ...scope,
        id: `line-${index}`,
        canonicalUnits: index < 7 ? 10 : 15,
        createdAt: new Date(`${date}T10:00:00Z`),
        medicine: { strengths: [{ ingredientId: 'salt' }] },
        sale: {
          organizationId: 'org',
          branchId: 'branch',
          status: 'COMPLETED',
          businessDate: new Date(`${date}T00:00:00Z`),
          completedAt: new Date(`${date}T10:00:00Z`),
          createdAt: new Date(`${date}T10:00:00Z`),
          updatedAt: new Date(`${date}T10:00:00Z`),
        },
      };
    });
    reads.pharmacySaleLine.findMany.mockResolvedValue(lines);
    const request = {
      ...input,
      historyStartDate: '2026-09-01',
      originDate: '2026-09-10',
      horizonDays: 2,
    };
    const result = await readPharmacyReplenishmentReport(db, request, readAt);
    expect(result.forecast).toEqual({ status: 'INSUFFICIENT_EVIDENCE', result: null });
    expect(result.seasonalForecast).toMatchObject({
      label: 'MODELLED_RECORDED_SALES',
      baselineDays: 7,
      projection: [
        { date: '2026-09-10', units: 15, seasonalityBps: 15_000 },
        { date: '2026-09-11', units: 15, seasonalityBps: 15_000 },
      ],
    });
    expect(result.seasonalForecast.adjustments[0].salts[0].learnedUplift).toMatchObject({
      windowId: 'season',
      upliftBps: 15_000,
    });
    expect(reads.pharmacySeasonalCalendarWindow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org', branchId: 'branch', enabled: true },
      })
    );
    expect(reads.medicineStrengthComponent.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org', medicineId: 'medicine' },
      select: { ingredientId: true },
    });
    expect(reads.pharmacySaleLine.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org',
          branchId: 'branch',
          medicine: {
            organizationId: 'org',
            strengths: { some: { organizationId: 'org', ingredientId: { in: ['salt'] } } },
          },
          sale: expect.objectContaining({
            status: 'COMPLETED',
            organizationId: 'org',
            branchId: 'branch',
            completedAt: {
              gte: new Date('2026-09-01T00:00:00Z'),
              lt: new Date('2026-09-10T00:00:00Z'),
              lte: readAt,
            },
          }),
        }),
      })
    );
    reads.pharmacySeasonalCalendarWindow.findMany.mockResolvedValue([]);
    const disabled = await readPharmacyReplenishmentReport(db, request, readAt);
    expect(
      disabled.seasonalForecast.adjustments.every((day) => day.seasonalityBps === 10_000)
    ).toBe(true);
    expect(disabled.seasonalForecast.projection?.map((day) => day.units)).toEqual([12, 12]);
  });
});
