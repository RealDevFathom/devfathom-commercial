/**
 * WHA-1532 independent finance review — deterministic evidence tests.
 *
 * Intended destination: src/lib/pharmacy/finance-evidence-review.test.ts
 * Authored statically by the Claude finance lane; NOT executed by the author.
 * Mocks only: no database, network, provider, or wall-clock dependency.
 *
 * Original F-06/F-07 `it.fails` markers unexpectedly passed against the fixed
 * reader; these ordinary regressions now enforce the existing contracts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  explainGrossMargin,
  grossMarginQuery,
  marginComparisonPeriods,
  type MarginRow,
} from '@/lib/pharmacy/finance-reports';
import { financialStatements } from '@/lib/pharmacy/financial-statements';
import { growthReceiptMoney, readGrowthSandboxDiagnostic } from '@/lib/pharmacy/growth-evidence';
import {
  MAX_PHARMACY_REPORT_DAYS,
  PHARMACY_METRIC_CONTRACT,
  readPharmacyOwnerCommandCentre,
  validatePharmacyReportFilters,
} from '@/lib/pharmacy/reports';

vi.mock('server-only', () => ({}));

type CapturedSql = { sql: string; values: unknown[] };

const ORG = 'org-review-1';
const BRANCH = 'branch-review-1';

function isoDates(values: unknown[]) {
  return [
    ...new Set(values.filter((v): v is Date => v instanceof Date).map((d) => d.toISOString())),
  ].sort();
}

function row(
  revenueMinor: number,
  discountMinor: number,
  cogsMinor: number,
  grossMarginMinor: number
): MarginRow {
  return { key: BRANCH, revenueMinor, discountMinor, cogsMinor, grossMarginMinor };
}

describe('report window validation (reports.ts validatePharmacyReportFilters)', () => {
  const base = { branchIds: [BRANCH] };

  it('turns calendar dates into a UTC-midnight [from, to+1d) window', () => {
    const parsed = validatePharmacyReportFilters({ ...base, from: '2026-03-01', to: '2026-03-31' });
    expect(parsed.from.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(parsed.to.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(parsed.days).toBe(31);
  });

  it('accepts exactly 90 inclusive days and rejects 91', () => {
    expect(MAX_PHARMACY_REPORT_DAYS).toBe(90);
    expect(
      validatePharmacyReportFilters({ ...base, from: '2026-01-01', to: '2026-03-31' }).days
    ).toBe(90);
    expect(() =>
      validatePharmacyReportFilters({ ...base, from: '2026-01-01', to: '2026-04-01' })
    ).toThrow('Interactive pharmacy reports are limited to 90 days.');
  });

  it.each([
    [
      { branchIds: [], from: '2026-03-01', to: '2026-03-01' },
      'Choose at least one active pharmacy branch.',
    ],
    [
      {
        branchIds: Array.from({ length: 101 }, (_, i) => `b${i}`),
        from: '2026-03-01',
        to: '2026-03-01',
      },
      'Too many pharmacy branches for one report.',
    ],
    [{ ...base, from: '2026-3-01', to: '2026-03-01' }, 'Report dates must be YYYY-MM-DD.'],
    [
      { ...base, from: '2026-02-29', to: '2026-03-01' },
      'Report dates must be valid calendar dates.',
    ],
    [
      { ...base, from: '2026-02-32', to: '2026-03-01' },
      'Report dates must be valid calendar dates.',
    ],
    [
      { ...base, from: '2026-03-02', to: '2026-03-01' },
      'The report start date must not be after the end date.',
    ],
  ])('rejects %j', (filters, message) => {
    expect(() => validatePharmacyReportFilters(filters)).toThrow(message);
  });

  it('places a 20:30Z posting inside the same-day UTC margin window (no branch zone applied)', () => {
    const parsed = validatePharmacyReportFilters({ ...base, from: '2026-03-01', to: '2026-03-01' });
    const posting = new Date('2026-03-01T20:30:00.000Z');
    expect(posting >= parsed.from && posting < parsed.to).toBe(true);
  });
});

describe('margin comparison periods (finance-reports.ts marginComparisonPeriods)', () => {
  it('builds an equal-length preceding UTC window', () => {
    const periods = marginComparisonPeriods(
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-08T00:00:00.000Z')
    );
    expect(periods.previous.from.toISOString()).toBe('2026-02-22T00:00:00.000Z');
    expect(periods.previous.to.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(periods.current.from.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(periods.current.to.toISOString()).toBe('2026-03-08T00:00:00.000Z');
  });

  it('accepts 92 days (above the 90-day report cap) and rejects 92 days + 1 ms and empty periods', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    expect(() =>
      marginComparisonPeriods(from, new Date(from.getTime() + 92 * 86_400_000))
    ).not.toThrow();
    expect(() =>
      marginComparisonPeriods(from, new Date(from.getTime() + 92 * 86_400_000 + 1))
    ).toThrow('Choose a valid period of at most 92 days.');
    expect(() => marginComparisonPeriods(from, from)).toThrow(
      'Choose a valid period of at most 92 days.'
    );
  });
});

describe('margin explanation (finance-reports.ts explainGrossMargin)', () => {
  it('reconciles deltas exactly as revenue - discount - cost', () => {
    const result = explainGrossMargin(
      row(10_000, 500, 6_000, 3_500),
      row(12_000, 1_000, 7_000, 4_000)
    );
    expect(result).toMatchObject({
      revenueDeltaMinor: 2_000,
      discountDeltaMinor: 500,
      cogsDeltaMinor: 1_000,
      differenceMinor: 500,
      reconciledMinor: 500,
    });
    expect(result.previous.hasEntries).toBe(true);
  });

  it('treats a missing period as zero with hasEntries=false, not as unknown', () => {
    const result = explainGrossMargin(undefined, row(1_000, 0, 400, 600));
    expect(result.previous).toEqual({
      key: null,
      revenueMinor: 0,
      discountMinor: 0,
      cogsMinor: 0,
      grossMarginMinor: 0,
      hasEntries: false,
    });
    expect(result.differenceMinor).toBe(600);
  });

  it('accepts a return-dominated period with negative totals', () => {
    const result = explainGrossMargin(row(0, 0, 0, 0), row(-2_000, -100, -1_200, -700));
    expect(result.differenceMinor).toBe(-700);
    expect(result.reconciledMinor).toBe(-700);
  });

  it('rejects non-reconciling and non-integer totals', () => {
    expect(() => explainGrossMargin(row(10_000, 500, 6_000, 3_600), undefined)).toThrow(
      'Ledger gross margin does not reconcile.'
    );
    expect(() => explainGrossMargin(row(10.5, 0, 0, 10.5), undefined)).toThrow(
      'Invalid integer-money total.'
    );
  });

  it('rejects a delta beyond safe integer money', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(() => explainGrossMargin(row(-max, 0, 0, -max), row(max, 0, 0, max))).toThrow(
      'Ledger totals exceed safe integer-money bounds.'
    );
  });

  it('grossMarginQuery has no sourceKind filter, so return and reversal postings net into margin', () => {
    const query = grossMarginQuery(
      { organizationId: ORG, branchId: BRANCH },
      {
        from: new Date('2026-03-01T00:00:00.000Z'),
        to: new Date('2026-03-02T00:00:00.000Z'),
        by: 'branch',
      }
    ) as unknown as CapturedSql;
    expect(query.sql).not.toContain('sourceKind');
    expect(query.sql).toContain('entry."occurredAt" >=');
  });
});

describe('metric contract (reports.ts PHARMACY_METRIC_CONTRACT)', () => {
  it('publishes 24 metrics; sales and margin are on different date bases', () => {
    expect(PHARMACY_METRIC_CONTRACT).toHaveLength(24);
    const byKey = Object.fromEntries(PHARMACY_METRIC_CONTRACT.map((m) => [m.key, m]));
    expect(byKey.salesMinor?.scope).toBe('selected branches and business dates');
    expect(byKey.marginMinor?.scope).toBe('selected branches and UTC posting dates');
    expect(byKey.refundsMinor?.source).toBe('pharmacy_refunds');
    expect(byKey.lostDemandEvents).toMatchObject({
      source: 'pharmacy_unfulfilled_demand_events',
      scope: 'selected branches and event creation dates',
      permission: 'reports:operational',
      drillThrough: '/pharmacy/reports?section=demand',
    });
  });

  it('marks exactly three metrics as having no source', () => {
    expect(PHARMACY_METRIC_CONTRACT.filter((m) => m.source === null).map((m) => m.key)).toEqual([
      'accountsPayableMinor',
      'accountsReceivableMinor',
      'deviceFiscalOfflineExceptions',
    ]);
  });
});

describe('owner command centre (reports.ts readPharmacyOwnerCommandCentre)', () => {
  type Counts = { recalls: number; claims: number; receiving: number; coverage: number };

  function makeDb(rawResults: unknown[][], counts: Counts, khataValue = BigInt(4250)) {
    const calls: CapturedSql[] = [];
    const coverageArgs: unknown[] = [];
    let index = 0;
    const db = {
      $queryRaw: vi.fn(async (query: CapturedSql) => {
        calls.push({ sql: query.sql, values: query.values });
        if (query.sql.includes("current_setting('app.current_branch_id'"))
          return [{ branchId: null }];
        if (query.sql.includes('FROM "pharmacy_khata_events" charge'))
          return [{ value: khataValue }];
        if (query.sql.includes("set_config('app.current_branch_id'")) return [];
        return rawResults[index++] ?? [];
      }),
      pharmacyRecallNotice: { count: vi.fn(async () => counts.recalls) },
      pharmacySupplierClaim: { count: vi.fn(async () => counts.claims) },
      pharmacyReceivingException: { count: vi.fn(async () => counts.receiving) },
      branchRegulatoryProfile: {
        count: vi.fn(async (args: unknown) => {
          coverageArgs.push(args);
          return counts.coverage;
        }),
      },
    };
    return { db: db as unknown as ScopedDb, calls, coverageArgs };
  }

  const filters = { branchIds: [BRANCH], from: '2026-03-01', to: '2026-03-01' };
  const populated = [
    [
      {
        salesMinor: 12_000,
        marginMinor: null,
        cashMinor: 5_000,
        refundsMinor: 700,
        cashVarianceMinor: -50,
      },
    ],
    [{ open: 3, recommended: 1 }],
    [{ value: 7 }], // Recorded lost demand precedes expiry, safety and fiscal reads.
    [{ d30: 100, d60: 250, d90: 250, d180: 900, quarantine: 4 }],
    [{ value: 2 }],
    [{ aging: 1, rejected: 2 }],
  ];
  const populatedCounts = { recalls: 1, claims: 0, receiving: 5, coverage: 1 };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps ledger rows to metrics exactly, keeping unknown margin as null', async () => {
    const { db } = makeDb(populated, populatedCounts);
    const result = await readPharmacyOwnerCommandCentre(db, filters);
    expect(result.metrics).toEqual({
      salesMinor: 12_000,
      marginMinor: null,
      cashMinor: 5_000,
      refundsMinor: 700,
      cashVarianceMinor: -50,
      openStockSignals: 3,
      lostDemandEvents: 7,
      recommendedOrders: 1,
      expiryValueMinor30: 100,
      expiryValueMinor60: 250,
      expiryValueMinor90: 250,
      expiryValueMinor180: 900,
      openRecalls: 1,
      quarantineUnits: 4,
      openClaims: 0,
      openReceivingExceptions: 5,
      pharmacistCoverage: 1,
      safetyQueue: 2,
      agingFiscalDocuments: 1,
      rejectedFiscalDocuments: 2,
      accountsPayableMinor: null,
      accountsReceivableMinor: null,
      khataAgingMinor: 4_250,
      deviceFiscalOfflineExceptions: null,
    });
  });

  it('asserts CURRENT freshness from the JS clock even when every ledger is empty', async () => {
    const { db, coverageArgs } = makeDb([], { recalls: 0, claims: 0, receiving: 0, coverage: 0 });
    const result = await readPharmacyOwnerCommandCentre(db, filters);
    expect(result.freshness).toEqual({
      status: 'CURRENT',
      asOf: '2026-03-10T12:00:00.000Z',
      source: 'transactional pharmacy ledgers',
    });
    expect(result.metrics.salesMinor).toBe(0);
    expect(result.metrics.marginMinor).toBeNull();
    const where = (coverageArgs[0] as { where: { effectiveFrom: { lte: Date } } }).where;
    expect(where.effectiveFrom.lte.toISOString()).toBe('2026-03-10T12:00:00.000Z');
  });

  it('issues branch-context Khata reads in addition to six aggregate reads', async () => {
    const { db, calls } = makeDb(populated, populatedCounts);
    await readPharmacyOwnerCommandCentre(db, filters);
    expect(calls).toHaveLength(10);
    const money = calls[0];
    expect(money?.sql).toContain('s."businessDate">=');
    expect(money?.sql).toContain('entry."occurredAt" >=');
    expect(isoDates(money?.values ?? [])).toEqual([
      '2026-03-01T00:00:00.000Z',
      '2026-03-02T00:00:00.000Z',
    ]);
    const lostDemand = calls[2];
    expect(lostDemand?.sql).toContain('FROM "pharmacy_unfulfilled_demand_events"');
    expect(lostDemand?.sql).toContain('"organizationId"=current_setting(');
    expect(lostDemand?.sql).toContain('"branchId" IN (?)');
    expect(lostDemand?.sql).toContain('"createdAt">=? AND "createdAt"<?');
    expect(lostDemand?.values).toEqual([
      BRANCH,
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-02T00:00:00.000Z'),
    ]);
    // Expiry and fiscal aging use the database clock, not the JS clock used for freshness.
    expect(calls[3]?.sql).toContain('CURRENT_TIMESTAMP');
    expect(calls[5]?.sql).toContain('CURRENT_TIMESTAMP');
    expect(calls[6]?.sql).toContain("current_setting('app.current_branch_id'");
    expect(calls[7]?.sql).toContain("set_config('app.current_branch_id'");
    expect(calls[8]?.sql).toContain('FROM "pharmacy_khata_events" charge');
    expect(calls[9]?.sql).toContain("set_config('app.current_branch_id'");
  });

  it('salesMinor is gross of returns: no return-line or refund term in the sales expression', async () => {
    const { db, calls } = makeDb(populated, populatedCounts);
    await readPharmacyOwnerCommandCentre(db, filters);
    expect(calls[0]?.sql).not.toContain('pharmacy_sale_return_lines');
    expect(calls[0]?.sql).toContain(`s."status"='COMPLETED'`);
  });

  it('cashMinor sums tender amountMinor without referencing changeGivenMinor (pinned; contract says "less change given")', async () => {
    const { db, calls } = makeDb(populated, populatedCounts);
    await readPharmacyOwnerCommandCentre(db, filters);
    expect(calls[0]?.sql).toContain(`t."type"='CASH'`);
    expect(calls[0]?.sql).not.toContain('changeGivenMinor');
  });

  it('F-06: cashVarianceMinor reads only final, non-superseded daily closes as the contract states', async () => {
    const { db, calls } = makeDb(populated, populatedCounts);
    await readPharmacyOwnerCommandCentre(db, filters);
    const { sql, values } = calls[0]!;
    const closeSql = sql.slice(sql.indexOf('COALESCE((SELECT SUM(c."cashVarianceMinor")'));
    expect(closeSql).toContain('c."branchId" IN (?)');
    expect(closeSql).toContain('c."businessDate">=? AND c."businessDate"<?');
    expect(closeSql).toContain('c."isFinal"=true');
    expect(closeSql).toContain('NOT EXISTS (SELECT 1 FROM "pharmacy_daily_closes" newer');
    expect(closeSql).toContain('newer."organizationId"=c."organizationId"');
    expect(closeSql).toContain('newer."branchId"=c."branchId"');
    expect(closeSql).toContain('newer."businessDate"=c."businessDate"');
    expect(closeSql).toContain('newer."sequence">c."sequence"');
    expect(closeSql).not.toContain('newer."isFinal"');
    expect(closeSql).toContain('),0)::int AS "cashVarianceMinor"');
    expect(values.slice(-3)).toEqual([
      BRANCH,
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-02T00:00:00.000Z'),
    ]);
  });

  it('F-07: deviceFiscalOfflineExceptions stays null because the contract declares no source', async () => {
    const { db } = makeDb(populated, populatedCounts);
    const result = await readPharmacyOwnerCommandCentre(db, filters);
    expect(result.metrics.deviceFiscalOfflineExceptions).toBeNull();
  });
});

describe('financial statements (financial-statements.ts financialStatements)', () => {
  it('preserves balanced debit and credit totals, derives exact bigint strings, and pages by 25', async () => {
    const raw = [
      [
        {
          accountCode: 'CASH',
          currency: 'PKR',
          opening: BigInt(1_000),
          debit: BigInt(500),
          credit: BigInt(200),
        },
        {
          accountCode: 'SALES_REVENUE',
          currency: 'PKR',
          opening: BigInt(0),
          debit: BigInt(0),
          credit: BigInt(300),
        },
      ],
      [
        {
          sourceKind: 'PHARMACY_TENDER',
          currency: 'PKR',
          inflow: BigInt(500),
          outflow: BigInt(200),
        },
      ],
    ];
    let index = 0;
    const findMany = vi.fn(async () => []);
    const db = {
      $queryRaw: vi.fn(async () => raw[index++] ?? []),
      financeJournalEntry: { findMany, count: vi.fn(async () => 0) },
    } as unknown as ScopedDb;
    const from = new Date('2026-03-01T00:00:00.000Z');
    const to = new Date('2026-04-01T00:00:00.000Z');
    const result = await financialStatements(
      db,
      { organizationId: ORG, branchId: BRANCH },
      { from, to, page: 2 }
    );
    expect(result.accounts).toEqual([
      {
        accountCode: 'CASH',
        currency: 'PKR',
        openingMinor: '1000',
        debitMinor: '500',
        creditMinor: '200',
        closingMinor: '1300',
      },
      {
        accountCode: 'SALES_REVENUE',
        currency: 'PKR',
        openingMinor: '0',
        debitMinor: '0',
        creditMinor: '300',
        closingMinor: '-300',
      },
    ]);
    expect(result.cashflow).toEqual([
      {
        sourceKind: 'PHARMACY_TENDER',
        currency: 'PKR',
        inflowMinor: '500',
        outflowMinor: '200',
        netMinor: '300',
      },
    ]);
    expect(
      result.accounts.reduce((sum, account) => sum + BigInt(account.debitMinor), BigInt(0))
    ).toBe(result.accounts.reduce((sum, account) => sum + BigInt(account.creditMinor), BigInt(0)));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25, skip: 25 }));
  });
});

describe('growth sandbox diagnostic (growth-evidence.ts)', () => {
  const scope = { organizationId: ORG, branchId: BRANCH } as Parameters<
    typeof readGrowthSandboxDiagnostic
  >[1];
  const cutoff = new Date('2026-03-10T00:00:00.000Z');
  const syntheticUrl = 'postgresql://synthetic@127.0.0.1:55625/growth_synthetic';

  function makeDb(identity: unknown[], rows: unknown[]) {
    const results = [identity, rows];
    let index = 0;
    const calls: CapturedSql[] = [];
    const $queryRaw = vi.fn(async (query: CapturedSql) => {
      calls.push({ sql: query.sql, values: query.values });
      return results[index++] ?? [];
    });
    return { db: { $queryRaw } as unknown as ScopedDb, $queryRaw, calls };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['', syntheticUrl],
    ['true', ''],
    ['true', 'postgresql://synthetic@localhost:55625/growth_synthetic'],
    ['true', 'postgresql://synthetic@127.0.0.1:55626/growth_synthetic'],
  ])('refuses admission (admitted=%j url=%j) before any read', async (admitted, url) => {
    vi.stubEnv('PHARMACY_MARKETING_DB_ADMITTED', admitted);
    vi.stubEnv('PHARMACY_MARKETING_TEST_RUNTIME_DATABASE_URL', url);
    const { db, $queryRaw } = makeDb([], []);
    await expect(readGrowthSandboxDiagnostic(db, scope, 'insight-1', cutoff)).rejects.toThrow(
      'Synthetic DB55625 admission required.'
    );
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a database whose name differs from the admitted URL', async () => {
    vi.stubEnv('PHARMACY_MARKETING_DB_ADMITTED', 'true');
    vi.stubEnv('PHARMACY_MARKETING_TEST_RUNTIME_DATABASE_URL', syntheticUrl);
    const { db, $queryRaw } = makeDb([{ port: 55625, database: 'other' }], []);
    await expect(readGrowthSandboxDiagnostic(db, scope, 'insight-1', cutoff)).rejects.toThrow(
      'Synthetic database mismatch.'
    );
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it('refuses more than 5000 rows', async () => {
    vi.stubEnv('PHARMACY_MARKETING_DB_ADMITTED', 'true');
    vi.stubEnv('PHARMACY_MARKETING_TEST_RUNTIME_DATABASE_URL', syntheticUrl);
    const rows = Array.from({ length: 5001 }, (_, i) => ({ receiptId: `r${i}` }));
    const { db } = makeDb([{ port: 55625, database: 'growth_synthetic' }], rows);
    await expect(readGrowthSandboxDiagnostic(db, scope, 'insight-1', cutoff)).rejects.toThrow(
      'Narrow diagnostic scope.'
    );
  });

  it('labels output observational TEST_SANDBOX with unknown message cost', async () => {
    vi.stubEnv('PHARMACY_MARKETING_DB_ADMITTED', 'true');
    vi.stubEnv('PHARMACY_MARKETING_TEST_RUNTIME_DATABASE_URL', syntheticUrl);
    const rows = [
      {
        receiptId: 'r1',
        campaignId: 'c1',
        captureId: 'cap1',
        salesMinor: '1200',
        marginMinor: '300',
      },
      { receiptId: 'r2', campaignId: 'c1', captureId: 'cap2', salesMinor: '0', marginMinor: '0' },
    ];
    const { db, calls } = makeDb([{ port: 55625, database: 'growth_synthetic' }], rows);
    const result = await readGrowthSandboxDiagnostic(db, scope, 'insight-1', cutoff);
    expect(result).toEqual({
      environment: 'TEST_SANDBOX',
      method: 'SYNTHETIC_SANDBOX_RECEIPT_FINANCE_V1',
      observational: true,
      messageCostMinor: null,
      rows,
    });
    expect(calls[1]?.sql).toContain(`a.provider='sandbox'`);
    expect(calls[1]?.sql).toContain(`interval '7 days'`);
    expect(calls[1]?.sql).toContain('LIMIT 5001');
    expect(calls[1]?.values).toContain('insight-1');
  });

  it('growthReceiptMoney includes posted unidentified holds and verifies their completeness', () => {
    const query = growthReceiptMoney(cutoff) as unknown as CapturedSql;
    expect(query.values).toEqual([cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff]);
    expect(query.sql).toContain(`e."sourceKind"='PHARMACY_SALE_RETURN_LINE'`);
    expect(query.sql).toContain(`e."sourceKind"='PHARMACY_UNIDENTIFIED_RETURN_HOLD'`);
    expect(query.sql).toContain('pharmacy_unidentified_return_holds');
  });
});
