// @vitest-environment node
import { Client, types } from 'pg';
import { expect, it, vi } from 'vitest';
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: vi.fn() }));
import { customerMetricsQuery } from './metrics';
import { calculateChurn } from './churn';
import { nextRefillDueAt } from './refill';

// Opt in against a disposable/local PostgreSQL connection. All fixture tables are
// temporary and the transaction is rolled back; no application data is touched.
it.skipIf(!process.env.GROWTH_METRICS_TEST_DATABASE_URL)(
  'aggregates real SQL fixtures without tenant leakage or basket fanout',
  async () => {
    const client = new Client({
      connectionString: process.env.GROWTH_METRICS_TEST_DATABASE_URL,
      types: {
        // Fixture timestamps represent UTC, regardless of the runner's local timezone.
        getTypeParser: (oid) =>
          oid === types.builtins.TIMESTAMP
            ? (value: string) => new Date(`${value}Z`)
            : oid === types.builtins.INT8
              ? BigInt
              : types.getTypeParser(oid),
      },
    });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
      CREATE TEMP TABLE pharmacy_customers (id text PRIMARY KEY, "organizationId" text);
      CREATE TEMP TABLE pharmacy_sales (id text PRIMARY KEY, "organizationId" text, "customerId" text, "completedAt" timestamp, status text);
      CREATE TEMP TABLE pharmacy_sale_lines (id text PRIMARY KEY, "organizationId" text, "saleId" text, "medicineId" text, quantity int, "unitPriceMinor" int, "discountMinor" int, "canonicalUnits" int);
      CREATE TEMP TABLE pharmacy_medicines (id text PRIMARY KEY, rx boolean);
      CREATE TEMP TABLE pharmacy_pharmacist_review_items ("organizationId" text, "saleLineId" text, "prescriptionLineId" text);
      CREATE TEMP TABLE pharmacy_prescription_lines (id text PRIMARY KEY, "organizationId" text, directions text);
      INSERT INTO pharmacy_customers SELECT id, 'org_fixture' FROM unnest(ARRAY['never','low','medium','high','lost','refill']) id;
      INSERT INTO pharmacy_customers VALUES ('foreign', 'org_other');
      INSERT INTO pharmacy_medicines VALUES ('rx', true), ('otc', false);
      INSERT INTO pharmacy_sales
      SELECT c.id || '-' || n, c."organizationId", c.id,
        timestamp '2026-10-21' - ((CASE c.id WHEN 'low' THEN 5 WHEN 'medium' THEN 40 WHEN 'high' THEN 55 WHEN 'lost' THEN 100 ELSE 1 END) + n*30) * interval '1 day', 'COMPLETED'
      FROM pharmacy_customers c CROSS JOIN generate_series(0,2) n WHERE c.id <> 'never' AND (c.id <> 'refill' OR n = 0);
      INSERT INTO pharmacy_sale_lines SELECT id || '-a', "organizationId", id, CASE WHEN "customerId" = 'refill' THEN 'rx' ELSE 'otc' END, 2, 1000, 100, 60 FROM pharmacy_sales;
      INSERT INTO pharmacy_sale_lines SELECT id || '-b', "organizationId", id, 'otc', 1, 200, 0, 1 FROM pharmacy_sales;
      INSERT INTO pharmacy_prescription_lines VALUES ('p', 'org_fixture', 'one tablet twice daily');
      INSERT INTO pharmacy_pharmacist_review_items VALUES ('org_fixture', 'refill-0-a', 'p');
      INSERT INTO pharmacy_sales VALUES ('open', 'org_fixture', 'never', timestamp '2026-10-21', 'OPEN'), ('future', 'org_fixture', 'never', timestamp '2026-10-22', 'COMPLETED');
    `);
      const now = new Date('2026-10-21T00:00:00Z');
      const sql = customerMetricsQuery('org_fixture', now);
      const { rows } = await client.query(sql.text, sql.values);
      expect(rows).toHaveLength(6);
      const byId = Object.fromEntries(rows.map((row) => [row.customerId, row]));
      expect(byId.never).toMatchObject({
        orders90d: 0,
        totalOrders: 0,
        spend90dMinor: BigInt(0),
        lastPurchaseAt: null,
        medianGapDays: null,
      });
      expect(byId.low).toMatchObject({
        orders90d: 3,
        totalOrders: 3,
        spend90dMinor: BigInt(6300),
        medianGapDays: 30,
      });
      expect(byId.lost).toMatchObject({ orders90d: 0, totalOrders: 3, spend90dMinor: BigInt(0) });
      for (const band of ['low', 'medium', 'high', 'lost'])
        expect(calculateChurn(byId[band], now).churnBand).toBe(band);
      expect(
        nextRefillDueAt(
          byId.refill.refillSoldAt,
          byId.refill.refillQuantity,
          byId.refill.directions
        )
      ).toEqual(new Date('2026-11-19T00:00:00Z'));
      expect((await client.query(sql.text, sql.values)).rows).toEqual(rows);
      await client.query(
        `UPDATE pharmacy_sale_lines SET "unitPriceMinor" = 1000000000 WHERE "saleId" = 'low-0'`
      );
      const largeSpend = (await client.query(sql.text, sql.values)).rows.find(
        (row) => row.customerId === 'low'
      );
      expect(largeSpend.spend90dMinor).toBe(BigInt(3000004100));
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  }
);
