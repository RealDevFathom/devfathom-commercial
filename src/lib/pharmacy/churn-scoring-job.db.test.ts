// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// Only the raw aggregation runs here; the scheduler's DB wrappers are not used.
vi.mock('@/lib/tenancy/scoped-db', () => ({}));
vi.mock('@/lib/entitlements', () => ({}));

import { readBranchChurnInputs } from './churn-scoring-job';

// Temp tables shadow the production names on this connection; rollback removes all fixtures.
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const fixtureSql = `
CREATE TEMP TABLE pharmacy_sales (
  id text, "organizationId" text, "branchId" text, status text, "customerId" text,
  "completedAt" timestamp(3)
);
CREATE TEMP TABLE pharmacy_sale_lines (
  id text, "organizationId" text, "branchId" text, "saleId" text,
  quantity int, "unitPriceMinor" int, "grossMinor" int, "discountMinor" int
);
CREATE TEMP TABLE pharmacy_sale_returns (
  id text, "organizationId" text, "branchId" text, "originalSaleId" text
);
INSERT INTO pharmacy_sales VALUES
  ('s1','org_1','b1','COMPLETED','c1','2026-10-30 10:00'),
  ('s2','org_1','b1','COMPLETED','c1','2025-06-01 10:00'),
  ('s3','org_1','b1','COMPLETED','c1','2026-10-31 10:00'),
  ('s4','org_1','b1','OPEN','c2','2026-10-30 10:00'),
  ('s5','org_1','b1','COMPLETED','c2','2026-12-01 10:00'),
  ('s6','org_1','b1','COMPLETED','c3','2026-09-01 10:00'),
  ('s7','org_1','b1','COMPLETED',NULL,'2026-10-30 10:00'),
  ('s8','org_2','b1','COMPLETED','c1','2026-10-31 10:00'),
  ('s9','org_1','b2','COMPLETED','c1','2026-10-31 10:00'),
  ('s10','org_1','b1','COMPLETED','c4','2025-01-01 10:00');
INSERT INTO pharmacy_sale_lines VALUES
  -- Mixed-lot line (#636): charged 240, not 3 x 100; less a 40 discount.
  ('l1','org_1','b1','s1',3,100,240,40),
  -- Historical line without a gross snapshot falls back to quantity x price.
  ('l2','org_1','b1','s1',1,500,NULL,0),
  ('l3','org_1','b1','s2',1,1000,1000,0),
  ('l4','org_1','b1','s3',1,9000,9000,0),
  ('l5','org_1','b1','s5',1,9000,9000,0),
  ('l6','org_1','b1','s6',1,100,100,500),
  ('l7','org_1','b1','s7',1,9000,9000,0),
  ('l8','org_2','b1','s8',1,9000,9000,0),
  ('l9','org_1','b2','s9',1,9000,9000,0),
  ('l10','org_1','b1','s10',1,700,700,0);
INSERT INTO pharmacy_sale_returns VALUES ('r3','org_1','b1','s3');
`;

suite('churn scoring SQL aggregation (#729)', () => {
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

  it('aggregates only completed, unreturned, in-scope receipts at the charged value', async () => {
    const rows = await readBranchChurnInputs(
      db,
      { organizationId: 'org_1', branchId: 'b1' },
      new Date('2026-11-01T12:00:00Z')
    );
    expect(
      rows.map(({ customerId, frequency, monetaryMinor }) => ({
        customerId,
        frequency,
        monetaryMinor,
      }))
    ).toEqual([
      // s1 only: s2 is outside the window, s3 was returned. 240 - 40 + 500.
      { customerId: 'c1', frequency: 1, monetaryMinor: BigInt(700) },
      // Net-negative receipt value is floored at zero.
      { customerId: 'c3', frequency: 1, monetaryMinor: BigInt(0) },
      // Lapsed customer: known recency, nothing in the trailing window.
      { customerId: 'c4', frequency: 0, monetaryMinor: BigInt(0) },
    ]);
    for (const row of rows) expect(row.lastCompletedAt).toBeInstanceOf(Date);
    // c1's recency comes from s1 (30 Oct), not the returned s3 or other
    // tenants/branches (31 Oct). pg reads timestamp(3) in local time.
    const c1 = rows.find((row) => row.customerId === 'c1')!;
    expect([c1.lastCompletedAt.getMonth(), c1.lastCompletedAt.getDate()]).toEqual([9, 30]);
  });
});
