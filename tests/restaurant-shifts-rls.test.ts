import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Completion wave (WHA-229) — `restaurant_shifts` cross-tenant and branch
 * isolation probes against REAL PostgreSQL, under an unprivileged role
 * (NOSUPERUSER / NOBYPASSRLS), matching the M1-L1 … M8 RLS batteries.
 *
 * Covered: forced org-level RLS (read/update/delete/insert), the deferred
 * composite tenant foreign keys that make a cross-organization branch or staff
 * reference impossible even inside the platform scope, and the two business
 * CHECKs the Prisma schema cannot express (window ordering, cancellation
 * consistency). Domain rules — overlap, business-date stamping, sign-in
 * eligibility — live in `src/lib/restaurant/shifts.test.ts`.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const client = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);

const ids = {
  orgA: `org_shift_a_${suffix}`,
  orgB: `org_shift_b_${suffix}`,
  rowA: `shift_a_${suffix}`,
  rowB: `shift_b_${suffix}`,
};

const START = '2026-08-20T09:00:00Z';
const END = '2026-08-20T17:00:00Z';

async function insertPrerequisites(organizationId: string, rowId: string, label: string) {
  await client!.query(
    `INSERT INTO "restaurant_branches" ("id", "organizationId", "name", "updatedAt")
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} branch`]
  );
  await client!.query(
    `INSERT INTO "restaurant_staff_profiles" (
      "id", "organizationId", "displayName", "primaryBranchId", "updatedAt"
    ) VALUES ($1, $2, $3, $1, CURRENT_TIMESTAMP)`,
    [rowId, organizationId, `${label} operator`]
  );
}

async function insertShift(
  id: string,
  organizationId: string,
  branchId: string,
  staffProfileId: string,
  overrides: { startAt?: string; endAt?: string; status?: string; cancelledAt?: string | null } = {}
) {
  await client!.query(
    `INSERT INTO "restaurant_shifts" (
       "id", "organizationId", "branchId", "staffProfileId", "businessDate",
       "startAt", "endAt", "status", "cancelledAt", "updatedAt"
     ) VALUES ($1, $2, $3, $4, DATE '2026-08-20', $5, $6, $7::"RestaurantShiftStatus", $8, CURRENT_TIMESTAMP)`,
    [
      id,
      organizationId,
      branchId,
      staffProfileId,
      overrides.startAt ?? START,
      overrides.endAt ?? END,
      overrides.status ?? 'SCHEDULED',
      overrides.cancelledAt ?? null,
    ]
  );
}

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

describeIfDatabase('restaurant_shifts isolation probes (real PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(TEST_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run shift RLS probes against a non-local database.');
    }

    await client!.connect();
    const role = await client!.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user`
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    await client!.query('BEGIN');
    await client!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client!.query(
      `INSERT INTO "organizations" (
        "id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt"
      ) VALUES
        ($1, $2, 'Shift Tenant A', 'Shift Tenant A', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, $4, 'Shift Tenant B', 'Shift Tenant B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.orgA, `shift-a-${suffix}`, ids.orgB, `shift-b-${suffix}`]
    );
    await insertPrerequisites(ids.orgA, ids.rowA, 'A');
    await insertPrerequisites(ids.orgB, ids.rowB, 'B');
    await insertShift(ids.rowA, ids.orgA, ids.rowA, ids.rowA);
    await insertShift(ids.rowB, ids.orgB, ids.rowB, ids.rowB);

    await client!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [ids.orgA]);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    await client.end();
  });

  it('enables and FORCES row-level security on the shift table', async () => {
    const rls = await client!.query<{ enabled: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_catalog.pg_class
        WHERE relname = 'restaurant_shifts' AND relkind = 'r'`
    );
    expect(rls.rows).toEqual([{ enabled: true, forced: true }]);
  });

  it('hides tenant B rows and refuses to update or delete them', async () => {
    const visible = await client!.query<{ id: string; organizationId: string }>(
      `SELECT "id", "organizationId" FROM "restaurant_shifts" WHERE "id" IN ($1, $2)`,
      [ids.rowA, ids.rowB]
    );
    expect(visible.rows).toEqual([{ id: ids.rowA, organizationId: ids.orgA }]);

    expect(
      (
        await client!.query(`UPDATE "restaurant_shifts" SET "role" = 'Cashier' WHERE "id" = $1`, [
          ids.rowB,
        ])
      ).rowCount
    ).toBe(0);
    expect(
      (await client!.query(`DELETE FROM "restaurant_shifts" WHERE "id" = $1`, [ids.rowB])).rowCount
    ).toBe(0);
  });

  it('refuses an insert stamped with another tenant', async () => {
    await expectDatabaseError('42501', () =>
      insertShift(`deny_${suffix}`, ids.orgB, ids.rowB, ids.rowB)
    );
  });

  it('refuses to move a visible row into another tenant', async () => {
    await expectDatabaseError('42501', () =>
      client!.query(`UPDATE "restaurant_shifts" SET "organizationId" = $1 WHERE "id" = $2`, [
        ids.orgB,
        ids.rowA,
      ])
    );
  });

  it('defaults organizationId from the transaction scope so an insert cannot omit it', async () => {
    const inserted = await client!.query<{ organizationId: string }>(
      `INSERT INTO "restaurant_shifts" (
         "id", "branchId", "staffProfileId", "businessDate", "startAt", "endAt", "updatedAt"
       ) VALUES ($1, $2, $2, DATE '2026-08-21', $3, $4, CURRENT_TIMESTAMP)
       RETURNING "organizationId"`,
      [`default_${suffix}`, ids.rowA, '2026-08-21T09:00:00Z', '2026-08-21T17:00:00Z']
    );
    expect(inserted.rows).toEqual([{ organizationId: ids.orgA }]);
  });

  it('cannot roster onto another tenant branch or operator, even under the platform scope', async () => {
    await client!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    try {
      // Deferred composite tenant FKs: force them to check inside the savepoint
      // rather than at a COMMIT this transaction never reaches.
      await expectDatabaseError('23503', async () => {
        await insertShift(`xbranch_${suffix}`, ids.orgA, ids.rowB, ids.rowA);
        await client!.query('SET CONSTRAINTS ALL IMMEDIATE');
      });
      await expectDatabaseError('23503', async () => {
        await insertShift(`xstaff_${suffix}`, ids.orgA, ids.rowA, ids.rowB);
        await client!.query('SET CONSTRAINTS ALL IMMEDIATE');
      });
    } finally {
      await client!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
      await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [ids.orgA]);
    }
  });

  it('refuses a shift that does not move forward in time', async () => {
    await expectDatabaseError('23514', () =>
      insertShift(`backwards_${suffix}`, ids.orgA, ids.rowA, ids.rowA, {
        startAt: END,
        endAt: START,
      })
    );
    await expectDatabaseError('23514', () =>
      insertShift(`instant_${suffix}`, ids.orgA, ids.rowA, ids.rowA, {
        startAt: START,
        endAt: START,
      })
    );
  });

  it('keeps the cancellation status and timestamp consistent in both directions', async () => {
    await expectDatabaseError('23514', () =>
      insertShift(`ghost_cancel_${suffix}`, ids.orgA, ids.rowA, ids.rowA, { status: 'CANCELLED' })
    );
    await expectDatabaseError('23514', () =>
      insertShift(`stray_stamp_${suffix}`, ids.orgA, ids.rowA, ids.rowA, {
        status: 'SCHEDULED',
        cancelledAt: START,
      })
    );
  });
});
