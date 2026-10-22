import { describe, expect, it, vi } from 'vitest';
import {
  PHARMACY_METRIC_CONTRACT,
  pharmacyReportCatalog,
  readPharmacyOwnerCommandCentre,
  validatePharmacyReportFilters,
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

  it('counts only currently valid qualified-person coverage in the command centre', async () => {
    vi.useFakeTimers();
    const asOf = new Date('2026-03-10T12:00:00.000Z');
    vi.setSystemTime(asOf);
    const queryRaw = vi.fn().mockResolvedValue([]);
    const coverageCount = vi.fn().mockResolvedValue(0);

    try {
      await readPharmacyOwnerCommandCentre(
        {
          $queryRaw: queryRaw,
          pharmacyRecallNotice: { count },
          pharmacySupplierClaim: { count },
          pharmacyReceivingException: { count },
          branchRegulatoryProfile: { count: coverageCount },
        } as never,
        { branchIds: ['branch_1'], from: '2026-03-10', to: '2026-03-10' }
      );

      expect(coverageCount).toHaveBeenCalledExactlyOnceWith({
        where: {
          branchId: { in: ['branch_1'] },
          effectiveFrom: { lte: asOf },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
          qualifiedPersonValidFrom: { lte: asOf },
          qualifiedPersonValidTo: { gt: asOf },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// Query-shape regressions follow the existing cash-tender test seam.
// These inspect generated SQL; they do not execute PostgreSQL aggregates.
describe('PH-RPT aggregate corrections', () => {
  it('identifies the safety queue as organization-wide without branch attribution', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const result = await readPharmacyOwnerCommandCentre(
      {
        $queryRaw: queryRaw,
        pharmacyRecallNotice: { count },
        pharmacySupplierClaim: { count },
        pharmacyReceivingException: { count },
        branchRegulatoryProfile: { count },
      } as never,
      { branchIds: ['branch_1'], from: '2026-09-04', to: '2026-09-04' }
    );
    expect(result.metricScopes.safetyQueue).toBe('organization');
    const safetyQuery = queryRaw.mock.calls.find(([query]) =>
      (query as { strings: readonly string[] }).strings
        .join('?')
        .includes('pharmacy_pharmacist_review_items')
    )?.[0] as { strings: readonly string[]; values: unknown[] };
    expect(safetyQuery.strings.join('?')).not.toContain('branchId');
    expect(safetyQuery.values).toEqual([]);
  });

  async function captureQueries() {
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
      { branchIds: ['branch_1', 'branch_2'], from: '2026-09-04', to: '2026-09-04' }
    );
    return queryRaw.mock.calls.map(([query]) => {
      const statement = query as { strings: readonly string[]; values: unknown[] };
      return { sql: statement.strings.join('?'), values: statement.values };
    });
  }

  it('counts each open signal once and only signals with a linked requisition as recommended', async () => {
    const queries = await captureQueries();
    const { sql, values } = queries.find(({ sql }) =>
      sql.includes('FROM "pharmacy_stock_signals" s')
    )!;
    expect(sql).toContain('COUNT(*)::int AS "open"');
    expect(sql).not.toContain('JOIN "pharmacy_stock_signal_actions"');
    expect(sql).toContain(
      'COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "pharmacy_stock_signal_actions" a'
    );
    expect(sql).toContain('a."organizationId"=s."organizationId"');
    expect(sql).toContain('a."branchId"=s."branchId"');
    expect(sql).toContain('a."signalId"=s."id"');
    expect(sql).toContain(`a."kind"='DRAFT_REQUISITION' AND a."requisitionId" IS NOT NULL`);
    expect(sql).toContain(
      `FROM "pharmacy_stock_signals" s WHERE s."branchId" IN (?,?) AND s."status" IN ('OPEN','ACKNOWLEDGED','SNOOZED')`
    );
    expect(values).toEqual(['branch_1', 'branch_2']);
  });

  it.each([30, 60, 90, 180])(
    'limits the %i-day valuation to available active future-expiry stock',
    async (days) => {
      const queries = await captureQueries();
      const { sql, values } = queries.find(({ sql }) =>
        sql.includes('FROM "pharmacy_stock_balances" bal')
      )!;
      expect(sql).toContain(
        `CASE WHEN bal."disposition"='AVAILABLE' AND b."state"='ACTIVE' AND b."expiresAt">CURRENT_TIMESTAMP AND b."expiresAt"<CURRENT_TIMESTAMP+interval '${days} days' THEN bal."onHandUnits"*lot."unitCostMinor" ELSE 0 END),0)::int AS "d${days}"`
      );
      // Eligibility belongs inside each valuation CASE so quarantine remains counted.
      expect(sql).toContain(
        `CASE WHEN bal."disposition"='QUARANTINE' OR b."state"='QUARANTINED' THEN bal."onHandUnits" ELSE 0 END`
      );
      expect(sql).toContain('bal."branchId" IN (?,?) AND bal."onHandUnits">0');
      expect(sql).toContain(
        'lot."organizationId"=bal."organizationId" AND lot."branchId"=bal."branchId"'
      );
      expect(sql).toContain('b."organizationId"=lot."organizationId"');
      expect(values).toEqual(['branch_1', 'branch_2']);
    }
  );

  it.each([
    ['2026-02-30', '2026-03-02'],
    ['2026-02-01', '2026-02-30'],
    ['2025-02-29', '2025-03-01'],
    ['2026-04-31', '2026-05-01'],
    ['2026-13-01', '2026-13-02'],
  ])('refuses invalid calendar range %s to %s before any database work', async (from, to) => {
    const queryRaw = vi.fn();
    const count = vi.fn();
    await expect(
      readPharmacyOwnerCommandCentre(
        {
          $queryRaw: queryRaw,
          pharmacyRecallNotice: { count },
          pharmacySupplierClaim: { count },
          pharmacyReceivingException: { count },
          branchRegulatoryProfile: { count },
        } as never,
        { branchIds: ['branch_1'], from, to }
      )
    ).rejects.toThrow('Report dates must be valid calendar dates.');
    expect(queryRaw).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('accepts a leap day and preserves inclusive UTC dates and the 90-day limit', () => {
    const branchIds = ['branch_1'];
    expect(
      validatePharmacyReportFilters({ branchIds, from: '2024-02-29', to: '2024-02-29' })
    ).toEqual({
      from: new Date('2024-02-29T00:00:00.000Z'),
      to: new Date('2024-03-01T00:00:00.000Z'),
      days: 1,
    });
    expect(
      validatePharmacyReportFilters({ branchIds, from: '2026-01-01', to: '2026-03-31' }).days
    ).toBe(90);
    expect(() =>
      validatePharmacyReportFilters({ branchIds, from: '2026-01-01', to: '2026-04-01' })
    ).toThrow('limited to 90 days');
    expect(() =>
      validatePharmacyReportFilters({ branchIds, from: '2026-03-02', to: '2026-03-01' })
    ).toThrow('start date must not be after');
    expect(() =>
      validatePharmacyReportFilters({ branchIds, from: '2026-2-01', to: '2026-02-01' })
    ).toThrow('YYYY-MM-DD');
    expect(() =>
      validatePharmacyReportFilters({ branchIds: [], from: '2026-01-01', to: '2026-01-01' })
    ).toThrow('at least one');
    expect(() =>
      validatePharmacyReportFilters({
        branchIds: Array(101).fill('branch_1'),
        from: '2026-01-01',
        to: '2026-01-01',
      })
    ).toThrow('Too many');
  });
});
