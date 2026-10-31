// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve('prisma/migrations/20261029000388_meeting_time_order/migration.sql'),
  'utf8'
);
const describeIfDatabase = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('meeting time-order migration under forced RLS', () => {
  it('repairs all tenants as a non-bypassing owner and releases platform scope', async () => {
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const role = `meeting_migration_${randomBytes(6).toString('hex')}`;
    let createdRole = false;
    await client.connect();
    try {
      const {
        rows: [attributes],
      } = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      // Privileged test connections must exercise the repair as an RLS-bound
      // owner too. Unprivileged connections can use their own role directly.
      if (attributes.rolsuper || attributes.rolbypassrls) {
        await client.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
        createdRole = true;
        await client.query(`GRANT "${role}" TO CURRENT_USER`);
        await client.query(`SET ROLE "${role}"`);
      }

      // A session-local table shadows the application's meetings table, so the
      // exact migration SQL can run without altering any application data.
      await client.query(`
        CREATE TEMP TABLE meetings (
          id text PRIMARY KEY,
          "organizationId" text NOT NULL,
          "startTime" timestamp NOT NULL,
          "endTime" timestamp NOT NULL
        );
        ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
        ALTER TABLE meetings FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON meetings
          USING (current_setting('app.is_platform_admin', true) = 'true'
            OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
          WITH CHECK (current_setting('app.is_platform_admin', true) = 'true'
            OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
        BEGIN;
        SELECT set_config('app.is_platform_admin', 'true', true);
        INSERT INTO meetings VALUES
          ('equal', 'tenant_a', '2026-10-29 10:00', '2026-10-29 10:00'),
          ('before', 'tenant_b', '2026-10-29 10:00', '2026-10-29 09:00'),
          ('valid', 'tenant_b', '2026-10-29 10:00', '2026-10-29 11:00');
        COMMIT;
      `);
      expect((await client.query("SELECT row_security_active('meetings') AS active")).rows).toEqual(
        [{ active: true }]
      );
      expect((await client.query('SELECT * FROM meetings')).rows).toEqual([]);

      await client.query(sql);

      expect((await client.query('SELECT * FROM meetings')).rows).toEqual([]);
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      expect(
        (
          await client.query(`
        SELECT id, EXTRACT(EPOCH FROM ("endTime" - "startTime"))::int AS duration
        FROM meetings ORDER BY id
      `)
        ).rows
      ).toEqual([
        { id: 'before', duration: 60 },
        { id: 'equal', duration: 60 },
        { id: 'valid', duration: 3600 },
      ]);
      expect(
        (
          await client.query(`
        SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'pg_temp.meetings'::regclass
          AND conname = 'meetings_time_order_check'
      `)
        ).rows
      ).toEqual([{ convalidated: true }]);
      await expect(
        client.query('UPDATE meetings SET "endTime" = "startTime"')
      ).rejects.toMatchObject({ code: '23514', constraint: 'meetings_time_order_check' });
    } finally {
      try {
        await client.query('ROLLBACK');
        await client.query('DROP TABLE IF EXISTS pg_temp.meetings');
        if (createdRole) {
          await client.query('RESET ROLE');
          await client.query(`DROP ROLE "${role}"`);
        }
      } finally {
        await client.end();
      }
    }
  });
});
