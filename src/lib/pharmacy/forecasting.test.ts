import { describe, expect, it } from 'vitest';
import {
  approveForecastDraft,
  compareReplenishment,
  forecastSettingForOrganization,
  type ForecastFixtureLine,
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

  it('uses uplift learned from the branch seasonal calendar in the forecast', () => {
    const history = [
      ...Array.from({ length: 7 }, (_, index) => ({
        branchId: 'branch-a',
        saltId: 'salt-a',
        date: `2026-06-${String(index + 1).padStart(2, '0')}`,
        units: 10,
      })),
      { branchId: 'branch-a', saltId: 'salt-a', date: '2026-07-01', units: 20 },
      { branchId: 'branch-a', saltId: 'salt-a', date: '2026-07-02', units: 20 },
    ];
    const result = compareReplenishment(
      [
        {
          ...fixture,
          seasonalityBps: undefined,
          seasonalContext: {
            branchId: 'branch-a',
            saltId: 'salt-a',
            forecastDate: '2026-07-03',
            history,
            calendar: [
              {
                id: 'season-2026',
                branchId: 'branch-a',
                name: 'Owner seasonal window',
                startDate: '2026-07-01',
                endDate: '2026-08-31',
                enabled: true,
              },
            ],
          },
        },
      ],
      { organizationId: 'organization-a', enabled: true }
    );
    expect(result.forecast[0]).toMatchObject({ forecastQuantityUnits: 150 });
    expect(result.forecast[0]!.reasons[1]!.value).toContain('20000 bps learned');
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

describe('seasonal forecast regressions', () => {
  const line: ForecastFixtureLine = {
    ...fixture,
    demandUnits: 100,
    demandWindowDays: 10,
    leadTimeDays: 10,
    fillRateBps: 10_000,
    seasonalityBps: 5_000,
    openPurchaseOrderUnits: 0,
    openTransferUnits: 0,
    onHandUnits: 0,
    expiringBeforeLeadTimeUnits: 0,
    unfulfilledDemandUnits: 0,
    packSize: 1,
    cashLimitUnits: 100_000,
    storageLimitUnits: 100_000,
  };
  const compare = (value: ForecastFixtureLine) =>
    compareReplenishment([value], { organizationId: 'org', enabled: true }).forecast[0]!;
  const history = Array.from({ length: 30 }, (_, i) => ({
    branchId: 'b',
    saltId: 's',
    date: `2026-06-${String(i + 1).padStart(2, '0')}`,
    units: i === 7 ? 30 : 10,
  }));

  it('preserves manual reductions without a spike', () => {
    expect(compare(line).forecastQuantityUnits).toBe(50);
  });
  it('preserves reductions learned from an active calendar', () => {
    const result = compare({
      ...line,
      seasonalityBps: undefined,
      seasonalContext: {
        branchId: 'b',
        saltId: 's',
        forecastDate: '2026-07-03',
        history: [
          ...history.map((day) => ({ ...day, units: 10 })),
          { branchId: 'b', saltId: 's', date: '2026-07-01', units: 5 },
          { branchId: 'b', saltId: 's', date: '2026-07-02', units: 5 },
        ],
        calendar: [
          {
            id: 'w',
            branchId: 'b',
            name: 'Quiet season',
            startDate: '2026-07-01',
            endDate: '2026-07-31',
            enabled: true,
          },
        ],
      },
    });
    expect(result.forecastQuantityUnits).toBe(50);
    expect(result.reasons[1].value).toContain('5000 bps learned');
  });
  it('expires recovered historical spikes', () => {
    expect(
      compare({
        ...line,
        seasonalContext: {
          branchId: 'b',
          saltId: 's',
          forecastDate: '2026-10-31',
          calendar: [],
          history,
        },
      }).forecastQuantityUnits
    ).toBe(50);
  });
  it('applies a recent spike with a truthful explanation and configurable recency', () => {
    const context = {
      branchId: 'b',
      saltId: 's',
      forecastDate: '2026-06-10',
      calendar: [],
      history,
    };
    const recent = compare({ ...line, seasonalContext: context });
    expect(recent.forecastQuantityUnits).toBe(300);
    expect(recent.reasons[1].value).toContain('sales spike on 2026-06-08');
    expect(
      compare({ ...line, seasonalContext: { ...context, spikeMaxAgeDays: 1 } })
        .forecastQuantityUnits
    ).toBe(50);
  });
});
