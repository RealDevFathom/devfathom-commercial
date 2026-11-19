// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readPharmacyCategoryGrowthReport } from './category-growth-report';

// Temp tables shadow the production names on this connection; rollback removes all fixtures.
// DEV-945: each shadow is built LIKE the migrated table, so the fixture carries exactly the real
// columns (and their NOT NULL rules). A query that reads a column the real table does not have
// fails here, instead of passing against a hand-written table that has drifted from the schema.
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const lineColumns = `(id, "organizationId", "branchId", "saleId", "medicineId", "presentationId",
  "packLevelId", "saleUnit", quantity, "canonicalUnitsPerSaleUnit", "canonicalUnits",
  "unitPriceMinor", "proRataCeilingMinor", "unitCostMinor", "idempotencyKey", "grossMinor",
  "discountMinor", "tierDiscountMinor")`;
// One line: id, org, branch, sale, medicine, quantity, canonical units, unit price, gross charged,
// discount (all kinds, a prepaid tier included), and the tier's share of that discount.
const line = (
  id: string,
  org: string,
  branch: string,
  sale: string,
  medicine: string,
  quantity: number,
  units: number,
  unitPrice: number,
  gross: number,
  discount: number,
  tierDiscount = 0
) =>
  `('${id}','${org}','${branch}','${sale}','${medicine}','pres','pack','UNIT',${quantity},` +
  `${units / quantity},${units},${unitPrice},${unitPrice},1,'${id}',${gross},${discount},${tierDiscount})`;

const fixtureSql = `
CREATE TEMP TABLE pharmacy_sale_lines (LIKE public.pharmacy_sale_lines INCLUDING DEFAULTS);
CREATE TEMP TABLE pharmacy_sales (LIKE public.pharmacy_sales INCLUDING DEFAULTS);
CREATE TEMP TABLE pharmacy_medicines (LIKE public.pharmacy_medicines INCLUDING DEFAULTS);
INSERT INTO pharmacy_medicines (id, "organizationId", "productName", "productFamily", otc, "updatedAt") VALUES
  ('otc','org_1','OTC item','PHARMACEUTICAL',true,now()),
  ('cos','org_1','Front-shop item','FRONT_SHOP',true,now()),
  ('rx','org_1','Prescription item','PHARMACEUTICAL',false,now()),
  ('foreign','org_2','Other tenant item','FRONT_SHOP',true,now());
INSERT INTO pharmacy_sales (id, "organizationId", "branchId", status, "receiptNumber", "completedAt", "createdByUserId", "updatedAt") VALUES
  ('s1','org_1','b1','COMPLETED',1,'2026-10-01','u',now()),
  ('s2','org_1','b2','COMPLETED',2,'2026-10-02','u',now()),
  ('s3','org_1','b3','COMPLETED',3,'2026-10-02','u',now()),
  ('s4','org_2','b1','COMPLETED',4,'2026-10-02','u',now()),
  ('s5','org_1','b1','OPEN',null,'2026-10-02','u',now()),
  ('s6','org_1','b1','COMPLETED',null,'2026-10-02','u',now()),
  ('s7','org_1','b1','COMPLETED',7,'2026-10-09','u',now()),
  ('s8','org_1','b1','COMPLETED',8,'2026-09-30','u',now()),
  ('s9','org_1','b4','COMPLETED',9,'2026-10-03','u',now()),
  ('s10','org_1','b4','VOID',10,'2026-10-03','u',now()),
  ('s11','org_1','b4','HELD',null,'2026-10-03','u',now()),
  ('s12','org_1','b5','COMPLETED',12,'2026-09-30 19:30','u',now()),
  ('s13','org_1','b5','COMPLETED',13,'2026-10-08 20:00','u',now());
INSERT INTO pharmacy_sale_lines ${lineColumns} VALUES
  ${line('l1', 'org_1', 'b1', 's1', 'otc', 10, 100, 1000, 10000, 1000)},
  ${line('l2', 'org_1', 'b1', 's1', 'cos', 2, 2, 500, 1000, 0)},
  ${line('l3', 'org_1', 'b1', 's1', 'rx', 5, 50, 2000, 10000, 0)},
  ${line('l4', 'org_1', 'b2', 's2', 'rx', 3, 3, 10000, 30000, 0)},
  ${line('l5', 'org_1', 'b3', 's3', 'otc', 1, 1, 50000, 50000, 0)},
  ${line('l6', 'org_2', 'b1', 's4', 'foreign', 1, 1, 90000, 90000, 0)},
  ${line('l7', 'org_1', 'b1', 's5', 'otc', 1, 1, 60000, 60000, 0)},
  ${line('l8', 'org_1', 'b1', 's6', 'otc', 1, 1, 70000, 70000, 0)},
  ${line('l9', 'org_1', 'b1', 's7', 'otc', 1, 1, 80000, 80000, 0)},
  ${line('l10', 'org_1', 'b1', 's8', 'otc', 1, 1, 90000, 90000, 0)},
  ${line('l11', 'org_1', 'b4', 's9', 'otc', 3, 30, 1000, 2950, 450, 200)},
  ${line('l12', 'org_1', 'b4', 's9', 'cos', 1, 1, 1500, 1500, 0)},
  ${line('l13', 'org_1', 'b4', 's9', 'rx', 2, 20, 3000, 6000, 0)},
  ${line('l14', 'org_1', 'b4', 's10', 'otc', 1, 1, 40000, 40000, 0)},
  ${line('l15', 'org_1', 'b4', 's11', 'cos', 1, 1, 40000, 40000, 0)},
  ${line('l16', 'org_1', 'b5', 's12', 'otc', 1, 1, 700, 700, 0)},
  ${line('l17', 'org_1', 'b5', 's12', 'rx', 1, 1, 300, 300, 0)},
  ${line('l18', 'org_1', 'b5', 's13', 'cos', 1, 1, 5000, 5000, 0)};
`;

function pgDb(client: Client) {
  return {
    $queryRaw: async (query: Prisma.Sql) =>
      (
        await client.query(
          query.text,
          // Match Prisma's UTC date serialization for timestamp-without-time-zone columns.
          query.values.map((value) => (value instanceof Date ? value.toISOString() : value))
        )
      ).rows,
  } as unknown as ScopedDb;
}

suite('category growth SQL aggregation', () => {
  let client: Client;
  let db: ScopedDb;
  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query('BEGIN');
    await client.query(fixtureSql);
    db = pgDb(client);
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

  it('values each line at its charged gross after every discount, and counts completed receipts only', async () => {
    const report = await readPharmacyCategoryGrowthReport(db, 'org_1', {
      branchIds: ['b4'],
      from: '2026-10-01',
      to: '2026-10-09',
      configuration: [
        { category: 'OTC', displaySpaceSquareMetres: 2, targetSalesSharePercent: 30 },
        { category: 'COSMETICS', displaySpaceSquareMetres: null, targetSalesSharePercent: null },
      ],
    });
    // OTC: mixed-lot gross 2,950 (not 3 x 1,000) less 450 discount, of which 200 is a prepaid tier
    // = 2,500. Front shop 1,500. Prescription 6,000 counts toward the branch total only. The VOID
    // and HELD bills on the same day are excluded.
    expect(report).toEqual([
      {
        branchId: 'b4',
        salesBasis: 'GROSS_COMPLETED_RECEIPTS_WORKSPACE_DAY_COMPLETED_AT',
        totalSalesMinor: 10000,
        categories: [
          expect.objectContaining({
            category: 'OTC',
            salesMinor: 2500,
            units: 30,
            salesSharePercent: 25,
            displaySpaceSquareMetres: 2,
            salesMinorPerSquareMetre: 1250,
            targetSalesSharePercent: 30,
            shareGapPercentagePoints: 5,
          }),
          expect.objectContaining({
            category: 'COSMETICS',
            salesMinor: 1500,
            units: 1,
            salesSharePercent: 15,
            salesMinorPerSquareMetre: null,
            shareGapPercentagePoints: null,
          }),
        ],
      },
    ]);
  });

  it("windows completed receipts on the shop's own days", async () => {
    const report = await readPharmacyCategoryGrowthReport(db, 'org_1', {
      branchIds: ['b5'],
      from: '2026-10-01',
      to: '2026-10-09',
      configuration: [],
      timeZone: 'Asia/Karachi',
    });
    // 2026-09-30 19:30 UTC is 00:30 on 1 October in Karachi (inside); 2026-10-08 20:00 UTC is
    // 01:00 on 9 October (outside the exclusive cutoff).
    expect(report[0]).toMatchObject({
      branchId: 'b5',
      totalSalesMinor: 1000,
      categories: [
        { category: 'OTC', salesMinor: 700, units: 1, salesSharePercent: 70 },
        { category: 'COSMETICS', salesMinor: 0, units: 0, salesSharePercent: 0 },
      ],
    });
  });

  it('runs against the migrated tables themselves, under row-level security', async () => {
    // A separate connection has no temp shadows, so this reads the real relations.
    const real = new Client({ connectionString: url });
    await real.connect();
    try {
      await real.query('BEGIN');
      await real.query(`SELECT set_config('app.current_organization_id', 'dev945_no_rows', true)`);
      const report = await readPharmacyCategoryGrowthReport(pgDb(real), 'dev945_no_rows', {
        branchIds: ['dev945_branch'],
        from: '2026-10-01',
        to: '2026-10-09',
        configuration: [],
      });
      expect(report).toMatchObject([{ branchId: 'dev945_branch', totalSalesMinor: 0 }]);
    } finally {
      await real.query('ROLLBACK');
      await real.end();
    }
  });
});
