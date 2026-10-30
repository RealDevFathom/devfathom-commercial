import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261029000265_pharmacy_offline_command_fifo/migration.sql',
  'utf8'
);

function quoteIdent(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

function databaseUrl(base: string, database: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function superuserUrl(): Promise<string | null> {
  for (const candidate of [
    process.env.SUPERUSER_URL,
    'postgresql://postgres@127.0.0.1:5432/postgres',
  ].filter((value): value is string => Boolean(value))) {
    const client = new pg.Client({ connectionString: candidate, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      const result = await client.query<{ rolsuper: boolean }>(
        'SELECT rolsuper FROM pg_roles WHERE rolname = current_user'
      );
      await client.end();
      if (result.rows[0]?.rolsuper) return candidate;
    } catch {
      await client.end().catch(() => undefined);
    }
  }
  return null;
}

async function asRole<T>(client: pg.Client, role: string, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  await client.query(`SET LOCAL ROLE ${quoteIdent(role)}`);
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

describe('pharmacy offline command FIFO migration', () => {
  it('restores forced RLS around the owner-only cross-tenant backfill', () => {
    const unforceDevice = migration.indexOf(
      'ALTER TABLE "pharmacy_registered_devices" NO FORCE ROW LEVEL SECURITY'
    );
    const unforceCommand = migration.indexOf(
      'ALTER TABLE "pharmacy_offline_commands" NO FORCE ROW LEVEL SECURITY'
    );
    const backfill = migration.indexOf('UPDATE "pharmacy_registered_devices" AS device');
    const reforceCommand = migration.indexOf(
      'ALTER TABLE "pharmacy_offline_commands" FORCE ROW LEVEL SECURITY'
    );
    const reforceDevice = migration.indexOf(
      'ALTER TABLE "pharmacy_registered_devices" FORCE ROW LEVEL SECURITY'
    );

    expect(unforceDevice).toBeGreaterThan(-1);
    expect(unforceCommand).toBeGreaterThan(unforceDevice);
    expect(backfill).toBeGreaterThan(unforceCommand);
    expect(reforceCommand).toBeGreaterThan(backfill);
    expect(reforceDevice).toBeGreaterThan(reforceCommand);
    expect(migration).toContain('command."organizationId" = device."organizationId"');
    expect(migration).toContain('command."deviceId" = device."id"');
  });

  it('backfills legacy logs and handles exhausted integer sequences as a forced-RLS owner', async () => {
    const adminUrl = await superuserUrl();
    if (!adminUrl) {
      if (process.env.CI) throw new Error('A PostgreSQL superuser URL is required for this test.');
      return;
    }

    const suffix = randomBytes(6).toString('hex');
    const database = `offline_fifo_${suffix}`;
    const role = `offline_fifo_owner_${suffix}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    const owner = new pg.Client({ connectionString: databaseUrl(adminUrl, database) });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE ${quoteIdent(role)} NOSUPERUSER NOBYPASSRLS NOLOGIN`);
      await admin.query(`CREATE DATABASE ${quoteIdent(database)}`);
      await owner.connect();
      await owner.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${quoteIdent(role)}`);

      await asRole(owner, role, () =>
        owner.query(`
          CREATE TABLE "pharmacy_registered_devices" (
            "id" text NOT NULL,
            "organizationId" text NOT NULL,
            "branchId" text NOT NULL,
            PRIMARY KEY ("organizationId", "id")
          );
          CREATE TABLE "pharmacy_offline_commands" (
            "organizationId" text NOT NULL,
            "branchId" text NOT NULL,
            "deviceId" text NOT NULL,
            "sequence" integer NOT NULL,
            "idempotencyKey" text NOT NULL,
            UNIQUE ("organizationId", "deviceId", "sequence"),
            UNIQUE ("organizationId", "deviceId", "idempotencyKey")
          );
          ALTER TABLE "pharmacy_registered_devices" ENABLE ROW LEVEL SECURITY;
          ALTER TABLE "pharmacy_registered_devices" FORCE ROW LEVEL SECURITY;
          ALTER TABLE "pharmacy_offline_commands" ENABLE ROW LEVEL SECURITY;
          ALTER TABLE "pharmacy_offline_commands" FORCE ROW LEVEL SECURITY;
          CREATE POLICY device_tenant ON "pharmacy_registered_devices"
            USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
            WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
          CREATE POLICY command_tenant ON "pharmacy_offline_commands"
            USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
            WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
        `)
      );

      for (const [organization, devices, commands] of [
        [
          'org_a',
          ['contiguous', 'gapped', 'empty', 'exhausted', 'last'],
          [
            ['contiguous', 1],
            ['contiguous', 2],
            ['gapped', 1],
            ['gapped', 3],
            ['exhausted', 2147483647],
            ['last', 2147483646],
          ],
        ],
        ['org_b', ['tenant_b'], [['tenant_b', 7]]],
      ] as const) {
        await asRole(owner, role, async () => {
          await owner.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
            organization,
          ]);
          for (const device of devices) {
            await owner.query(
              `INSERT INTO "pharmacy_registered_devices" VALUES ($1, $2, 'branch')`,
              [device, organization]
            );
          }
          for (const [device, sequence] of commands) {
            await owner.query(
              `INSERT INTO "pharmacy_offline_commands" VALUES ($1, 'branch', $2, $3, $4)`,
              [organization, device, sequence, `${device}-${sequence}`]
            );
          }
        });
      }

      const hidden = await asRole(owner, role, () =>
        owner.query('SELECT count(*)::int AS count FROM "pharmacy_registered_devices"')
      );
      expect(hidden.rows[0]?.count).toBe(0);
      await asRole(owner, role, async () => {
        const attributes = await owner.query(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
        );
        expect(attributes.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
        await owner.query(migration);
      });

      await asRole(owner, role, async () => {
        await owner.query(`SELECT set_config('app.current_organization_id', 'org_a', true)`);
        const cursors = await owner.query(
          `SELECT id, "nextOfflineCommandSequence"::text AS next FROM "pharmacy_registered_devices" ORDER BY id`
        );
        expect(cursors.rows).toEqual([
          { id: 'contiguous', next: '3' },
          { id: 'empty', next: '1' },
          { id: 'exhausted', next: '2147483648' },
          { id: 'gapped', next: '4' },
          { id: 'last', next: '2147483647' },
        ]);
        await owner.query(
          `INSERT INTO "pharmacy_offline_commands" VALUES ('org_a', 'branch', 'contiguous', 3, 'contiguous-3')`
        );
        await owner.query(
          `INSERT INTO "pharmacy_offline_commands" VALUES ('org_a', 'branch', 'last', 2147483647, 'last-max')`
        );
        // Retries still work after exhaustion and must never wrap the cursor.
        await owner.query(
          `INSERT INTO "pharmacy_offline_commands" VALUES ('org_a', 'branch', 'last', 2147483647, 'last-max') ON CONFLICT DO NOTHING`
        );
        const exhausted = await owner.query(
          `SELECT "nextOfflineCommandSequence"::text AS next FROM "pharmacy_registered_devices" WHERE id = 'last'`
        );
        expect(exhausted.rows).toEqual([{ next: '2147483648' }]);
      });
      await expect(
        asRole(owner, role, async () => {
          await owner.query(`SELECT set_config('app.current_organization_id', 'org_a', true)`);
          await owner.query(
            `INSERT INTO "pharmacy_offline_commands" VALUES ('org_a', 'branch', 'exhausted', 1, 'cannot-wrap')`
          );
        })
      ).rejects.toThrow('PHARMACY_OFFLINE_SEQUENCE_OUT_OF_ORDER');
      await asRole(owner, role, async () => {
        await owner.query(`SELECT set_config('app.current_organization_id', 'org_b', true)`);
        const cursor = await owner.query(
          `SELECT "nextOfflineCommandSequence"::text AS next FROM "pharmacy_registered_devices"`
        );
        expect(cursor.rows).toEqual([{ next: '8' }]);
      });
    } finally {
      await owner.end().catch(() => undefined);
      await admin
        .query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`)
        .catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
});
