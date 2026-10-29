// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

// This fixture creates and owns an isolated schema so FORCE ROW LEVEL SECURITY
// applies to a non-superuser table owner. Runtime roles intentionally have no
// database CREATE privilege in CI.
const databaseUrl = process.env.OWNER_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const sql = readFileSync(
  'prisma/migrations/20261021141526_org_seat_limit_backfill/migration.sql',
  'utf8'
);

// Preserve quoted values/identifiers while discarding comments before splitting.
function splitSql(source: string): string[] {
  const statements: string[] = [];
  let statement = '';
  const tokens =
    source.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\r\n]*|\/\*[\s\S]*?\*\/|;|[^'";/-]+|./g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('--') || token.startsWith('/*')) {
      statement += ' ';
    } else if (token === ';') {
      if (statement.trim()) statements.push(statement.trim());
      statement = '';
    } else {
      statement += token;
    }
  }
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

describe('backfill SQL splitter', () => {
  it('ignores semicolons in line and block comments and preserves quoted text', () => {
    expect(
      splitSql(`-- ignored;\nBEGIN; /* ignored; */ SELECT 'a;--b', "a;/*b*/"; COMMIT; -- trailing;`)
    ).toEqual(['BEGIN', `SELECT 'a;--b', "a;/*b*/"`, 'COMMIT']);
  });
});

(databaseUrl ? describe : describe.skip)('seat backfill on PostgreSQL with forced RLS', () => {
  it('repairs legacy seats, preserves contract, creation, demo, unknown, manual, custom and single-seat limits, and audits once', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const schema = `seat_${randomUUID().replaceAll('-', '')}`;
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
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE platform_packages (id text PRIMARY KEY, key text, vertical text,
          "defaultSeats" integer NOT NULL DEFAULT 1, "updatedAt" timestamp NOT NULL DEFAULT now());
        CREATE TABLE organizations (id text PRIMARY KEY, "packageId" text REFERENCES platform_packages,
          "seatLimit" integer NOT NULL DEFAULT 1, "isDemo" boolean NOT NULL DEFAULT false, "updatedAt" timestamp NOT NULL DEFAULT now());
        CREATE TABLE platform_contracts (id text PRIMARY KEY,
          "organizationId" text NOT NULL REFERENCES organizations);
        CREATE TABLE platform_audit_logs (id text PRIMARY KEY, "organizationId" text REFERENCES organizations,
          action text NOT NULL, "targetType" text, "targetId" text, before jsonb, after jsonb, reason text,
          "createdAt" timestamp NOT NULL DEFAULT now());
      `);
      for (const table of [
        'platform_packages',
        'organizations',
        'platform_contracts',
        'platform_audit_logs',
      ]) {
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
          ('contract-row', 'team', 1), ('contract-create-audit', 'team', 1),
          ('contract-status-audit', 'team', 1), ('created-one', 'team', 1),
          ('demo', 'team', 1), ('unknown', 'team', 1),
          ('manual', 'team', 1), ('raise', 'team', 1), ('custom', 'team', 7), ('solo', 'solo', 1), ('hotel', 'hotel', 1);
        UPDATE organizations SET "isDemo" = true WHERE id = 'demo';
        INSERT INTO platform_contracts (id, "organizationId") VALUES ('contract', 'contract-row');
        INSERT INTO platform_audit_logs
          (id, "organizationId", action, "targetType", "targetId", after)
        SELECT 'create-' || id, id, 'organization.create', 'Organization', id,
          CASE WHEN id = 'created-one' THEN '{"seatLimit": 1}'::jsonb ELSE '{}'::jsonb END
        FROM organizations WHERE id <> 'unknown';
        INSERT INTO platform_audit_logs
          (id, "organizationId", action, "targetType", "targetId", after)
        VALUES
          ('contract-create', 'contract-create-audit', 'commercial.contract.create',
            'PlatformContract', 'deleted-contract-create', '{"seatLimit": 1}'),
          ('contract-status', 'contract-status-audit', 'commercial.contract.status',
            'PlatformContract', 'deleted-contract-status', '{"seatLimit": 1}');
        INSERT INTO platform_audit_logs
          (id, "organizationId", action, "targetType", "targetId", before, after)
        VALUES ('manual-seat-limit', 'manual', 'organization.update', 'Organization', 'manual',
          '{"seatLimit": 42}', '{"seatLimit": 1}');
      `);
      const originalOrgs = (await client.query('SELECT * FROM organizations ORDER BY id')).rows;
      const originalAuditCount = (await client.query('SELECT * FROM platform_audit_logs'))
        .rowCount!;
      const originalSeats = new Map(
        (await client.query('SELECT id, "seatLimit" FROM organizations')).rows.map((o) => [
          o.id,
          o.seatLimit,
        ])
      );
      await client.query("SELECT set_config('app.is_platform_admin', 'false', true)");
      expect((await client.query('SELECT * FROM organizations')).rows).toHaveLength(0);
      await client.query('COMMIT');
      // No outer transaction: each statement has migrate deploy semantics.
      const deploy = async () => {
        const results = [];
        for (const statement of splitSql(sql)) {
          results.push(await client.query(statement));
        }
        return results;
      };
      const results = await deploy();
      expect(
        results.filter((result) => result.command === 'UPDATE').map((result) => result.rowCount)
      ).toEqual([1]);
      expect(results.find((result) => result.command === 'INSERT')?.rowCount).toBe(2);
      expect((await client.query('SELECT * FROM organizations')).rowCount).toBe(0);
      await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
      const snapshot = async () => ({
        orgs: (await client.query('SELECT * FROM organizations ORDER BY id')).rows,
        audits: (await client.query('SELECT * FROM platform_audit_logs ORDER BY "organizationId"'))
          .rows,
      });
      const first = await snapshot();
      expect(first.orgs.map((o) => [o.id, o.seatLimit])).toEqual([
        ['contract-create-audit', 1],
        ['contract-row', 1],
        ['contract-status-audit', 1],
        ['created-one', 1],
        ['custom', 7],
        ['demo', 1],
        ['hotel', 15],
        ['manual', 1],
        ['raise', 42],
        ['solo', 1],
        ['unknown', 1],
      ]);
      expect(first.orgs).toHaveLength(11);
      expect(first.audits).toHaveLength(originalAuditCount + 2);
      for (const id of [
        'contract-row',
        'contract-create-audit',
        'contract-status-audit',
        'created-one',
        'demo',
        'unknown',
      ]) {
        expect(first.orgs.find((o) => o.id === id)).toEqual(originalOrgs.find((o) => o.id === id));
        expect(
          first.audits.filter(
            (a) => a.organizationId === id && a.action === 'organization.seat_limit.backfill'
          )
        ).toHaveLength(0);
      }
      const updatedOrgCount = first.orgs.filter(
        (o) => o.seatLimit !== originalSeats.get(o.id)
      ).length;
      expect(updatedOrgCount).toBe(2);
      expect(
        first.audits
          .filter((a) => a.action === 'organization.seat_limit.backfill')
          .map((a) => [a.organizationId, a.before, a.after])
      ).toEqual([
        ['hotel', { seatLimit: 1 }, { seatLimit: 15, packageId: 'hotel' }],
        ['raise', { seatLimit: 1 }, { seatLimit: 42, packageId: 'team' }],
      ]);
      await client.query("SELECT set_config('app.is_platform_admin', 'false', false)");
      const rerun = await deploy();
      expect(rerun.find((result) => result.command === 'INSERT')?.rowCount).toBe(0);
      await client.query("SELECT set_config('app.is_platform_admin', 'true', false)");
      expect(await snapshot()).toEqual(first);
    } finally {
      await client.query('ROLLBACK');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
});
