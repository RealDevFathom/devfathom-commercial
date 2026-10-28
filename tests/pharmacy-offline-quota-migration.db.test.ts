// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { splitSqlStatements } from './split-sql-statements';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;
const sql = readFileSync(
  'prisma/migrations/20261026120200_preserve_offline_stock_quotas/migration.sql',
  'utf8'
);

describeIfDatabase('offline quota reservation migration', () => {
  it('reports a legacy over-reservation before adding the projection constraint', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const schema = `offline_quota_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE pharmacy_stock_balances (
          "organizationId" text NOT NULL, "branchId" text NOT NULL,
          "inventoryLotId" text NOT NULL, "stockLocationId" text NOT NULL,
          disposition text NOT NULL, "onHandUnits" integer NOT NULL
        );
        CREATE TABLE pharmacy_device_lot_quotas (
          "organizationId" text NOT NULL, "branchId" text NOT NULL,
          "inventoryLotId" text NOT NULL, "stockLocationId" text NOT NULL,
          "quotaUnits" integer NOT NULL, "consumedUnits" integer NOT NULL,
          "releasedAt" timestamp
        );
        INSERT INTO pharmacy_stock_balances VALUES ('org-a', 'branch-a', 'lot-a', 'store-a', 'AVAILABLE', 2);
        INSERT INTO pharmacy_device_lot_quotas VALUES ('org-a', 'branch-a', 'lot-a', 'store-a', 5, 1, NULL);
      `);

      const statements = splitSqlStatements(sql);
      await client.query(statements[0]!);
      await client.query(statements[1]!);
      const failure = await client.query(statements[2]!).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        message: expect.stringMatching(/OFFLINE_QUOTA_BACKFILL_REQUIRES_RECONCILIATION/),
        detail: expect.stringContaining('outstanding=4 onHand=2'),
        hint: expect.stringContaining('release excess open quotas'),
      });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
