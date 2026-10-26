import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

describeIfDatabase('restaurant report timezone boundaries', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`SET TIME ZONE 'Asia/Karachi'`);
  });

  afterAll(async () => {
    await client.end();
  });

  it('filters UTC wall-clock timestamps independently of the non-UTC session timezone', async () => {
    const session = await client.query<{ TimeZone: string }>('SHOW TIME ZONE');
    expect(session.rows[0]?.TimeZone).toBe('Asia/Karachi');

    const result = await client.query<{
      branch: string;
      occurred_at: string;
      day: string;
    }>(`
      WITH branches(branch, timezone) AS (
        VALUES ('Karachi', 'Asia/Karachi'), ('New York', 'America/New_York')
      ), boundaries(label, instant) AS (
        VALUES
          ('just before lower', TIMESTAMPTZ '2026-10-20 18:59:59.999+00'),
          ('exact lower', TIMESTAMPTZ '2026-10-20 19:00:00+00'),
          ('just before upper', TIMESTAMPTZ '2026-10-21 18:59:59.999+00'),
          ('exact upper', TIMESTAMPTZ '2026-10-21 19:00:00+00'),
          ('ny just before lower', TIMESTAMPTZ '2026-10-21 03:59:59.999+00'),
          ('ny exact lower', TIMESTAMPTZ '2026-10-21 04:00:00+00'),
          ('ny just before upper', TIMESTAMPTZ '2026-10-22 03:59:59.999+00'),
          ('ny exact upper', TIMESTAMPTZ '2026-10-22 04:00:00+00')
      ), movements AS (
        SELECT branch, timezone, label, instant AT TIME ZONE 'UTC' AS occurred_at
        FROM branches
        CROSS JOIN boundaries
        WHERE (branch = 'Karachi' AND label NOT LIKE 'ny %')
           OR (branch = 'New York' AND label LIKE 'ny %')
      )
      SELECT branch, label AS occurred_at,
        TO_CHAR((occurred_at AT TIME ZONE 'UTC') AT TIME ZONE timezone, 'YYYY-MM-DD') AS day
      FROM movements
      WHERE (occurred_at AT TIME ZONE 'UTC') >= (DATE '2026-10-21'::timestamp AT TIME ZONE timezone)
        AND (occurred_at AT TIME ZONE 'UTC') < ((DATE '2026-10-21' + 1)::timestamp AT TIME ZONE timezone)
      ORDER BY branch, label
    `);

    expect(result.rows).toEqual([
      { branch: 'Karachi', occurred_at: 'exact lower', day: '2026-10-21' },
      { branch: 'Karachi', occurred_at: 'just before upper', day: '2026-10-21' },
      { branch: 'New York', occurred_at: 'ny exact lower', day: '2026-10-21' },
      { branch: 'New York', occurred_at: 'ny just before upper', day: '2026-10-21' },
    ]);
  });
});
