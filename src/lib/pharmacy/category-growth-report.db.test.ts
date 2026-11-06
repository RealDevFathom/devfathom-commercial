// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readPharmacyCategoryGrowthReport } from './category-growth-report';

// Temp tables shadow the production names on this connection; rollback removes all fixtures.
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const fixtureSql = `
CREATE TEMP TABLE pharmacy_sale_lines (
  id text, "organizationId" text, "branchId" text, "saleId" text, "medicineId" text,
  quantity int, "unitPriceMinor" int, "discountMinor" int, "canonicalUnits" int
);
CREATE TEMP TABLE pharmacy_sales (
  id text, "organizationId" text, "branchId" text, status text, "receiptNumber" int, "completedAt" timestamp(3)
);
CREATE TEMP TABLE pharmacy_medicines (id text, "organizationId" text, "productFamily" text, otc boolean);
INSERT INTO pharmacy_medicines VALUES
  ('otc','org_1','PHARMACEUTICAL',true),
  ('cos','org_1','FRONT_SHOP',true),
  ('rx','org_1','PHARMACEUTICAL',false),
  ('foreign','org_2','FRONT_SHOP',true);
INSERT INTO pharmacy_sales VALUES
  ('s1','org_1','b1','COMPLETED',1,'2026-10-01'),
  ('s2','org_1','b2','COMPLETED',2,'2026-10-02'),
  ('s3','org_1','b3','COMPLETED',3,'2026-10-02'),
  ('s4','org_2','b1','COMPLETED',4,'2026-10-02'),
  ('s5','org_1','b1','OPEN',null,'2026-10-02'),
  ('s6','org_1','b1','COMPLETED',null,'2026-10-02'),
  ('s7','org_1','b1','COMPLETED',7,'2026-10-09'),
  ('s8','org_1','b1','COMPLETED',8,'2026-09-30');
INSERT INTO pharmacy_sale_lines VALUES
  ('l1','org_1','b1','s1','otc',10,1000,1000,100),
  ('l2','org_1','b1','s1','cos',2,500,0,2),
  ('l3','org_1','b1','s1','rx',5,2000,0,50),
  ('l4','org_1','b2','s2','rx',3,10000,0,3),
  ('l5','org_1','b3','s3','otc',1,50000,0,1),
  ('l6','org_2','b1','s4','foreign',1,90000,0,1),
  ('l7','org_1','b1','s5','otc',1,60000,0,1),
  ('l8','org_1','b1','s6','otc',1,70000,0,1),
  ('l9','org_1','b1','s7','otc',1,80000,0,1),
  ('l10','org_1','b1','s8','otc',1,90000,0,1);
`;

suite('category growth SQL aggregation', () => {
  let client: Client;
  let db: ScopedDb;
  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query('BEGIN');
    await client.query(fixtureSql);
    db = {
      $queryRaw: async (query: Prisma.Sql) =>
        (
          await client.query(
            query.text,
            // Match Prisma's UTC date serialization for timestamp-without-time-zone columns.
            query.values.map((value) => (value instanceof Date ? value.toISOString() : value))
          )
        ).rows,
    } as unknown as ScopedDb;
  });
  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('preserves mixed, prescription-only and empty branch totals with scoped receipt evidence', async () => {
    const report = await readPharmacyCategoryGrowthReport(db, 'org_1', {
      branchIds: ['b1', 'b2', 'empty'],
      from: '2026-10-01',
      to: '2026-10-09',
      configuration: [],
    });
    expect(report[0]).toMatchObject({
      branchId: 'b1',
      totalSalesMinor: 20000,
      categories: [
        { category: 'OTC', salesMinor: 9000, units: 100, salesSharePercent: 45 },
        { category: 'COSMETICS', salesMinor: 1000, units: 2, salesSharePercent: 5 },
      ],
    });
    expect(report[1]).toMatchObject({
      branchId: 'b2',
      totalSalesMinor: 30000,
      categories: [
        { category: 'OTC', salesMinor: 0, units: 0, salesSharePercent: 0 },
        { category: 'COSMETICS', salesMinor: 0, units: 0, salesSharePercent: 0 },
      ],
    });
    expect(report[2]).toMatchObject({ branchId: 'empty', totalSalesMinor: 0 });
    expect(report[2].categories.every((category) => category.salesMinor === 0)).toBe(true);
  });
});
