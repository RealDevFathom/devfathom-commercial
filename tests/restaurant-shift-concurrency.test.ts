import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Real PostgreSQL arbiter proof. TEST_DATABASE_URL must be a migrated disposable
 * database reached through a LOGIN NOSUPERUSER NOBYPASSRLS runtime role. */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const setup = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;
const first = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;
const second = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;

const id = (label: string) => `${label}_${suffix}`;
const orgA = id('shift_race_org_a');
const orgB = id('shift_race_org_b');
const branchA1 = id('shift_race_branch_a1');
const branchA2 = id('shift_race_branch_a2');
const branchB = id('shift_race_branch_b');
const employeeA = id('shift_race_employee_a');
const employeeA2 = id('shift_race_employee_a2');
const employeeB = id('shift_race_employee_b');

async function tenant(client: pg.Client, organizationId: string) {
  await client.query(`SELECT set_config('app.is_platform_admin', 'false', false)`);
  await client.query(`SELECT set_config('app.current_organization_id', $1, false)`, [
    organizationId,
  ]);
}

async function insertShift(
  client: pg.Client,
  shiftId: string,
  branchId: string,
  staffProfileId: string,
  startAt: string,
  endAt: string
) {
  return client.query(
    `INSERT INTO "restaurant_shifts" (
       "id", "branchId", "staffProfileId", "businessDate", "startAt", "endAt", "updatedAt"
     ) VALUES ($1, $2, $3, DATE '2026-09-01', $4, $5, CURRENT_TIMESTAMP)`,
    [shiftId, branchId, staffProfileId, startAt, endAt]
  );
}

describeIfDatabase('restaurant shift exclusion and CAS (restricted PostgreSQL)', () => {
  beforeAll(async () => {
    await Promise.all([setup!.connect(), first!.connect(), second!.connect()]);
    const role = await setup!.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user`
    );
    expect(role.rows).toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false }]);

    await setup!.query('BEGIN');
    await setup!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await setup!.query(
      `INSERT INTO "organizations" (
        "id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt"
      ) VALUES ($1, $2, 'Race A', 'Race A', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
               ($3, $4, 'Race B', 'Race B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [orgA, id('shift-race-a'), orgB, id('shift-race-b')]
    );
    await setup!.query(
      `INSERT INTO "restaurant_branches" ("id", "organizationId", "name", "updatedAt") VALUES
        ($1, $2, 'A1', CURRENT_TIMESTAMP), ($3, $2, 'A2', CURRENT_TIMESTAMP),
        ($4, $5, 'B1', CURRENT_TIMESTAMP)`,
      [branchA1, orgA, branchA2, branchB, orgB]
    );
    await setup!.query(
      `INSERT INTO "restaurant_staff_profiles" (
        "id", "organizationId", "displayName", "primaryBranchId", "updatedAt"
      ) VALUES ($1, $2, 'A employee', $3, CURRENT_TIMESTAMP),
               ($4, $2, 'A distinct', $3, CURRENT_TIMESTAMP),
               ($5, $6, 'B employee', $7, CURRENT_TIMESTAMP)`,
      [employeeA, orgA, branchA1, employeeA2, employeeB, orgB, branchB]
    );
    await setup!.query('COMMIT');
    await Promise.all([tenant(first!, orgA), tenant(second!, orgA)]);
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([first?.query('ROLLBACK'), second?.query('ROLLBACK')]);
    await setup?.query('BEGIN');
    if (setup) {
      await setup.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      await setup.query(`DELETE FROM "organizations" WHERE "id" IN ($1, $2)`, [orgA, orgB]);
      await setup.query('COMMIT');
    }
    await Promise.allSettled([setup?.end(), first?.end(), second?.end()]);
  });

  it('allows exactly one overlapping same-employee writer across two branches', async () => {
    await Promise.all([first!.query('BEGIN'), second!.query('BEGIN')]);
    const winner = insertShift(
      first!,
      id('race_winner'),
      branchA1,
      employeeA,
      '2026-09-01T09:00:00Z',
      '2026-09-01T17:00:00Z'
    );
    await winner;
    const loser = insertShift(
      second!,
      id('race_loser'),
      branchA2,
      employeeA,
      '2026-09-01T12:00:00Z',
      '2026-09-01T18:00:00Z'
    );
    await first!.query('COMMIT');
    await expect(loser).rejects.toMatchObject({ code: '23P01' });
    await second!.query('ROLLBACK');
    expect(
      (
        await first!.query(
          `SELECT count(*)::int AS count FROM "restaurant_shifts" WHERE "staffProfileId" = $1`,
          [employeeA]
        )
      ).rows
    ).toEqual([{ count: 1 }]);
  });

  it('allows distinct employees, non-overlap, and another organization', async () => {
    await insertShift(
      first!,
      id('distinct_employee'),
      branchA1,
      employeeA2,
      '2026-09-01T12:00:00Z',
      '2026-09-01T18:00:00Z'
    );
    await insertShift(
      first!,
      id('non_overlap'),
      branchA1,
      employeeA,
      '2026-09-01T17:00:00Z',
      '2026-09-01T20:00:00Z'
    );
    await tenant(second!, orgB);
    await insertShift(
      second!,
      id('other_org'),
      branchB,
      employeeB,
      '2026-09-01T12:00:00Z',
      '2026-09-01T18:00:00Z'
    );
  });

  it('increments one version atomically and rejects stale update/cancel contention', async () => {
    await tenant(second!, orgA);
    const shiftId = id('cas_shift');
    await insertShift(
      first!,
      shiftId,
      branchA1,
      employeeA2,
      '2026-09-02T09:00:00Z',
      '2026-09-02T17:00:00Z'
    );
    const update = (client: pg.Client, role: string) =>
      client.query(
        `UPDATE "restaurant_shifts" SET "role" = $1, "version" = "version" + 1
       WHERE "id" = $2 AND "organizationId" = $3 AND "version" = 1 RETURNING "version"`,
        [role, shiftId, orgA]
      );
    const [left, right] = await Promise.all([
      update(first!, 'Manager A'),
      update(second!, 'Manager B'),
    ]);
    expect([left.rowCount, right.rowCount].sort()).toEqual([0, 1]);
    expect([...left.rows, ...right.rows]).toEqual([{ version: 2 }]);
    const staleCancel = await second!.query(
      `UPDATE "restaurant_shifts" SET "status" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP,
         "version" = "version" + 1 WHERE "id" = $1 AND "organizationId" = $2 AND "version" = 1`,
      [shiftId, orgA]
    );
    expect(staleCancel.rowCount).toBe(0);
  });
});
