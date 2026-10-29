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
