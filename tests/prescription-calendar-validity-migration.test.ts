// @vitest-environment node
import { readFileSync } from 'node:fs';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const sql = readFileSync(
  'prisma/migrations/20261024000100_prescription_calendar_validity/migration.sql',
  'utf8'
);

(databaseUrl ? describe : describe.skip)('prescription calendar-validity migration', () => {
  it('retains UTC calendar dates when the database session is west of UTC', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
      await client.query(`
        CREATE TEMP TABLE pharmacy_prescriptions (
          "validFrom" timestamptz NOT NULL,
          "validUntil" timestamptz NOT NULL
        ) ON COMMIT DROP
      `);
      await client.query(`
        INSERT INTO pharmacy_prescriptions ("validFrom", "validUntil")
        VALUES ('2026-10-22T00:00:00Z', '2026-10-31T00:00:00Z')
      `);

      await client.query(sql);

      const result = await client.query<{ validFrom: string; validUntil: string }>(`
        SELECT "validFrom"::text AS "validFrom", "validUntil"::text AS "validUntil"
        FROM pharmacy_prescriptions
      `);
      expect(result.rows).toEqual([
        { validFrom: '2026-10-22', validUntil: '2026-10-31' },
      ]);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
