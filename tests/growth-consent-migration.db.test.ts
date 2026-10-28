// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const suite = process.env.WA_CONSENT_TEST_DATABASE_URL ? describe : describe.skip;
suite('consent migration with existing FORCE RLS rows', () => {
  it('deploys as the restricted owner, expires and minimizes every tenant, and labels only START/شروع', async () => {
    const db = new Client({ connectionString: process.env.WA_CONSENT_TEST_DATABASE_URL });
    await db.connect();
    const schema = 'wa_consent_' + randomUUID().replaceAll('-', '');
    try {
      const identity = (
        await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')
      ).rows[0];
      expect(identity).toEqual({ rolsuper: false, rolbypassrls: false });
      await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}; SET TIME ZONE 'UTC'`);
      await db.query('CREATE TABLE "_prisma_migrations" (migration_name text NOT NULL)');
      await db.query(
        readFileSync('prisma/migrations/20261021200000_retain_wa_consent/migration.sql', 'utf8')
      );
      expect(
        (
          await db.query(
            `SELECT tableowner=current_user AS owner FROM pg_tables WHERE schemaname=$1`,
            [schema]
          )
        ).rows[0].owner
      ).toBe(true);
      await db.query("BEGIN; SELECT set_config('app.is_platform_admin','true',true)");
      for (const [i, body] of [
        'START',
        ' شروع ',
        'yes',
        'haan',
        'ہاں',
        'START offers',
        'STOP',
      ].entries()) {
        await db.query(
          `INSERT INTO growth_wa_consent_retention ("tenantId","evidenceKind","sourceId",evidence,"retainedAt") VALUES ($1,'message',$2,$3,'2026-10-01T00:00:00Z')`,
          [
            'tenant_' + i,
            String(i),
            {
              body,
              keyword: ['yes', 'haan', 'ہاں'].includes(body) ? 'START' : undefined,
              private: 'must be removed',
              waMessageId: 'event_' + i,
            },
          ]
        );
      }
      await db.query(
        `INSERT INTO growth_wa_consent_retention ("tenantId","evidenceKind","sourceId",evidence,"retainedAt")
         VALUES ('tenant_customer','customer','customer','{"optInAt":"2026-10-01T00:00:00Z"}','2026-10-01T00:00:00Z')`
      );
      await db.query('COMMIT');
      expect((await db.query('SELECT * FROM growth_wa_consent_retention')).rowCount).toBe(0);
      await db.query(
        readFileSync('prisma/migrations/20261021210000_minimize_wa_consent/migration.sql', 'utf8')
      );
      // Transaction-local elevation must not survive COMMIT.
      expect((await db.query('SELECT * FROM growth_wa_consent_retention')).rowCount).toBe(0);
      await db.query("BEGIN; SELECT set_config('app.is_platform_admin','true',true)");
      const rows = (await db.query('SELECT * FROM growth_wa_consent_retention ORDER BY "sourceId"'))
        .rows;
      expect(rows).toHaveLength(8);
      expect(rows.map((r) => r.evidence.keyword ?? null)).toEqual([
        'START',
        'START',
        null,
        null,
        null,
        null,
        'STOP',
        'opt-in',
      ]);
      for (const row of rows) {
        expect(row.expiresAt.toISOString()).toBe('2027-10-01T00:00:00.000Z');
        expect(row.evidence).not.toHaveProperty('body');
        expect(row.evidence).not.toHaveProperty('private');
      }
      await db.query('COMMIT');
      expect(
        (
          await db.query(
            `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='growth_wa_consent_retention'::regclass`
          )
        ).rows[0]
      ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      await db.query("SELECT set_config('app.current_organization_id','tenant_0',false)");
      expect((await db.query('SELECT * FROM growth_wa_consent_retention')).rowCount).toBe(1);

      // The migration originally shipped under this name. A deploy containing the
      // renamed migration must leave its already-minimized keywords untouched.
      await db.query(
        `INSERT INTO "_prisma_migrations" VALUES ('20261022000000_minimize_wa_consent')`
      );
      await db.query(
        readFileSync('prisma/migrations/20261021210000_minimize_wa_consent/migration.sql', 'utf8')
      );
      await db.query("BEGIN; SELECT set_config('app.is_platform_admin','true',true)");
      expect(
        (
          await db.query(
            `SELECT evidence->>'keyword' AS keyword FROM growth_wa_consent_retention ORDER BY "sourceId"`
          )
        ).rows.map((row) => row.keyword)
      ).toEqual(['START', 'START', null, null, null, null, 'STOP', 'opt-in']);
      await db.query('COMMIT');
    } finally {
      await db.query('ROLLBACK');
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    }
  });
});
