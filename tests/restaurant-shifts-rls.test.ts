import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Completion wave (WHA-229 + WHA-909) — roster and workforce cross-tenant
 * isolation probes against REAL PostgreSQL, under an unprivileged role
 * (NOSUPERUSER / NOBYPASSRLS), matching the M1-L1 … M8 RLS batteries.
 *
 * Covered: forced org-level RLS (read/update/delete/insert), the deferred
 * composite tenant foreign keys that make a cross-organization branch or staff
 * reference impossible even inside the platform scope, and the two business
 * CHECKs the Prisma schema cannot express (window ordering, cancellation
 * consistency), plus immutable workforce history and race arbiters. Domain
 * rules live in the focused Restaurant shift/workforce unit suites.
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
  replacementA: `shift_replacement_a_${suffix}`,
  replacementB: `shift_replacement_b_${suffix}`,
  breakA: `shift_break_a_${suffix}`,
  breakB: `shift_break_b_${suffix}`,
  swapA: `shift_swap_a_${suffix}`,
  swapB: `shift_swap_b_${suffix}`,
  eventA: `shift_event_a_${suffix}`,
  eventB: `shift_event_b_${suffix}`,
  commandA: `shift_command_a_${suffix}`,
  commandB: `shift_command_b_${suffix}`,
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
    await client!.query(
      `INSERT INTO "restaurant_staff_profiles" (
        "id", "organizationId", "displayName", "primaryBranchId", "updatedAt"
      ) VALUES ($1, $2, 'A replacement', $3, CURRENT_TIMESTAMP),
               ($4, $5, 'B replacement', $6, CURRENT_TIMESTAMP)`,
      [ids.replacementA, ids.orgA, ids.rowA, ids.replacementB, ids.orgB, ids.rowB]
    );
    await insertShift(ids.rowA, ids.orgA, ids.rowA, ids.rowA);
    await insertShift(ids.rowB, ids.orgB, ids.rowB, ids.rowB);
    await client!.query(
      `INSERT INTO "restaurant_shift_breaks" ("id", "organizationId", "shiftId", "updatedAt")
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP), ($4, $5, $6, CURRENT_TIMESTAMP)`,
      [ids.breakA, ids.orgA, ids.rowA, ids.breakB, ids.orgB, ids.rowB]
    );
    await client!.query(
      `INSERT INTO "restaurant_shift_swap_requests" (
         "id", "organizationId", "shiftId", "requestedByStaffProfileId", "replacementStaffProfileId"
       ) VALUES ($1, $2, $3, $3, $4), ($5, $6, $7, $7, $8)`,
      [
        ids.swapA,
        ids.orgA,
        ids.rowA,
        ids.replacementA,
        ids.swapB,
        ids.orgB,
        ids.rowB,
        ids.replacementB,
      ]
    );
    await client!.query(
      `INSERT INTO "restaurant_shift_events" (
         "id", "organizationId", "shiftId", "kind", "actorUserId"
       ) VALUES ($1, $2, $3, 'PUBLISHED', 'actor-a'), ($4, $5, $6, 'PUBLISHED', 'actor-b')`,
      [ids.eventA, ids.orgA, ids.rowA, ids.eventB, ids.orgB, ids.rowB]
    );
    await client!.query(
      `INSERT INTO "restaurant_workforce_commands" (
         "id", "organizationId", "idempotencyKey", "kind", "shiftId"
       ) VALUES ($1, $2, 'key-a', 'CLOCK_IN', $3), ($4, $5, 'key-b', 'CLOCK_IN', $6)`,
      [ids.commandA, ids.orgA, ids.rowA, ids.commandB, ids.orgB, ids.rowB]
    );

    await client!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [ids.orgA]);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    await client.end();
  });

  it('keeps raw missing break ends while enforcing one effectively open break', async () => {
    await client!.query('SAVEPOINT repaired_break');
    try {
      const insertOpen = (id: string) =>
        client!.query(
          `INSERT INTO "restaurant_shift_breaks"
         ("id", "organizationId", "shiftId", "closedByAdjustment", "updatedAt")
         VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP)`,
          [id, ids.orgA, ids.rowA]
        );
      // Supplying the derived flag cannot bypass the unique open-break guard.
      await expectDatabaseError('23505', () => insertOpen(`next_${suffix}`));
      await client!.query(
        `INSERT INTO "restaurant_time_adjustments"
         ("id", "organizationId", "shiftId", "breakId", "kind", "originalAt",
          "correctedAt", "reason", "adjustedByUserId")
         VALUES ($1, $2, $3, $4, 'BREAK_END', NULL, CURRENT_TIMESTAMP, 'Reader offline', 'manager')`,
        [`repair_${suffix}`, ids.orgA, ids.rowA, ids.breakA]
      );
      const raw = await client!.query(
        `SELECT "endedAt", "closedByAdjustment" FROM "restaurant_shift_breaks" WHERE "id" = $1`,
        [ids.breakA]
      );
      expect(raw.rows).toEqual([{ endedAt: null, closedByAdjustment: true }]);
      await insertOpen(`next_${suffix}`);
      await expectDatabaseError('23505', () => insertOpen(`third_${suffix}`));
      const rewrite = await client!.query(
        `UPDATE "restaurant_time_adjustments" SET "reason" = 'rewrite' WHERE "id" = $1`,
        [`repair_${suffix}`]
      );
      expect(rewrite.rowCount).toBe(0);
    } finally {
      await client!.query('ROLLBACK TO SAVEPOINT repaired_break');
      await client!.query('RELEASE SAVEPOINT repaired_break');
    }
  });

  it('enables and FORCES row-level security on the shift table', async () => {
    const rls = await client!.query<{ enabled: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_catalog.pg_class
        WHERE relname = 'restaurant_shifts' AND relkind = 'r'`
    );
    expect(rls.rows).toEqual([{ enabled: true, forced: true }]);
  });

  it('enables and FORCES RLS on every workforce child table', async () => {
    const rls = await client!.query<{ relname: string; enabled: boolean; forced: boolean }>(
      `SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_catalog.pg_class
        WHERE relname IN (
          'restaurant_shift_breaks', 'restaurant_shift_swap_requests',
          'restaurant_shift_swap_decisions', 'restaurant_shift_events',
          'restaurant_time_adjustments', 'restaurant_workforce_commands'
        ) ORDER BY relname`
    );
    expect(rls.rows).toHaveLength(6);
    expect(rls.rows.every((row) => row.enabled && row.forced)).toBe(true);
  });

  it('hides tenant B workforce history and rejects immutable mutation', async () => {
    expect(
      (
        await client!.query<{ id: string }>(
          `SELECT "id" FROM "restaurant_shift_events" WHERE "id" IN ($1, $2)`,
          [ids.eventA, ids.eventB]
        )
      ).rows
    ).toEqual([{ id: ids.eventA }]);
    expect(
      (
        await client!.query<{ id: string }>(
          `SELECT "id" FROM "restaurant_workforce_commands" WHERE "id" IN ($1, $2)`,
          [ids.commandA, ids.commandB]
        )
      ).rows
    ).toEqual([{ id: ids.commandA }]);
    expect(
      (await client!.query(`DELETE FROM "restaurant_shift_events" WHERE "id" = $1`, [ids.eventB]))
        .rowCount
    ).toBe(0);
    expect(
      (await client!.query(`DELETE FROM "restaurant_shift_events" WHERE "id" = $1`, [ids.eventA]))
        .rowCount
    ).toBe(0);
    // Ordinary tenants remain append-only; only the exact demo-reset DELETE is admitted.
    const resetPolicies = await client!.query(
      `SELECT tablename, policyname, cmd, permissive, roles::text[] AS roles, qual, with_check
         FROM pg_catalog.pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])
          AND (policyname = 'restaurant_demo_reset_delete' OR cmd IN ('DELETE', 'ALL'))
        ORDER BY tablename, policyname`,
      [['restaurant_shift_events']]
    );
    expect(
      resetPolicies.rows.map((row) => ({
        ...row,
        // Match the catalog rendering already pinned by the demo-reset guard.
        qual: row.qual?.replace(/^public\./, ''),
      }))
    ).toEqual(
      [...['restaurant_shift_events']].sort().map((tablename) => ({
        tablename,
        policyname: 'restaurant_demo_reset_delete',
        cmd: 'DELETE',
        permissive: 'PERMISSIVE',
        roles: ['public'],
        qual: 'restaurant_demo_reset_allowed("organizationId")',
        with_check: null,
      }))
    );
  });

  it('makes raw punches single-write and command/decision race winners unique', async () => {
    await client!.query(`UPDATE "restaurant_shifts" SET "clockedInAt" = $1 WHERE "id" = $2`, [
      START,
      ids.rowA,
    ]);
    await expectDatabaseError('55000', () =>
      client!.query(`UPDATE "restaurant_shifts" SET "clockedInAt" = $1 WHERE "id" = $2`, [
        '2026-08-20T09:01:00Z',
        ids.rowA,
      ])
    );
    await expectDatabaseError('23505', () =>
      client!.query(
        `INSERT INTO "restaurant_workforce_commands" (
          "id", "idempotencyKey", "kind", "shiftId"
        ) VALUES ($1, 'key-a', 'CLOCK_IN', $2)`,
        [`duplicate_command_${suffix}`, ids.rowA]
      )
    );
    await client!.query(
      `INSERT INTO "restaurant_shift_swap_decisions" (
        "id", "requestId", "decision", "decidedByUserId"
      ) VALUES ($1, $2, 'REJECTED', 'manager-a')`,
      [`decision_a_${suffix}`, ids.swapA]
    );
    await expectDatabaseError('23505', () =>
      client!.query(
        `INSERT INTO "restaurant_shift_swap_decisions" (
          "id", "requestId", "decision", "decidedByUserId"
        ) VALUES ($1, $2, 'APPROVED', 'manager-b')`,
        [`decision_race_${suffix}`, ids.swapA]
      )
    );
  });

  it('hides cross-tenant break and swap rows and refuses their mutation', async () => {
    const breaks = await client!.query<{ id: string }>(
      `SELECT "id" FROM "restaurant_shift_breaks" WHERE "id" IN ($1, $2)`,
      [ids.breakA, ids.breakB]
    );
    const swaps = await client!.query<{ id: string }>(
      `SELECT "id" FROM "restaurant_shift_swap_requests" WHERE "id" IN ($1, $2)`,
      [ids.swapA, ids.swapB]
    );
    expect(breaks.rows).toEqual([{ id: ids.breakA }]);
    expect(swaps.rows).toEqual([{ id: ids.swapA }]);
    expect(
      (
        await client!.query(
          `UPDATE "restaurant_shift_breaks" SET "endedAt" = now() WHERE "id" = $1`,
          [ids.breakB]
        )
      ).rowCount
    ).toBe(0);
    expect(
      (
        await client!.query(`DELETE FROM "restaurant_shift_swap_requests" WHERE "id" = $1`, [
          ids.swapB,
        ])
      ).rowCount
    ).toBe(0);
  });

  it('refuses cross-tenant shift parents even under platform scope', async () => {
    await client!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    try {
      await expectDatabaseError('23503', async () => {
        await client!.query(
          `INSERT INTO "restaurant_shift_breaks" ("id", "organizationId", "shiftId", "updatedAt")
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
          [`wrong_parent_${suffix}`, ids.orgA, ids.rowB]
        );
        await client!.query('SET CONSTRAINTS ALL IMMEDIATE');
      });
    } finally {
      await client!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
      await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [ids.orgA]);
    }
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
        await insertShift(`xbranch_${suffix}`, ids.orgA, ids.rowB, ids.rowA, {
          startAt: '2026-08-20T18:00:00Z',
          endAt: '2026-08-20T19:00:00Z',
        });
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
