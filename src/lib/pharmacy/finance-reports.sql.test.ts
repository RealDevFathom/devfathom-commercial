// @vitest-environment node
/** SQL-reader regression only: temporary tables in an explicitly supplied local disposable DB. */
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { grossMargin, leakageReport, perpetualValuation } from './finance-reports';

const url = process.env.DEV665_REPORT_TEST_DATABASE_URL;
const scope = { organizationId: 'report-org', branchId: 'report-branch' };
const period = { from: new Date('2026-11-01Z'), to: new Date('2026-11-03Z') };

describe.skipIf(!url)('finance report SQL on isolated PostgreSQL temporary tables', () => {
  let client: Client;
  const query = vi.fn(async (sql: Prisma.Sql) => (await client.query(sql.text, sql.values)).rows);
  const db = { $queryRaw: query } as unknown as ScopedDb;

  beforeAll(async () => {
    if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw new Error('Report SQL tests require an explicit loopback database URL.');
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`
      SET search_path = pg_temp;
      CREATE TEMP TABLE finance_journal_entries (
        id text, "organizationId" text, "occurredAt" timestamptz, "sourceKind" text
      );
      CREATE TEMP TABLE finance_journal_lines (
        "organizationId" text, "entryId" text, "branchId" text, "lotId" text,
        "locationId" text, "sourceLineId" text, "productId" text,
        "accountCode" text, side text, "amountMinor" integer
      );
      CREATE TEMP TABLE pharmacy_branches (id text, "organizationId" text, name text);
      CREATE TEMP TABLE pharmacy_stock_locations (id text, "organizationId" text, "branchId" text, name text);
      CREATE TEMP TABLE pharmacy_inventory_lots (
        id text, "organizationId" text, "manufacturingBatchId" text,
        "supplierInvoiceRef" text, "unitCostMinor" integer
      );
      CREATE TEMP TABLE pharmacy_manufacturing_batches (
        id text, "organizationId" text, "medicineId" text, "batchNumber" text
      );
      CREATE TEMP TABLE pharmacy_medicines (id text, "organizationId" text, "productName" text);
      INSERT INTO pharmacy_branches VALUES
        ('report-branch', 'report-org', 'Main pharmacy'), ('report-branch', 'foreign-org', 'Private branch');
      INSERT INTO pharmacy_stock_locations VALUES
        ('shelf', 'report-org', 'report-branch', 'Front shelf'), ('shelf', 'foreign-org', 'report-branch', 'Private shelf');
      INSERT INTO pharmacy_inventory_lots VALUES
        ('lot-a', 'report-org', 'batch-a', 'INV-42', 100), ('lot-b', 'report-org', 'batch-a', 'INV-43', 100),
        ('lot-a', 'foreign-org', 'batch-a', 'Private invoice', 999);
      INSERT INTO pharmacy_manufacturing_batches VALUES
        ('batch-a', 'report-org', 'medicine-a', 'LOT-2026'), ('batch-a', 'foreign-org', 'medicine-a', 'Private batch');
      INSERT INTO pharmacy_medicines VALUES
        ('medicine-a', 'report-org', 'Paracetamol 500 mg'), ('medicine-a', 'foreign-org', 'Private medicine');
    `);
  });

  afterAll(async () => {
    await client?.end();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE pg_temp.finance_journal_lines, pg_temp.finance_journal_entries');
    query.mockClear();
  });

  async function post(
    legs: [account: string, side: 'DEBIT' | 'CREDIT', amount: number][],
    {
      source = 'PHARMACY_SALE_LINE',
      lot = 'lot-a',
      organization = scope.organizationId,
      branch = scope.branchId,
      at = '2026-11-02Z',
    }: {
      source?: string;
      lot?: string | null;
      organization?: string;
      branch?: string;
      at?: string;
    } = {}
  ) {
    const id = crypto.randomUUID();
    await client.query('INSERT INTO finance_journal_entries VALUES ($1, $2, $3, $4)', [
      id,
      organization,
      at,
      source,
    ]);
    for (const [account, side, amount] of legs) {
      await client.query(
        'INSERT INTO finance_journal_lines VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [organization, id, branch, lot, 'shelf', 'sale-line', 'medicine-a', account, side, amount]
      );
    }
  }

  it('keeps every positive lot and resolves names in one tenant-scoped valuation query', async () => {
    await post([
      ['INVENTORY', 'DEBIT', 10000],
      ['INVENTORY', 'CREDIT', 3000],
    ]);
    await post([['INVENTORY_IN_TRANSIT', 'DEBIT', 2000]], { lot: 'lot-b' });
    await post([['INVENTORY', 'CREDIT', 99999]], { organization: 'foreign-org' });
    await post([['INVENTORY', 'CREDIT', 99999]], { branch: 'other-branch' });
    await post([['INVENTORY', 'CREDIT', 99999]], { at: '2026-11-04Z' });
    const rows = await perpetualValuation(db, scope, period.to);
    expect(query).toHaveBeenCalledTimes(1);
    expect(rows.map((row) => row.valueMinor)).toEqual([7000, 2000]);
    expect(rows.reduce((sum, row) => sum + row.valueMinor, 0)).toBe(9000);
    expect(rows[0]).toMatchObject({
      branchId: scope.branchId,
      branchName: 'Main pharmacy',
      lotId: 'lot-a',
      lotReference: 'INV-42',
      manufacturingBatchId: 'batch-a',
      batchNumber: 'LOT-2026',
      medicineId: 'medicine-a',
      medicineName: 'Paracetamol 500 mg',
      locationId: 'shelf',
      locationName: 'Front shelf',
    });
  });

  it('reports a genuinely negative inventory fold without hiding its negative lot row', async () => {
    await post([['INVENTORY', 'DEBIT', 10000]]);
    await post([['INVENTORY', 'CREDIT', 32500]], { lot: 'lot-b' });
    const rows = await perpetualValuation(db, scope, period.to);
    expect(rows.map((row) => row.valueMinor)).toEqual([10000, -32500]);
    expect(rows.reduce((sum, row) => sum + row.valueMinor, 0)).toBe(-22500);
  });

  it('preserves signed amounts and matching names for every margin grouping without join duplication', async () => {
    await post([
      ['SALES_REVENUE', 'CREDIT', 10000],
      ['SALES_DISCOUNT', 'DEBIT', 500],
      ['COST_OF_GOODS_SOLD', 'DEBIT', 6000],
    ]);
    for (const [by, key, label] of [
      ['batch', 'batch-a', 'LOT-2026 · Paracetamol 500 mg'],
      ['product', 'medicine-a', 'Paracetamol 500 mg'],
      ['branch', scope.branchId, 'Main pharmacy'],
      ['line', 'sale-line', 'Paracetamol 500 mg · Sale line'],
    ] as const) {
      const rows = await grossMargin(db, scope, { ...period, by });
      expect(rows).toEqual([
        expect.objectContaining({
          key,
          label,
          revenueMinor: 10000,
          discountMinor: 500,
          cogsMinor: 6000,
          grossMarginMinor: 3500,
        }),
      ]);
    }
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('returns -354 margin for a -354 refund with zero discount and zero COGS', async () => {
    await post([['SALES_REVENUE', 'DEBIT', 35400]], {
      source: 'PHARMACY_UNIDENTIFIED_RETURN_HOLD',
      lot: null,
    });
    expect(await grossMargin(db, scope, { ...period, by: 'batch' })).toEqual([
      expect.objectContaining({
        key: null,
        label: 'Refunds without batch',
        revenueMinor: -35400,
        discountMinor: 0,
        cogsMinor: 0,
        grossMarginMinor: -35400,
      }),
    ]);
  });

  it('only reaches -109 from -354 revenue and zero COGS when a -245 discount reversal is present', async () => {
    await post(
      [
        ['SALES_REVENUE', 'DEBIT', 35400],
        ['SALES_DISCOUNT', 'CREDIT', 24500],
      ],
      { source: 'PHARMACY_UNIDENTIFIED_RETURN_HOLD', lot: null }
    );
    expect(await grossMargin(db, scope, { ...period, by: 'batch' })).toEqual([
      expect.objectContaining({
        key: null,
        label: 'Refunds without batch',
        revenueMinor: -35400,
        discountMinor: -24500,
        cogsMinor: 0,
        grossMarginMinor: -10900,
      }),
    ]);
  });

  it('does not mislabel mixed unbatched adjustments as refunds', async () => {
    await post([['SALES_REVENUE', 'DEBIT', 35400]], {
      source: 'PHARMACY_UNIDENTIFIED_RETURN_HOLD',
      lot: null,
    });
    await post([['SALES_REVENUE', 'CREDIT', 10000]], {
      source: 'PHARMACY_BOOKKEEPING_TRANSACTION',
      lot: null,
    });
    expect(await grossMargin(db, scope, { ...period, by: 'batch' })).toEqual([
      expect.objectContaining({
        key: null,
        label: 'Entries without batch',
        revenueMinor: -25400,
        grossMarginMinor: -25400,
      }),
    ]);
  });

  it('uses the same half-open period and branch filters for sales and their reversals', async () => {
    await post([['SALES_REVENUE', 'CREDIT', 10000]], { at: '2026-11-01Z' });
    await post([['SALES_REVENUE', 'DEBIT', 4000]], { source: 'PHARMACY_SALE_RETURN_LINE' });
    await post([['SALES_REVENUE', 'CREDIT', 99999]], { at: '2026-11-03Z' });
    await post([['SALES_REVENUE', 'CREDIT', 99999]], { organization: 'foreign-org' });
    await post([['SALES_REVENUE', 'CREDIT', 99999]], { branch: 'other-branch' });
    expect(await grossMargin(db, scope, { ...period, by: 'batch' })).toEqual([
      expect.objectContaining({ revenueMinor: 6000, grossMarginMinor: 6000 }),
    ]);
  });

  it('resolves leakage names without multiplying discounts, write-offs, or signed stock differences', async () => {
    await post([
      ['SALES_DISCOUNT', 'DEBIT', 500],
      ['INVENTORY_WRITE_OFF', 'DEBIT', 200],
      ['INVENTORY_SHRINKAGE', 'CREDIT', 100],
    ]);
    expect(await leakageReport(db, scope, period)).toEqual([
      {
        branchId: scope.branchId,
        branchName: 'Main pharmacy',
        medicineId: 'medicine-a',
        medicineName: 'Paracetamol 500 mg',
        discountMinor: 500,
        writeOffMinor: 200,
        shrinkageMinor: -100,
        totalMinor: 600,
      },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
