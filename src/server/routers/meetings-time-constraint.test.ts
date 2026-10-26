import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20261026000000_meeting_time_range_check/migration.sql'
  ),
  'utf8'
);

describe('meeting time database invariant', () => {
  it('stages, repairs, and validates the constraint in that order', () => {
    expect(migration).toMatch(
      /CHECK\s*\(\s*"endTime"\s*>\s*"startTime"\s*\)\s*NOT VALID[\s\S]*UPDATE "meetings"[\s\S]*WHERE "endTime" <= "startTime"[\s\S]*VALIDATE CONSTRAINT/u
    );
  });
});

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDatabase('meeting time constraint migration against PostgreSQL', () => {
  it('repairs equal and reversed legacy rows before enforcing the invariant', async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    try {
      await client.query(`
        CREATE TEMP TABLE "meetings" (
          "id" text PRIMARY KEY,
          "startTime" timestamptz NOT NULL,
          "endTime" timestamptz NOT NULL
        )
      `);
      await client.query(`
        INSERT INTO "meetings" ("id", "startTime", "endTime") VALUES
          ('equal', '2026-10-26 10:00:00+00', '2026-10-26 10:00:00+00'),
          ('reversed', '2026-10-26 10:00:00+00', '2026-10-26 09:00:00+00'),
          ('valid', '2026-10-26 10:00:00+00', '2026-10-26 11:00:00+00')
      `);

      await client.query(migration);

      const repaired = await client.query<{ id: string; duration_seconds: string }>(`
        SELECT "id", extract(epoch FROM ("endTime" - "startTime"))::text AS duration_seconds
        FROM "meetings"
        ORDER BY "id"
      `);
      expect(repaired.rows).toEqual([
        { id: 'equal', duration_seconds: '60.000000' },
        { id: 'reversed', duration_seconds: '60.000000' },
        { id: 'valid', duration_seconds: '3600.000000' },
      ]);
      await expect(
        client.query(`
          INSERT INTO "meetings" ("id", "startTime", "endTime")
          VALUES ('new-invalid', '2026-10-26 10:00:00+00', '2026-10-26 10:00:00+00')
        `)
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });
});
