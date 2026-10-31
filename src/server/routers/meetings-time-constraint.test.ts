// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20261031230000_meeting_time_range_check/migration.sql'),
  'utf8'
);

describe('meeting time database invariant', () => {
  it('takes transaction-local platform scope before inspecting legacy data', () => {
    expect(migration).toMatch(
      /BEGIN;[\s\S]*set_config\('app.is_platform_admin', 'true', true\)[\s\S]*row_security_active\('meetings'\)[\s\S]*CHECK\s*\(\s*"endTime"\s*>\s*"startTime"\s*\)\s*NOT VALID[\s\S]*VALIDATE CONSTRAINT[\s\S]*COMMIT;/u
    );
  });
});

// Use only a throwaway test database, never the application's DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

describeIfDatabase('meeting time constraint migration under FORCE RLS', () => {
  let client: pg.Client;
  let schema: string | undefined;

  beforeEach(async () => {
    schema = undefined;
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    // TEMP tables do not exercise RLS. Isolate real tables in a private schema
    // owned by the non-bypassing test role, with FORCE just like production.
    schema = `meeting_time_${randomBytes(6).toString('hex')}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(`
      CREATE TABLE "meetings" (
        "id" text PRIMARY KEY,
        "organizationId" text NOT NULL,
        "startTime" timestamptz NOT NULL,
        "endTime" timestamptz NOT NULL
      );
      CREATE TABLE "meeting_occurrences" (
        "meetingId" text REFERENCES "meetings"("id"),
        "organizationId" text NOT NULL,
        "startTime" timestamptz NOT NULL,
        "endTime" timestamptz NOT NULL
      );
      ALTER TABLE "meetings" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "meetings" FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON "meetings"
        USING (current_setting('app.is_platform_admin', true) = 'true'
          OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
      INSERT INTO "meetings" VALUES
        ('valid', 'org-a', '2026-10-26 10:00:00+00', '2026-10-26 11:00:00+00');
    `);
  });

  afterEach(async () => {
    try {
      await client.query('ROLLBACK');
      if (schema) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  });

  it('reports invalid rows across tenants without changing meetings or occurrences', async () => {
    await client.query(`
      INSERT INTO "meetings" VALUES
        ('equal', 'org-a', '2026-10-26 10:00:00+00', '2026-10-26 10:00:00+00'),
        ('reversed', 'org-b', '2026-10-26 10:00:00+00', '2026-10-26 09:00:00+00');
      INSERT INTO "meeting_occurrences"
        SELECT "id", "organizationId", "startTime", "endTime" FROM "meetings";
    `);
    const meetingsBefore = (await client.query('SELECT * FROM "meetings" ORDER BY "id"')).rows;
    const occurrencesBefore = (
      await client.query('SELECT * FROM "meeting_occurrences" ORDER BY "meetingId"')
    ).rows;
    await client.query(`SELECT set_config('app.is_platform_admin', 'false', false)`);
    expect((await client.query('SELECT * FROM "meetings"')).rows).toEqual([]);
    expect((await client.query(`SELECT row_security_active('meetings') AS active`)).rows).toEqual([
      { active: true },
    ]);

    await expect(client.query(migration)).rejects.toMatchObject({
      code: 'P0001',
      message: 'Meeting time constraint: 2 meetings end at or before they start. Meeting IDs (first 20): equal, reversed',
      hint: expect.stringContaining('meetings and their occurrences'),
    });
    await client.query('ROLLBACK');
    expect((await client.query(`SELECT current_setting('app.is_platform_admin') AS scope`)).rows)
      .toEqual([{ scope: 'false' }]);
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    expect((await client.query('SELECT * FROM "meetings" ORDER BY "id"')).rows).toEqual(meetingsBefore);
    expect((await client.query('SELECT * FROM "meeting_occurrences" ORDER BY "meetingId"')).rows)
      .toEqual(occurrencesBefore);
    expect((await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'meetings'::regclass AND conname = 'meetings_endTime_after_startTime_check'
    `)).rows).toEqual([]);
  });

  it('validates clean data and rejects equal or reversed inserts and updates', async () => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'false', false)`);
    await client.query(migration);
    expect((await client.query('SELECT * FROM "meetings"')).rows).toEqual([]);
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    expect((await client.query(`
      SELECT convalidated FROM pg_constraint
      WHERE conrelid = 'meetings'::regclass AND conname = 'meetings_endTime_after_startTime_check'
    `)).rows).toEqual([{ convalidated: true }]);
    expect((await client.query(`
      SELECT extract(epoch FROM ("endTime" - "startTime"))::text AS duration FROM "meetings"
    `)).rows).toEqual([{ duration: '3600.000000' }]);

    for (const end of ['2026-10-26 10:00:00+00', '2026-10-26 09:00:00+00']) {
      await expect(client.query(`
        UPDATE "meetings" SET "endTime" = $1 WHERE "id" = 'valid'
      `, [end])).rejects.toMatchObject({ code: '23514' });
      await expect(client.query(`
        INSERT INTO "meetings" VALUES ('new-invalid', 'org-a', '2026-10-26 10:00:00+00', $1)
      `, [end])).rejects.toMatchObject({ code: '23514' });
    }
  });
});
