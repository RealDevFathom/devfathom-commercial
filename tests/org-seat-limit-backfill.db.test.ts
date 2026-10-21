// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const sql = readFileSync(
  'prisma/migrations/20261021141526_org_seat_limit_backfill/migration.sql',
  'utf8'
);

(databaseUrl ? describe : describe.skip)('seat backfill on PostgreSQL with forced RLS', () => {
  it('repairs legacy seats, preserves custom and single-seat limits, and audits once', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const {
        rows: [role],
      } = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      await client.query('BEGIN');
      // Isolate migration execution from any shared database data. These tables
      // expose the migration columns with their production defaults and RLS.
      const schema = `seat_${randomUUID().replaceAll('-', '')}`;
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE platform_packages (id text PRIMARY KEY, key text, vertical text,
          "defaultSeats" integer NOT NULL DEFAULT 1, "updatedAt" timestamp NOT NULL DEFAULT now());
        CREATE TABLE organizations (id text PRIMARY KEY, "packageId" text REFERENCES platform_packages,
          "seatLimit" integer NOT NULL DEFAULT 1, "updatedAt" timestamp NOT NULL DEFAULT now());
        CREATE TABLE platform_audit_logs (id text PRIMARY KEY, "organizationId" text REFERENCES organizations,
          action text NOT NULL, "targetType" text, "targetId" text, before jsonb, after jsonb, reason text,
          "createdAt" timestamp NOT NULL DEFAULT now());
      `);
      for (const table of ['platform_packages', 'organizations', 'platform_audit_logs']) {
        await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
        await client.query(`CREATE POLICY platform_access ON ${table}
          USING (current_setting('app.is_platform_admin', true) = 'true')
          WITH CHECK (current_setting('app.is_platform_admin', true) = 'true')`);
      }
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      await client.query(`
        INSERT INTO platform_packages (id, key, vertical, "defaultSeats") VALUES
          ('team', 'team', 'AGENCY', 42), ('solo', 'solo', 'AGENCY', 1),
          ('hotel', 'hotel-essentials', 'HOSPITALITY', 1);
        INSERT INTO organizations (id, "packageId", "seatLimit") VALUES
          ('raise', 'team', 1), ('custom', 'team', 7), ('solo', 'solo', 1), ('hotel', 'hotel', 1);
      `);
      await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
      expect((await client.query('SELECT * FROM organizations')).rows).toHaveLength(0);
      await client.query(sql);
      const snapshot = async () => ({
        orgs: (await client.query('SELECT * FROM organizations ORDER BY id')).rows,
        audits: (await client.query('SELECT * FROM platform_audit_logs ORDER BY "organizationId"'))
          .rows,
      });
      const first = await snapshot();
      expect(first.orgs.map((o) => [o.id, o.seatLimit])).toEqual([
        ['custom', 7],
        ['hotel', 15],
        ['raise', 42],
        ['solo', 1],
      ]);
      expect(first.audits).toHaveLength(2);
      expect(first.audits.map((a) => [a.organizationId, a.before, a.after])).toEqual([
        ['hotel', { seatLimit: 1 }, { seatLimit: 15, packageId: 'hotel' }],
        ['raise', { seatLimit: 1 }, { seatLimit: 42, packageId: 'team' }],
      ]);
      await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
      await client.query(sql);
      expect(await snapshot()).toEqual(first);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
