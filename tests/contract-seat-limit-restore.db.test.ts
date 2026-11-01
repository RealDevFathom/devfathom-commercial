// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migration = readFileSync(
  'prisma/migrations/20261029000376_restore_contract_overwritten_seat_limits/migration.sql',
  'utf8'
);

describe.skipIf(!databaseUrl)('contract seat restoration on PostgreSQL', () => {
  let client: Client;
  let owner: Client;
  let schema: string;

  beforeEach(async () => {
    client = new Client({ connectionString: databaseUrl });
    owner = process.env.OWNER_DATABASE_URL
      ? new Client({ connectionString: process.env.OWNER_DATABASE_URL })
      : client;
    await client.connect();
    if (owner !== client) await owner.connect();
    schema = `contract_seats_${randomUUID().replaceAll('-', '')}`;
    await owner.query(`CREATE SCHEMA "${schema}"`);
    if (owner !== client) {
      const role = (await client.query('SELECT current_user AS role')).rows[0].role;
      await owner.query(
        `GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${role.replaceAll('"', '""')}"`
      );
    }
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE organizations (id text PRIMARY KEY, "seatLimit" integer NOT NULL,
        "updatedAt" timestamp NOT NULL DEFAULT now());
      CREATE TABLE platform_contracts (id text PRIMARY KEY,
        "organizationId" text NOT NULL REFERENCES organizations, "seatLimit" integer NOT NULL);
      CREATE TABLE platform_audit_logs (id text PRIMARY KEY, "organizationId" text REFERENCES organizations,
        action text NOT NULL, "targetType" text, "targetId" text, before jsonb, after jsonb, reason text,
        success boolean NOT NULL DEFAULT true, "createdAt" timestamp NOT NULL DEFAULT now());
    `);
    for (const table of ['organizations', 'platform_contracts', 'platform_audit_logs']) {
      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await client.query(`CREATE POLICY platform_access ON ${table}
        USING (current_setting('app.is_platform_admin', true) = 'true')
        WITH CHECK (current_setting('app.is_platform_admin', true) = 'true')`);
    }
    await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
    if (owner !== client) await owner.end();
  });

  async function audit(
    org: string,
    action: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    day: number,
    success = true
  ) {
    const isContract = action.startsWith('commercial.contract.');
    await client.query(
      `INSERT INTO platform_audit_logs
        (id, "organizationId", action, "targetType", "targetId", before, after, "createdAt", success)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        org,
        action,
        isContract ? 'PlatformContract' : 'Organization',
        isContract ? `contract_${org}` : org,
        before,
        after,
        new Date(Date.UTC(2026, 9, day)),
        success,
      ]
    );
  }

  async function seed(org: string, seats = 100) {
    await client.query('INSERT INTO organizations (id, "seatLimit") VALUES ($1, $2)', [org, seats]);
    await client.query(
      'INSERT INTO platform_contracts (id, "organizationId", "seatLimit") VALUES ($1, $2, 100)',
      [`contract_${org}`, org]
    );
    await audit(org, 'organization.create', null, { seatLimit: 25 }, 1);
    await audit(org, 'commercial.contract.create', null, { seatLimit: 100, status: 'ACTIVE' }, 2);
  }

  async function snapshot() {
    return {
      seats: (await client.query('SELECT id, "seatLimit" FROM organizations ORDER BY id')).rows,
      repairs: (
        await client.query(`SELECT "organizationId", before, after FROM platform_audit_logs
        WHERE action = 'organization.seat_limit.contract_restore' ORDER BY "organizationId"`)
      ).rows,
    };
  }

  it('recovers actual seat baselines through unrelated edits and respects contract chronology', async () => {
    for (const org of [
      'notes',
      'changed',
      'manual',
      'coincidence',
      'backfill',
      'failed',
      'legacy',
      'unknown',
    ]) {
      await seed(org, org === 'manual' ? 80 : 100);
    }
    await audit(
      'notes',
      'organization.update',
      { seatLimit: 100 },
      { seatLimit: 100, notes: 'New contact' },
      3
    );
    await audit(
      'notes',
      'commercial.contract.status',
      { status: 'ACTIVE' },
      { seatLimit: 100, status: 'EXPIRED' },
      4
    );
    await audit('changed', 'organization.update', { seatLimit: 100 }, { seatLimit: 40 }, 3);
    await audit(
      'changed',
      'commercial.contract.status',
      { status: 'ACTIVE' },
      { seatLimit: 100, status: 'RENEWAL_DUE' },
      4
    );
    await audit(
      'changed',
      'organization.update',
      { seatLimit: 100 },
      { seatLimit: 100, notes: 'New notes' },
      5
    );
    await audit('manual', 'organization.update', { seatLimit: 100 }, { seatLimit: 80 }, 3);
    // An old contract matching the current limit does not establish a later overwrite.
    await audit('coincidence', 'organization.update', { seatLimit: 100 }, { seatLimit: 80 }, 3);
    await audit(
      'backfill',
      'organization.seat_limit.backfill',
      { seatLimit: 1 },
      { seatLimit: 50 },
      3
    );
    await audit(
      'backfill',
      'commercial.contract.status',
      { status: 'ACTIVE' },
      { seatLimit: 100, status: 'GRACE' },
      4
    );
    await audit('failed', 'organization.update', { seatLimit: 100 }, { seatLimit: 90 }, 5, false);
    await audit('legacy', 'organization.update', null, { seatLimit: 60 }, 3);
    await audit(
      'legacy',
      'commercial.contract.status',
      { status: 'ACTIVE' },
      { seatLimit: 100, status: 'ACTIVE' },
      4
    );
    await client.query(
      'DELETE FROM platform_audit_logs WHERE "organizationId" = $1 AND action = $2',
      ['unknown', 'organization.create']
    );

    await client.query("SELECT set_config('app.is_platform_admin', 'false', false)");
    expect((await client.query('SELECT * FROM organizations')).rowCount).toBe(0);
    await client.query(migration);
    // The migration's platform privilege must end with its transaction.
    expect((await client.query('SELECT * FROM organizations')).rowCount).toBe(0);
    await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
    const first = await snapshot();
    expect(first).toEqual({
      seats: [
        { id: 'backfill', seatLimit: 50 },
        { id: 'changed', seatLimit: 40 },
        { id: 'coincidence', seatLimit: 100 },
        { id: 'failed', seatLimit: 25 },
        { id: 'legacy', seatLimit: 60 },
        { id: 'manual', seatLimit: 80 },
        { id: 'notes', seatLimit: 25 },
        { id: 'unknown', seatLimit: 100 },
      ],
      repairs: [
        { organizationId: 'backfill', before: { seatLimit: 100 }, after: { seatLimit: 50 } },
        { organizationId: 'changed', before: { seatLimit: 100 }, after: { seatLimit: 40 } },
        { organizationId: 'failed', before: { seatLimit: 100 }, after: { seatLimit: 25 } },
        { organizationId: 'legacy', before: { seatLimit: 100 }, after: { seatLimit: 60 } },
        { organizationId: 'notes', before: { seatLimit: 100 }, after: { seatLimit: 25 } },
      ],
    });
    await client.query(migration);
    expect(await snapshot()).toEqual(first);
  });

  it('preserves a concurrent seat edit and emits no misleading restoration audit', async () => {
    await seed('concurrent');
    const writer = new Client({ connectionString: databaseUrl });
    await writer.connect();
    let restore: Promise<unknown> | undefined;
    try {
      await writer.query(`SET search_path TO "${schema}"`);
      await writer.query('BEGIN');
      await writer.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      await writer.query('UPDATE organizations SET "seatLimit" = 80 WHERE id = $1', ['concurrent']);
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      // Observe the actual row-lock wait before committing the operator edit.
      restore = client.query(migration);
      await expect
        .poll(
          async () =>
            (await writer.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid]))
              .rows[0].blocked
        )
        .toBe(true);
      await writer.query('COMMIT');
      await restore;
      expect(await snapshot()).toEqual({
        seats: [{ id: 'concurrent', seatLimit: 80 }],
        repairs: [],
      });
    } finally {
      await writer.query('ROLLBACK');
      await writer.end();
      if (restore) await restore;
    }
  });

  it('rolls back the seat restoration when the audit insert fails', async () => {
    await seed('rollback');
    await client.query(`INSERT INTO platform_audit_logs (id, "organizationId", action)
      VALUES ('seat_contract_restore_' || md5('rollback:20261029000376'), 'rollback', 'test.collision')`);
    await expect(client.query(migration)).rejects.toMatchObject({ code: '23505' });
    await client.query('ROLLBACK');
    expect(await snapshot()).toEqual({ seats: [{ id: 'rollback', seatLimit: 100 }], repairs: [] });
  });
});
