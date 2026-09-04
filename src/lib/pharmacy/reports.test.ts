import { describe, expect, it, vi } from 'vitest';
import {
  PHARMACY_METRIC_CONTRACT,
  pharmacyReportCatalog,
  readPharmacyOwnerCommandCentre,
} from './reports';

describe('PH-RPT metric contract', () => {
  it('defines a source, scope, permission, and drill-through for every asserted metric', () => {
    expect(PHARMACY_METRIC_CONTRACT).toHaveLength(23);
    for (const metric of PHARMACY_METRIC_CONTRACT) {
      expect(metric.key).toBeTruthy();
      expect(metric.definition).toBeTruthy();
      expect(metric.scope).toBeTruthy();
      expect(metric.permission).toMatch(/^(reports:operational|reports:financial)$/);
      if (metric.source) expect(metric.drillThrough).toMatch(/^\//);
    }
  });

  it('catalog references only declared metrics', () => {
    const keys = new Set(PHARMACY_METRIC_CONTRACT.map((metric) => metric.key));
    for (const report of pharmacyReportCatalog()) {
      expect(report.metrics.every((metric) => keys.has(metric))).toBe(true);
    }
  });

  it('sums applied cash tender amounts without subtracting change twice', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    await readPharmacyOwnerCommandCentre(
      {
        $queryRaw: queryRaw,
        pharmacyRecallNotice: { count },
        pharmacySupplierClaim: { count },
        pharmacyReceivingException: { count },
        branchRegulatoryProfile: { count },
      } as never,
      { branchIds: ['branch_1'], from: '2026-09-04', to: '2026-09-04' }
    );

    const moneyQuery = queryRaw.mock.calls[0]?.[0] as { strings: readonly string[] };
    const sql = moneyQuery.strings.join('?');
    expect(sql).toContain('SUM(t."amountMinor")');
    expect(sql).not.toContain('SUM(t."amountMinor" - COALESCE(t."changeGivenMinor",0))');
  });
});
