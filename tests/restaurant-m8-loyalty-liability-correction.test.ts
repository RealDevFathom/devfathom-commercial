import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const client = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const role = `m8_correction_${suffix}`;
const ids = {
  orgA: `m8_correction_org_a_${suffix}`,
  orgB: `m8_correction_org_b_${suffix}`,
  programA: `m8_correction_program_a_${suffix}`,
  programBoundaryA: `m8_correction_program_boundary_a_${suffix}`,
  accountA: `m8_correction_account_a_${suffix}`,
  accountB: `m8_correction_account_b_${suffix}`,
  dailyA1: `m8_correction_daily_a1_${suffix}`,
  dailyA2: `m8_correction_daily_a2_${suffix}`,
  dailyB: `m8_correction_daily_b_${suffix}`,
} as const;

const migrationPath = resolve(
  process.cwd(),
  'prisma/migrations/20260824120000_m8_historical_loyalty_liability_correction/migration.sql'
);

async function expectDatabaseError(code: string, run: () => Promise<unknown>) {
  await client!.query('SAVEPOINT expected_failure');
  try {
    await run();
    throw new Error(`Expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  } finally {
    await client!.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client!.query('RELEASE SAVEPOINT expected_failure');
  }
}

describeIfDatabase('M8 historical loyalty liability correction (real PostgreSQL)', () => {
  let invalidTimezoneMessage = '';
  let roleCreated = false;
  let tenantBFactId = '';

  beforeAll(async () => {
    const hostname = new URL(TEST_DATABASE_URL!).hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
      throw new Error('Refusing to run M8 correction probes against a non-local database.');
    }

    await client!.connect();
    await client!.query(`SET app.is_platform_admin = 'true'`);
    await client!.query(
      `INSERT INTO "organizations" (
        "id", "slug", "legalName", "displayName", "status", "deploymentMode", "timezone",
        "createdAt", "updatedAt"
      ) VALUES
        ($1, $2, 'Correction Tenant A', 'Correction Tenant A', 'ACTIVE', 'SHARED',
         'America/New_York', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, $4, 'Correction Tenant B', 'Correction Tenant B', 'ACTIVE', 'SHARED',
         'Mars/Olympus', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.orgA, `m8-correction-a-${suffix}`, ids.orgB, `m8-correction-b-${suffix}`]
    );

    // Seed only the raw rows consumed by the correction. Replica mode avoids
    // unrelated downstream parent fixtures while retaining all values under test.
    await client!.query(`SET session_replication_role = 'replica'`);
    await client!.query(
      `INSERT INTO "restaurant_loyalty_program_versions" (
        "id", "organizationId", "versionNumber", "effectiveFrom", "earnRate",
        "redemptionValue", "updatedAt"
      ) VALUES
        ($1, $2, 1, TIMESTAMP '2026-03-01 00:00:00', 1, 0.015, CURRENT_TIMESTAMP),
        ($3, $2, 2, TIMESTAMP '2026-03-09 04:00:00', 1, 9.999, CURRENT_TIMESTAMP)`,
      [ids.programA, ids.orgA, ids.programBoundaryA]
    );
    await client!.query(
      `INSERT INTO "restaurant_loyalty_accounts" (
        "id", "organizationId", "customerId", "updatedAt"
      ) VALUES
        ($1, $2, $3, CURRENT_TIMESTAMP),
        ($4, $2, $5, CURRENT_TIMESTAMP)`,
      [
        ids.accountA,
        ids.orgA,
        `m8_correction_customer_a_${suffix}`,
        ids.accountB,
        `m8_correction_customer_b_${suffix}`,
      ]
    );
    await client!.query(
      `INSERT INTO "restaurant_loyalty_points_entries" (
        "id", "organizationId", "accountId", "programVersionId", "kind", "points",
        "actorId", "reason", "occurredAt", "idempotencyKey"
      ) VALUES
        ($1, $2, $3, $4, 'ADJUSTMENT', 100, 'migration-test', 'seed', TIMESTAMP '2026-03-08 20:00:00', $5),
        ($6, $2, $3, $4, 'ADJUSTMENT', -25, 'migration-test', 'seed', TIMESTAMP '2026-03-09 03:59:59.999', $7),
        ($8, $2, $9, $4, 'ADJUSTMENT', -50, 'migration-test', 'seed', TIMESTAMP '2026-03-08 22:00:00', $10),
        ($11, $2, $3, $4, 'ADJUSTMENT', 1000, 'migration-test', 'seed', TIMESTAMP '2026-03-09 04:00:00', $12),
        ($13, $2, $3, $4, 'ADJUSTMENT', 9000, 'migration-test', 'seed', TIMESTAMP '2026-08-24 00:00:00', $14)`,
      [
        `m8_correction_points_1_${suffix}`,
        ids.orgA,
        ids.accountA,
        ids.programA,
        `m8-correction-points-1-${suffix}`,
        `m8_correction_points_2_${suffix}`,
        `m8-correction-points-2-${suffix}`,
        `m8_correction_points_3_${suffix}`,
        ids.accountB,
        `m8-correction-points-3-${suffix}`,
        `m8_correction_points_4_${suffix}`,
        `m8-correction-points-4-${suffix}`,
        `m8_correction_points_5_${suffix}`,
        `m8-correction-points-5-${suffix}`,
      ]
    );
    await client!.query(
      `INSERT INTO "restaurant_insight_daily_rollups" (
        "id", "organizationId", "branchId", "businessDate", "sourceDailyCloseId",
        "loyaltyLiability", "updatedAt"
      ) VALUES
        ($1, $2, $3, DATE '2026-03-08', $4, 999.00, CURRENT_TIMESTAMP),
        ($5, $2, $6, DATE '2026-03-08', $7, 888.00, CURRENT_TIMESTAMP),
        ($8, $9, $10, DATE '2026-03-08', $11, 777.00, CURRENT_TIMESTAMP)`,
      [
        ids.dailyA1,
        ids.orgA,
        `m8_correction_branch_a1_${suffix}`,
        `m8_correction_close_a1_${suffix}`,
        ids.dailyA2,
        `m8_correction_branch_a2_${suffix}`,
        `m8_correction_close_a2_${suffix}`,
        ids.dailyB,
        ids.orgB,
        `m8_correction_branch_b_${suffix}`,
        `m8_correction_close_b_${suffix}`,
      ]
    );
    await client!.query(`SET session_replication_role = 'origin'`);
    await client!.query(`SET TIME ZONE 'Asia/Karachi'`);

    const migration = await readFile(migrationPath, 'utf8');
    try {
      await client!.query(migration);
    } catch (error) {
      invalidTimezoneMessage = (error as Error).message;
      expect(error).toMatchObject({ code: '22023' });
    }
    await client!.query('ROLLBACK');
    expect(
      (
        await client!.query<{ table_name: string | null }>(
          `SELECT to_regclass('public.restaurant_insight_loyalty_liability_rollups')::text AS table_name`
        )
      ).rows
    ).toEqual([{ table_name: null }]);

    await client!.query(`UPDATE "organizations" SET "timezone" = 'UTC' WHERE "id" = $1`, [
      ids.orgB,
    ]);
    await client!.query(migration);
    tenantBFactId = (
      await client!.query<{ id: string }>(
        `SELECT "id" FROM "restaurant_insight_loyalty_liability_rollups"
          WHERE "organizationId" = $1`,
        [ids.orgB]
      )
    ).rows[0]!.id;

    await client!.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    roleCreated = true;
    await client!.query(`GRANT "${role}" TO CURRENT_USER`);
    await client!.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client!.query(
      `GRANT SELECT, UPDATE ON
        "restaurant_insight_daily_rollups",
        "restaurant_insight_loyalty_liability_rollups"
       TO "${role}"`
    );
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    if (roleCreated) {
      await client.query(`DROP OWNED BY "${role}"`);
      await client.query(`DROP ROLE "${role}"`);
    }
    await client.end();
  });

  it('fails the migration safely and without tenant or ledger detail for an invalid timezone', () => {
    expect(invalidTimezoneMessage).toBe(
      'WHA-134 precondition failed: 1 organization timezone value(s) are invalid.'
    );
    expect(invalidTimezoneMessage).not.toMatch(/m8_|customer|account|points|Mars/i);
  });

  it('computes the DST cutoff as a UTC timestamp independent of the session timezone', async () => {
    const cutoff = async (sessionTimezone: string) => {
      await client!.query(`SET TIME ZONE '${sessionTimezone}'`);
      return (
        await client!.query<{ cutoff: string }>(
          `SELECT to_char(
             (((DATE '2026-03-08' + 1)::timestamp AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC'),
             'YYYY-MM-DD HH24:MI:SS'
           ) AS cutoff`
        )
      ).rows[0]!.cutoff;
    };
    expect(await cutoff('UTC')).toBe('2026-03-09 04:00:00');
    expect(await cutoff('Asia/Karachi')).toBe('2026-03-09 04:00:00');
  });

  it('backfills one org/date fact from only pre-cutoff raw ledger rows', async () => {
    const facts = await client!.query<{
      liability: string;
      branch_count: number;
      link_count: number;
    }>(
      `SELECT liability."liability"::text AS liability,
              COUNT(daily."id")::int AS branch_count,
              COUNT(DISTINCT daily."loyaltyLiabilityRollupId")::int AS link_count
         FROM "restaurant_insight_loyalty_liability_rollups" AS liability
         JOIN "restaurant_insight_daily_rollups" AS daily
           ON daily."organizationId" = liability."organizationId"
          AND daily."loyaltyLiabilityRollupId" = liability."id"
        WHERE liability."organizationId" = $1
          AND liability."businessDate" = DATE '2026-03-08'
        GROUP BY liability."liability"`,
      [ids.orgA]
    );
    // Raw oracle: max(100 - 25, 0) + max(-50, 0) = 75; 75 * 0.015 = 1.125 -> 1.13.
    expect(facts.rows).toEqual([{ liability: '1.13', branch_count: 2, link_count: 1 }]);
    expect(
      (
        await client!.query<{ loyaltyLiability: string }>(
          `SELECT "loyaltyLiability"::text AS "loyaltyLiability"
             FROM "restaurant_insight_daily_rollups"
            WHERE "id" IN ($1, $2)
            ORDER BY "id"`,
          [ids.dailyA1, ids.dailyA2]
        )
      ).rows
    ).toEqual([{ loyaltyLiability: '999.00' }, { loyaltyLiability: '888.00' }]);
  });

  it('forces RLS and rejects a tenant-invisible composite fact reference', async () => {
    await client!.query('BEGIN');
    try {
      await client!.query(`SET LOCAL ROLE "${role}"`);
      await client!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
      await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [ids.orgA]);

      expect(
        (
          await client!.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
            `SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = $1`,
            [role]
          )
        ).rows
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      expect(
        (
          await client!.query(
            `SELECT "id" FROM "restaurant_insight_loyalty_liability_rollups"
              WHERE "organizationId" IN ($1, $2)`,
            [ids.orgA, ids.orgB]
          )
        ).rowCount
      ).toBe(1);

      const tenantBFact = (
        await client!.query<{ id: string }>(
          `SELECT "id" FROM "restaurant_insight_loyalty_liability_rollups"
            WHERE "organizationId" = $1`,
          [ids.orgB]
        )
      ).rows[0]?.id;
      expect(tenantBFact).toBeUndefined();

      await expectDatabaseError('23503', async () => {
        const hiddenFactId = (
          await client!.query<{ id: string }>(
            `SELECT "loyaltyLiabilityRollupId" AS id
               FROM "restaurant_insight_daily_rollups"
              WHERE "id" = $1`,
            [ids.dailyB]
          )
        ).rows[0]?.id;
        expect(hiddenFactId).toBeUndefined();
        await client!.query(
          `UPDATE "restaurant_insight_daily_rollups"
              SET "loyaltyLiabilityRollupId" = $1
            WHERE "id" = $2`,
          [tenantBFactId, ids.dailyA1]
        );
        await client!.query(`SET CONSTRAINTS "tenant_insight_daily_loyalty_fact_fk" IMMEDIATE`);
      });
    } finally {
      await client!.query('ROLLBACK');
    }
  });
});
