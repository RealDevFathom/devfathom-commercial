// @vitest-environment node
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readStaffingFootfall } from './staffing-footfall';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('staffing footfall PostgreSQL date bounds', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('BEGIN');
    // Shadow the production table on this connection only; no migrated schema
    // or writes to existing tenant data are needed to exercise the real SQL.
    await client.query(`CREATE TEMP TABLE pharmacy_sales (
      "organizationId" text,
      "branchId" text,
      status text,
      "receiptNumber" integer,
      "completedAt" timestamp(3) without time zone
    ) ON COMMIT DROP`);
  });

  beforeEach(async () => {
    await client.query('TRUNCATE pg_temp.pharmacy_sales');
  });

  afterAll(async () => {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    }
  });

  async function report(timezone: string, from: string, to = from) {
    const db = {
      pharmacyBranch: { findFirst: async () => ({ id: 'branch_1' }) },
      organization: { findUnique: async () => ({ timezone }) },
      $queryRaw: async (query: Prisma.Sql) => (await client.query(query.text, query.values)).rows,
    } as unknown as ScopedDb;
    return readStaffingFootfall(db, 'org_1', {
      branchId: 'branch_1',
      from,
      to,
      receiptsPerStaffHour: 1,
      minimumSuggestedStaff: 0,
    });
  }

  async function seed(timestamps: string[]) {
    await client.query(
      `INSERT INTO pg_temp.pharmacy_sales
       SELECT 'org_1', 'branch_1', 'COMPLETED', 1, stamp
       FROM unnest($1::timestamp[]) AS stamp`,
      [timestamps]
    );
  }

  it.each(['UTC', 'Pacific/Honolulu'])(
    'includes exactly the selected local dates with database session timezone %s',
    async (sessionTimezone) => {
      await client.query("SELECT set_config('TimeZone', $1, true)", [sessionTimezone]);
      await seed([
        '2026-09-30 18:29:59.999', // Before the first local midnight.
        '2026-09-30 18:30:00', // First local midnight, included.
        '2026-10-01 04:00:00', // 09:30 local, first day.
        '2026-10-02 04:00:00', // 09:30 local, second day.
        '2026-10-02 18:29:59.999', // Last millisecond of the last local day.
        '2026-10-02 18:30:00', // Next local midnight, excluded.
      ]);
      await client.query(`INSERT INTO pg_temp.pharmacy_sales VALUES
        ('org_2', 'branch_1', 'COMPLETED', 1, '2026-10-01 04:00:00'),
        ('org_1', 'branch_2', 'COMPLETED', 1, '2026-10-01 04:00:00'),
        ('org_1', 'branch_1', 'OPEN', 1, '2026-10-01 04:00:00'),
        ('org_1', 'branch_1', 'COMPLETED', NULL, '2026-10-01 04:00:00'),
        ('org_1', 'branch_1', 'COMPLETED', 1, NULL)`);

      const result = await report('Asia/Kolkata', '2026-10-01', '2026-10-02');
      expect(result.hours.reduce((total, row) => total + row.receiptCount, 0)).toBe(4);
      expect(result.hours[0]).toMatchObject({ receiptCount: 1 });
      expect(result.hours[9]).toMatchObject({
        receiptCount: 2,
        averageReceipts: 1,
        suggestedStaff: 1,
      });
      expect(result.hours[23]).toMatchObject({ receiptCount: 1 });
    }
  );

  it.each([
    {
      date: '2026-03-08',
      stamps: [
        '2026-03-08 04:59:59.999',
        '2026-03-08 05:00:00',
        '2026-03-08 06:30:00',
        '2026-03-08 07:30:00',
        '2026-03-09 03:59:59.999',
        '2026-03-09 04:00:00',
      ],
      expectedHours: [0, 1, 3, 23],
    },
    {
      date: '2026-11-01',
      stamps: [
        '2026-11-01 03:59:59.999',
        '2026-11-01 04:00:00',
        '2026-11-01 05:30:00',
        '2026-11-01 06:30:00',
        '2026-11-02 04:59:59.999',
        '2026-11-02 05:00:00',
      ],
      expectedHours: [0, 1, 1, 23],
    },
  ])('resolves both midnights and local hours on DST day $date', async (scenario) => {
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await seed(scenario.stamps);
    // Different weights outside the interval distinguish boundary mistakes
    // even when they happen to swap receipts into the same local-hour bucket.
    await seed([scenario.stamps[0]!, scenario.stamps[5]!]);
    const result = await report('America/New_York', scenario.date);
    expect(result.period.days).toBe(1);
    expect(result.hours.flatMap((row) => Array(row.receiptCount).fill(row.hourLocal))).toEqual(
      scenario.expectedHours
    );
  });
});
