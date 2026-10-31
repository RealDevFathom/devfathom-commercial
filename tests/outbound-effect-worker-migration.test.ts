import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const migrationPath = 'prisma/migrations/20261029000361_outbound_effect_worker/migration.sql';
const migration = readFileSync(migrationPath, 'utf8');
const recursiveRepairPath =
  'prisma/migrations/20261029000345_recursively_scrub_outbound_effect_credentials/migration.sql';
const recursiveRepair = readFileSync(recursiveRepairPath, 'utf8');

describe('outbound effect worker migration', () => {
  it('uses its reserved unique timestamp after the pharmacy register migrations', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migrationNames = readdirSync('prisma/migrations');
    expect(migrationNames.filter((name) => name.startsWith('20261029000361_'))).toEqual([
      '20261029000361_outbound_effect_worker',
    ]);
    expect(existsSync('prisma/migrations/20261021140000_outbound_effect_worker')).toBe(false);
    expect(existsSync('prisma/migrations/20261021150000_outbound_effect_worker')).toBe(false);
  });

  it('schedules retries, strips webhook copies, and deletes leftover secrets', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "availableAt"');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS "outbound_effects_status_check"');
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS "outbound_effects_status_available_idx"'
    );
    expect(migration).toContain(`'DEAD'`);
    const setting = migration.indexOf(`set_config('app.is_platform_admin', 'true', true)`);
    const update = migration.indexOf('UPDATE "outbound_effects"');
    const removeFailed = migration.indexOf(
      `DELETE FROM "outbound_effects" WHERE status = 'FAILED'`
    );
    expect(setting).toBeGreaterThan(0);
    expect(setting).toBeLessThan(update);
    expect(update).toBeLessThan(removeFailed);
    expect(migration).toContain(`payload - 'secret' - 'url'`);
    expect(migration).toContain(`DELETE FROM "rate_limit_buckets" WHERE key !~ '^[0-9a-f]{64}$'`);
  });
});

describe('recursive outbound effect credential repair migration', () => {
  it('recursively strips secret and url keys from objects and arrays', () => {
    expect(existsSync(recursiveRepairPath)).toBe(true);
    expect(recursiveRepair).toContain(`entry.key NOT IN ('secret', 'url')`);
    expect(recursiveRepair).toContain('jsonb_each(value)');
    expect(recursiveRepair).toContain('jsonb_array_elements(value) WITH ORDINALITY');
    expect(recursiveRepair).toContain('SET payload = "scrub_outbound_effect_credentials"(payload)');
    expect(recursiveRepair).toContain(`WHERE kind = 'webhook'`);
  });
});

const HEX_KEY = 'ab'.repeat(32);
const RAW_KEY = 'login:acct:person@example.com';

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
  const candidates = [
    process.env.SUPERUSER_URL,
    'postgresql://postgres@127.0.0.1:5432/postgres',
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const probe = new pg.Client({ connectionString: candidate, connectionTimeoutMillis: 1_000 });
    try {
      await probe.connect();
      const result = await probe.query<{ rolsuper: boolean }>(
        'SELECT rolsuper FROM pg_roles WHERE rolname = current_user'
      );
      await probe.end();
      if (result.rows[0]?.rolsuper) return candidate;
    } catch {
      await probe.end().catch(() => undefined);
    }
  }
  return null;
}

describe('outbound effect worker migration under forced RLS', () => {
  it('scrubs seeded secrets when a non-bypass owner runs the migration', async () => {
    const adminUrl = await superuserUrl();
    if (!adminUrl) {
      if (process.env.CI) {
        throw new Error(
          'A superuser database URL is required to prove migration cleanup under FORCE RLS.'
        );
      }
      return;
    }

    const suffix = randomBytes(6).toString('hex');
    const database = `outbox_mig_test_${suffix}`;
    const role = `outbox_mig_${suffix}`;
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
          CREATE TABLE "outbound_effects" (
            "id" TEXT PRIMARY KEY,
            "organizationId" TEXT NOT NULL,
            "kind" TEXT NOT NULL,
            "payload" JSONB NOT NULL,
            "status" TEXT NOT NULL DEFAULT 'PENDING',
            "attempts" INTEGER NOT NULL DEFAULT 0,
            "lastError" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL,
            CONSTRAINT "outbound_effects_kind_check" CHECK ("kind" IN ('email', 'webhook')),
            CONSTRAINT "outbound_effects_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED'))
          );
          ALTER TABLE "outbound_effects" ENABLE ROW LEVEL SECURITY;
          ALTER TABLE "outbound_effects" FORCE ROW LEVEL SECURITY;
          CREATE POLICY tenant_isolation ON "outbound_effects"
            USING (
              current_setting('app.is_platform_admin', true) = 'true' OR
              "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
            )
            WITH CHECK (
              current_setting('app.is_platform_admin', true) = 'true' OR
              "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
            );
          CREATE TABLE "rate_limit_buckets" (
            "key" TEXT PRIMARY KEY,
            "count" INTEGER NOT NULL,
            "resetAt" TIMESTAMPTZ NOT NULL
          );
        `)
      );

      await asRole(owner, role, async () => {
        await owner.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
        await owner.query(
          `INSERT INTO "outbound_effects"
             (id, "organizationId", kind, payload, status, attempts, "updatedAt")
           VALUES
             ($1, 'org_1', 'webhook', $2::jsonb, 'PENDING', 0, CURRENT_TIMESTAMP),
             ($3, 'org_1', 'webhook', $4::jsonb, 'FAILED', 2, CURRENT_TIMESTAMP)`,
          [
            'webhook_1',
            JSON.stringify({
              webhookId: 'wh_1',
              url: 'https://hooks.example/live',
              secret: 'super-secret-value',
              meta: {
                secret: 'nested-secret-value',
                url: 'https://hooks.example/nested',
                label: 'keep-meta',
                deliveries: [
                  { secret: 'array-secret-value', url: 'https://hooks.example/array', id: 1 },
                  'keep-scalar',
                ],
              },
              event: 'task.created',
              body: '{}',
            }),
            'failed_1',
            JSON.stringify({ secret: 'failed-secret', url: 'https://hooks.example/old' }),
          ]
        );
        await owner.query(
          `INSERT INTO "rate_limit_buckets" (key, count, "resetAt")
           VALUES ($1, 1, CURRENT_TIMESTAMP), ($2, 1, CURRENT_TIMESTAMP), ($3, 1, CURRENT_TIMESTAMP)`,
          [RAW_KEY, HEX_KEY, 'g'.repeat(64)]
        );
      });

      const hidden = await asRole(owner, role, () =>
        owner.query<{ n: number }>('SELECT count(*)::int AS n FROM "outbound_effects"')
      );
      expect(hidden.rows[0]?.n).toBe(0);

      await asRole(owner, role, async () => {
        const attributes = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
        );
        expect(attributes.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
        await owner.query(migration);
        await owner.query(recursiveRepair);
      });

      await asRole(owner, role, async () => {
        await owner.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
        const effects = await owner.query<{ id: string; payload: Record<string, unknown> }>(
          'SELECT id, payload FROM "outbound_effects" ORDER BY id'
        );
        expect(effects.rows).toEqual([
          {
            id: 'webhook_1',
            payload: {
              webhookId: 'wh_1',
              meta: { label: 'keep-meta', deliveries: [{ id: 1 }, 'keep-scalar'] },
              event: 'task.created',
              body: '{}',
            },
          },
        ]);
        expect(JSON.stringify(effects.rows)).not.toMatch(
          /super-secret-value|nested-secret-value|array-secret-value|failed-secret|hooks\.example/
        );
        const keys = await owner.query<{ key: string }>(
          'SELECT key FROM "rate_limit_buckets" ORDER BY key'
        );
        expect(keys.rows.map((row) => row.key)).toEqual([HEX_KEY]);
      });

      await asRole(owner, role, async () => {
        await owner.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
        await owner.query(
          `INSERT INTO "outbound_effects"
             (id, "organizationId", kind, payload, status, attempts, "updatedAt")
           VALUES ($1, 'org_1', 'webhook', $2::jsonb, 'PENDING', 0, CURRENT_TIMESTAMP)`,
          [
            'webhook_2',
            JSON.stringify({
              webhookId: 'wh_2',
              secret: 'second-secret',
              url: 'https://hooks.example/again',
              event: 'task.created',
              body: '{}',
            }),
          ]
        );
      });
      await asRole(owner, role, () => owner.query(migration));
      await asRole(owner, role, () => owner.query(recursiveRepair));
      await asRole(owner, role, async () => {
        await owner.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
        const again = await owner.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM "outbound_effects" WHERE id = 'webhook_2'`
        );
        expect(again.rows[0]?.payload).toEqual({
          webhookId: 'wh_2',
          event: 'task.created',
          body: '{}',
        });
        expect(JSON.stringify(again.rows)).not.toContain('second-secret');
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

async function asRole<T>(client: pg.Client, role: string, run: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  await client.query(`SET LOCAL ROLE ${quoteIdent(role)}`);
  try {
    const value = await run();
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
