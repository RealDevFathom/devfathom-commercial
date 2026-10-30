// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { splitSqlStatements } from './split-sql-statements';

const databaseUrl = process.env.M8_TEST_OWNER_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;
const sql = readFileSync(
  'prisma/migrations/20261026120200_preserve_offline_stock_quotas/migration.sql',
  'utf8'
);

// Exercise replacement of the real legacy guards, including the balance
// projection-only trigger that must be restored after a successful backfill.
function legacyStatement(file: string, declaration: string) {
  const statement = splitSqlStatements(
    readFileSync(`prisma/migrations/${file}/migration.sql`, 'utf8')
  ).find((statement) => statement.includes(declaration));
  if (!statement) throw new Error(`Missing legacy declaration: ${declaration}`);
  return statement.slice(statement.indexOf(declaration));
}

async function withLegacyDatabase(work: (client: Client) => Promise<void>) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const schema = `offline_quota_${randomUUID().replaceAll('-', '')}`;
  try {
    // A superuser would make the forced-RLS regression pass for the wrong reason.
    const {
      rows: [role],
    } = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(`
      SELECT set_config('app.is_platform_admin', 'true', true);
      CREATE TABLE pharmacy_stock_balances (
        "organizationId" text NOT NULL, "branchId" text NOT NULL,
        "inventoryLotId" text NOT NULL, "stockLocationId" text NOT NULL,
        disposition text NOT NULL, "onHandUnits" integer NOT NULL,
        CONSTRAINT pharmacy_stock_balances_non_negative_check CHECK ("onHandUnits" >= 0),
        PRIMARY KEY ("organizationId", "branchId", "inventoryLotId", "stockLocationId", disposition)
      );
      CREATE TABLE pharmacy_device_lot_quotas (
        id text PRIMARY KEY, "organizationId" text NOT NULL, "branchId" text NOT NULL,
        "deviceId" text NOT NULL, "inventoryLotId" text NOT NULL, "stockLocationId" text NOT NULL,
        "quotaUnits" integer NOT NULL, "consumedUnits" integer NOT NULL,
        "releasedAt" timestamp, "grantedAt" timestamp NOT NULL DEFAULT now()
      );
      INSERT INTO pharmacy_stock_balances VALUES
        ('org-a', 'branch-a', 'lot-a', 'store-a', 'AVAILABLE', 10),
        ('org-b', 'branch-b', 'lot-b', 'store-b', 'AVAILABLE', 10),
        ('org-a', 'branch-a', 'lot-empty', 'store-a', 'AVAILABLE', 2);
      INSERT INTO pharmacy_device_lot_quotas
        (id, "organizationId", "branchId", "deviceId", "inventoryLotId", "stockLocationId",
         "quotaUnits", "consumedUnits", "releasedAt") VALUES
        ('a1', 'org-a', 'branch-a', 'device-a1', 'lot-a', 'store-a', 5, 1, NULL),
        ('a2', 'org-a', 'branch-a', 'device-a2', 'lot-a', 'store-a', 3, 1, NULL),
        ('released', 'org-a', 'branch-a', 'device-a3', 'lot-a', 'store-a', 9, 0, now()),
        ('b1', 'org-b', 'branch-b', 'device-b1', 'lot-b', 'store-b', 7, 2, NULL);
    `);
    for (const table of ['pharmacy_stock_balances', 'pharmacy_device_lot_quotas']) {
      await client.query(`
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON ${table}
          USING (current_setting('app.is_platform_admin', true) = 'true'
            OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
          WITH CHECK (current_setting('app.is_platform_admin', true) = 'true'
            OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
      `);
    }
    const quotaMigration = '20260902200000_pharmacy_offline_counter_runtime';
    const ledgerMigration = '20260902130000_pharmacy_batch_stock_ledger';
    for (const declaration of [
      'CREATE FUNCTION guard_pharmacy_device_lot_quota()',
      'CREATE TRIGGER "pharmacy_device_lot_quotas_capacity_guard"',
      'CREATE FUNCTION guard_pharmacy_device_lot_quota_update()',
      'CREATE TRIGGER "pharmacy_device_lot_quotas_update_guard"',
    ])
      await client.query(legacyStatement(quotaMigration, declaration));
    for (const declaration of [
      'CREATE FUNCTION pharmacy_reject_direct_balance_write()',
      'CREATE TRIGGER pharmacy_stock_balances_projection_only',
    ])
      await client.query(legacyStatement(ledgerMigration, declaration));
    // A minimal ledger driver reaches the real balance guards at trigger depth 2.
    // The integrated offline/stock-ledger suites cover the full movement schema.
    await client.query(`
      CREATE TABLE movements (units integer NOT NULL);
      CREATE FUNCTION apply_movement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE pharmacy_stock_balances SET "onHandUnits" = "onHandUnits" + NEW.units
        WHERE "inventoryLotId" = 'lot-a' AND disposition = 'AVAILABLE';
        RETURN NEW;
      END $$;
      CREATE TRIGGER movement_applies AFTER INSERT ON movements
        FOR EACH ROW EXECUTE FUNCTION apply_movement();
      SELECT set_config('app.is_platform_admin', 'false', true);
      SELECT set_config('app.current_organization_id', '', true);
    `);
    expect((await client.query('SELECT * FROM pharmacy_device_lot_quotas')).rows).toEqual([]);
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}

async function expectRejected(client: Client, query: string, message: RegExp) {
  await client.query('SAVEPOINT expected_failure');
  await expect(client.query(query)).rejects.toThrow(message);
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
  await client.query('RELEASE SAVEPOINT expected_failure');
}

describeIfDatabase('offline quota reservation migration', () => {
  it('reports a legacy over-reservation across forced RLS before adding the projection', async () => {
    await withLegacyDatabase(async (client) => {
      // Make org-b inconsistent; no tenant is selected when the migration runs.
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      await client.query('ALTER TABLE pharmacy_stock_balances DISABLE TRIGGER USER');
      await client.query(
        `UPDATE pharmacy_stock_balances SET "onHandUnits" = 2 WHERE "organizationId" = 'org-b'`
      );
      await client.query('ALTER TABLE pharmacy_stock_balances ENABLE TRIGGER USER');
      await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
      const failure = await client.query(sql).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        message: expect.stringMatching(/OFFLINE_QUOTA_BACKFILL_REQUIRES_RECONCILIATION/),
        detail: expect.stringContaining('organizationId=org-b'),
        hint: expect.stringContaining('release excess open quotas'),
      });
      expect(failure).toMatchObject({ detail: expect.stringContaining('outstanding=5 onHand=2') });
    });
  });

  it('backfills all tenants and preserves consumption, release, movement and projection guards', async () => {
    await withLegacyDatabase(async (client) => {
      await client.query(sql);
      expect(
        (
          await client.query(`
        SELECT "inventoryLotId", "offlineReservedUnits" FROM pharmacy_stock_balances
        ORDER BY "inventoryLotId"
      `)
        ).rows
      ).toEqual([
        { inventoryLotId: 'lot-a', offlineReservedUnits: 6 },
        { inventoryLotId: 'lot-b', offlineReservedUnits: 5 },
        { inventoryLotId: 'lot-empty', offlineReservedUnits: 0 },
      ]);
      const {
        rows: [trigger],
      } = await client.query(`
        SELECT tgenabled, (tgtype::int & 2) = 0 AS "isAfter" FROM pg_trigger
        WHERE tgrelid = 'pharmacy_device_lot_quotas'::regclass
          AND tgname = 'pharmacy_device_lot_quotas_capacity_guard'
      `);
      expect(trigger).toEqual({ tgenabled: 'O', isAfter: true });
      await client.query(`
        SELECT set_config('app.is_platform_admin', 'false', true);
        SELECT set_config('app.current_organization_id', 'org-a', true);
      `);
      expect(
        (await client.query('SELECT DISTINCT "organizationId" FROM pharmacy_stock_balances')).rows
      ).toEqual([{ organizationId: 'org-a' }]);
      await expectRejected(
        client,
        'INSERT INTO movements VALUES (-5)',
        /OFFLINE_QUOTA_RESERVES_STOCK/
      );
      await client.query('INSERT INTO movements VALUES (-4)');
      await client.query(
        `UPDATE pharmacy_device_lot_quotas SET "consumedUnits" = 3 WHERE id = 'a1'`
      );
      await client.query('INSERT INTO movements VALUES (-2)');
      await client.query(
        `UPDATE pharmacy_device_lot_quotas SET "releasedAt" = now() WHERE id = 'a2'`
      );
      expect(
        (
          await client.query(`SELECT "onHandUnits", "offlineReservedUnits"
        FROM pharmacy_stock_balances WHERE "inventoryLotId" = 'lot-a'`)
        ).rows
      ).toEqual([{ onHandUnits: 4, offlineReservedUnits: 2 }]);
      await expectRejected(
        client,
        `UPDATE pharmacy_device_lot_quotas SET "consumedUnits" = 0 WHERE id = 'a1'`,
        /QUOTA_CONSUMPTION_MONOTONIC/
      );
      await expectRejected(
        client,
        `UPDATE pharmacy_device_lot_quotas SET "releasedAt" = NULL WHERE id = 'a2'`,
        /QUOTA_ALREADY_RELEASED/
      );
      await expectRejected(
        client,
        'UPDATE pharmacy_stock_balances SET "onHandUnits" = 99',
        /stock balances are a projection/
      );
      await client.query(
        `UPDATE pharmacy_device_lot_quotas SET "releasedAt" = now() WHERE id = 'a1'`
      );
      await client.query('INSERT INTO movements VALUES (-4)');
      await expectRejected(client, 'INSERT INTO movements VALUES (-1)', /non_negative_check/);
    });
  });
});
