import { describe, expect, it, vi } from 'vitest';
import {
  PHARMACY_METRIC_CONTRACT,
  pharmacyReportCatalog,
  readPharmacyOwnerCommandCentre,
  validatePharmacyReportFilters,
} from './reports';

describe('PH-RPT metric contract', () => {
  it('defines a source, scope, permission, and drill-through for every asserted metric', () => {
    expect(PHARMACY_METRIC_CONTRACT).toHaveLength(24);
    for (const metric of PHARMACY_METRIC_CONTRACT) {
      expect(metric.key).toBeTruthy();
      expect(metric.definition).toBeTruthy();
      expect(metric.scope).toBeTruthy();
      expect(metric.permission).toMatch(/^(reports:operational|reports:financial)$/);
      if (metric.source) expect(metric.drillThrough).toMatch(/^\//);
    }
  });

  it.each([30, 60, 90, 180])(
    'drills expiry value within %i days into the expiry board filtered to that window',
    (days) => {
      const metric = PHARMACY_METRIC_CONTRACT.find(
        (item) => item.key === `expiryValueMinor${days}`
      );
      expect(metric?.drillThrough).toBe(`/pharmacy/inventory/expiry?within=${days}`);
    }
  );

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

  it('counts pharmacist coverage only during the qualified person validity window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T12:00:00.000Z'));
    try {
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
        { branchIds: ['branch_1'], from: '2026-10-29', to: '2026-10-29' }
      );

      expect(count).toHaveBeenLastCalledWith({
        where: {
          branchId: { in: ['branch_1'] },
          effectiveFrom: { lte: new Date('2026-10-29T12:00:00.000Z') },
          OR: [
            { effectiveTo: null },
            { effectiveTo: { gt: new Date('2026-10-29T12:00:00.000Z') } },
          ],
          qualifiedPersonValidFrom: { lte: new Date('2026-10-29T12:00:00.000Z') },
          qualifiedPersonValidTo: { gt: new Date('2026-10-29T12:00:00.000Z') },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports overdue Khata principal net of payments for the selected branches', async () => {
    const queryRaw = vi
      .fn()
      .mockImplementation(async (query: { strings: readonly string[] }) =>
        query.strings.join('?').includes('FROM "pharmacy_khata_events" charge')
          ? [{ value: BigInt(4250) }]
          : []
      );
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

    expect(result.metrics.khataAgingMinor).toBe(4_250);
    const khataQuery = queryRaw.mock.calls.find(([query]) =>
      (query as { strings: readonly string[] }).strings
        .join('?')
        .includes('FROM "pharmacy_khata_events" charge')
    )?.[0] as { strings: readonly string[]; values: unknown[] };
    const sql = khataQuery.strings.join('?');
    expect(sql).toContain('charge."amountMinor"::bigint-COALESCE(payments.paid,0)');
    expect(sql).toContain(')::bigint AS value');
    expect(sql).toContain(`charge."kind"='CHARGE' AND charge."dueAt"<=CURRENT_TIMESTAMP`);
    expect(khataQuery.values).toEqual(['branch_1', 'branch_1']);
  });

  it('re-opens charges for dishonoured cheques so aging matches the Khata balance', async () => {
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

    const sql = queryRaw.mock.calls
      .map(([query]) => (query as { strings: readonly string[] }).strings.join('?'))
      .find((text) => text.includes('FROM "pharmacy_khata_events" charge'));
    expect(sql).toContain(`e."kind" IN ('PAYMENT','DISHONOURED_CHEQUE')`);
    // A dishonour of a payment re-opens that payment's charge.
    expect(sql).toContain('COALESCE(bounced."settlesChargeId", e."settlesChargeId") AS "chargeId"');
    expect(sql).toContain(`CASE WHEN "kind"='PAYMENT' THEN amount ELSE -amount END`);
    // A dishonour linked to no charge is still owed and counts as overdue.
    expect(sql).toContain(`s."kind"='DISHONOURED_CHEQUE' AND NOT EXISTS`);
    expect(sql).toContain('+(SELECT owed FROM unlinked))::bigint AS value');
  });

  it('adds branch-scoped bigint results above the PostgreSQL integer limit', async () => {
    const queryRaw = vi.fn().mockImplementation(async (query: { strings: readonly string[] }) => {
      const sql = query.strings.join('?');
      if (sql.includes("current_setting('app.current_branch_id'"))
        return [{ branchId: 'original' }];
      if (sql.includes('FROM "pharmacy_khata_events" charge'))
        return [{ value: BigInt(1500000000) }];
      return [];
    });
    const count = vi.fn().mockResolvedValue(0);
    const result = await readPharmacyOwnerCommandCentre(
      {
        $queryRaw: queryRaw,
        pharmacyRecallNotice: { count },
        pharmacySupplierClaim: { count },
        pharmacyReceivingException: { count },
        branchRegulatoryProfile: { count },
      } as never,
      { branchIds: ['branch_1', 'branch_2'], from: '2026-09-04', to: '2026-09-04' }
    );

    expect(result.metrics.khataAgingMinor).toBe(3_000_000_000);
    const configs = queryRaw.mock.calls.filter(([query]) =>
      (query as { strings: readonly string[] }).strings
        .join('?')
        .includes("set_config('app.current_branch_id'")
    );
    expect(configs.map(([query]) => (query as { values: unknown[] }).values[0])).toEqual([
      'branch_1',
      'branch_2',
      'original',
    ]);
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

describe('pharmacist coverage count on a profile start day (DEV-298)', () => {
  it.each([
    ['00:30 PKT on the start day', '2026-10-20T19:30:00.000Z', '2026-10-21T00:00:00.000Z'],
    ['23:59 PKT the day before', '2026-10-20T18:59:00.000Z', '2026-10-20T18:59:00.000Z'],
  ])(
    'starts profile and coverage on the workspace day at %s; expiry stays at the instant',
    async (_label, now, asOf) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
      try {
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
          {
            branchIds: ['branch_1'],
            from: '2026-10-21',
            to: '2026-10-21',
            timeZone: 'Asia/Karachi',
          }
        );
        const coverage = count.mock.calls.find(
          ([args]) => (args as { where: Record<string, unknown> }).where.qualifiedPersonValidTo
        )![0] as { where: Record<string, unknown> };
        expect(coverage.where).toEqual({
          branchId: { in: ['branch_1'] },
          effectiveFrom: { lte: new Date(asOf) },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date(asOf) } }],
          qualifiedPersonValidFrom: { lte: new Date(asOf) },
          qualifiedPersonValidTo: { gt: new Date(now) },
        });
      } finally {
        vi.useRealTimers();
      }
    }
  );
});
