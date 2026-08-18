import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const client = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const role = `devfathom_m2_${suffix}`;
const ids = {
  orgA: `org_m2_a_${suffix}`,
  orgB: `org_m2_b_${suffix}`,
  branchA: `branch_m2_a_${suffix}`,
  branchB: `branch_m2_b_${suffix}`,
  staffA: `staff_m2_a_${suffix}`,
  managerA: `manager_m2_a_${suffix}`,
  staffB: `staff_m2_b_${suffix}`,
  managerB: `manager_m2_b_${suffix}`,
  deviceA: `device_m2_a_${suffix}`,
  deviceB: `device_m2_b_${suffix}`,
  credentialA: `credential_m2_a_${suffix}`,
  credentialB: `credential_m2_b_${suffix}`,
  sessionA: `session_m2_a_${suffix}`,
  sessionB: `session_m2_b_${suffix}`,
  coAuthA: `coauth_m2_a_${suffix}`,
  coAuthB: `coauth_m2_b_${suffix}`,
};

const tables = [
  ['restaurant_staff_profiles', ids.staffA, ids.staffB],
  ['restaurant_operator_credentials', ids.credentialA, ids.credentialB],
  ['restaurant_registered_devices', ids.deviceA, ids.deviceB],
  ['restaurant_terminal_sessions', ids.sessionA, ids.sessionB],
  ['restaurant_co_authorizations', ids.coAuthA, ids.coAuthB],
] as const;

async function expectDatabaseError(code: string, sql: string, values: unknown[]) {
  await client!.query('SAVEPOINT expected_failure');
  try {
    await client!.query(sql, values);
    throw new Error(`Expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  } finally {
    await client!.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client!.query('RELEASE SAVEPOINT expected_failure');
  }
}

describeIfDatabase('M2 cross-tenant RLS probes (real PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(TEST_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run M2 RLS probes against a non-local database.');
    }

    await client!.connect();
    await client!.query('BEGIN');
    await client!.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client!.query(`GRANT "${role}" TO CURRENT_USER`);
    await client!.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client!.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    await client!.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON
        "restaurant_staff_profiles", "restaurant_operator_credentials",
        "restaurant_registered_devices", "restaurant_terminal_sessions",
        "restaurant_co_authorizations" TO "${role}"`
    );

    await client!.query(
      `INSERT INTO "organizations" (
        "id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt"
      ) VALUES
        ($1, $2, 'M2 Tenant A', 'M2 Tenant A', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, $4, 'M2 Tenant B', 'M2 Tenant B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.orgA, `m2-a-${suffix}`, ids.orgB, `m2-b-${suffix}`]
    );
    await client!.query(
      `INSERT INTO "restaurant_branches" ("id", "organizationId", "name", "updatedAt") VALUES
        ($1, $2, 'A', CURRENT_TIMESTAMP), ($3, $4, 'B', CURRENT_TIMESTAMP)`,
      [ids.branchA, ids.orgA, ids.branchB, ids.orgB]
    );
    await client!.query(
      `INSERT INTO "restaurant_staff_profiles" (
        "id", "organizationId", "displayName", "primaryBranchId", "updatedAt"
      ) VALUES
        ($1, $2, 'A operator', $3, CURRENT_TIMESTAMP),
        ($4, $2, 'A manager', $3, CURRENT_TIMESTAMP),
        ($5, $6, 'B operator', $7, CURRENT_TIMESTAMP),
        ($8, $6, 'B manager', $7, CURRENT_TIMESTAMP)`,
      [
        ids.staffA,
        ids.orgA,
        ids.branchA,
        ids.managerA,
        ids.staffB,
        ids.orgB,
        ids.branchB,
        ids.managerB,
      ]
    );
    await client!.query(
      `INSERT INTO "restaurant_registered_devices" (
        "id", "organizationId", "branchId", "name", "deviceSecretHash", "updatedAt"
      ) VALUES
        ($1, $2, $3, 'A POS', $4, CURRENT_TIMESTAMP),
        ($5, $6, $7, 'B POS', $8, CURRENT_TIMESTAMP)`,
      [
        ids.deviceA,
        ids.orgA,
        ids.branchA,
        `device-a-${suffix}`,
        ids.deviceB,
        ids.orgB,
        ids.branchB,
        `device-b-${suffix}`,
      ]
    );
    await client!.query(
      `INSERT INTO "restaurant_operator_credentials" (
        "id", "organizationId", "staffProfileId", "deviceId", "type", "credentialHash", "updatedAt"
      ) VALUES
        ($1, $2, $3, $4, 'PIN', $5, CURRENT_TIMESTAMP),
        ($6, $7, $8, $9, 'PIN', $10, CURRENT_TIMESTAMP)`,
      [
        ids.credentialA,
        ids.orgA,
        ids.staffA,
        ids.deviceA,
        `pin-a-${suffix}`,
        ids.credentialB,
        ids.orgB,
        ids.staffB,
        ids.deviceB,
        `pin-b-${suffix}`,
      ]
    );
    await client!.query(
      `INSERT INTO "restaurant_terminal_sessions" (
        "id", "organizationId", "deviceId", "activeStaffProfileId", "tokenHash", "updatedAt"
      ) VALUES
        ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP),
        ($6, $7, $8, $9, $10, CURRENT_TIMESTAMP)`,
      [
        ids.sessionA,
        ids.orgA,
        ids.deviceA,
        ids.staffA,
        `session-a-${suffix}`,
        ids.sessionB,
        ids.orgB,
        ids.deviceB,
        ids.staffB,
        `session-b-${suffix}`,
      ]
    );
    await client!.query(
      `INSERT INTO "restaurant_co_authorizations" (
        "id", "organizationId", "actingStaffProfileId", "approvingStaffProfileId",
        "capability", "reason", "deviceId", "terminalSessionId"
      ) VALUES
        ($1, $2, $3, $4, 'orders:void', 'A reason', $5, $6),
        ($7, $8, $9, $10, 'orders:void', 'B reason', $11, $12)`,
      [
        ids.coAuthA,
        ids.orgA,
        ids.staffA,
        ids.managerA,
        ids.deviceA,
        ids.sessionA,
        ids.coAuthB,
        ids.orgB,
        ids.staffB,
        ids.managerB,
        ids.deviceB,
        ids.sessionB,
      ]
    );

    await client!.query(`SET LOCAL ROLE "${role}"`);
    await client!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [ids.orgA]);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    await client.end();
  });

  it.each(tables)('%s hides tenant B from read, update, and delete', async (table, idA, idB) => {
    const visible = await client!.query<{ id: string }>(
      `SELECT "id" FROM "${table}" WHERE "id" IN ($1, $2)`,
      [idA, idB]
    );
    expect(visible.rows).toEqual([{ id: idA }]);
    expect(
      (
        await client!.query(
          `UPDATE "${table}" SET "organizationId" = "organizationId" WHERE "id" = $1`,
          [idB]
        )
      ).rowCount
    ).toBe(0);
    expect((await client!.query(`DELETE FROM "${table}" WHERE "id" = $1`, [idB])).rowCount).toBe(0);
  });

  it.each([
    [
      'restaurant_staff_profiles',
      `INSERT INTO "restaurant_staff_profiles" ("id", "organizationId", "displayName", "updatedAt")
       VALUES ($1, $2, 'escape', CURRENT_TIMESTAMP)`,
      [`deny_staff_${suffix}`, ids.orgB],
    ],
    [
      'restaurant_operator_credentials',
      `INSERT INTO "restaurant_operator_credentials" (
        "id", "organizationId", "staffProfileId", "type", "credentialHash", "updatedAt"
      ) VALUES ($1, $2, $3, 'PIN', $4, CURRENT_TIMESTAMP)`,
      [`deny_credential_${suffix}`, ids.orgB, ids.staffB, `deny-pin-${suffix}`],
    ],
    [
      'restaurant_registered_devices',
      `INSERT INTO "restaurant_registered_devices" (
        "id", "organizationId", "branchId", "name", "deviceSecretHash", "updatedAt"
      ) VALUES ($1, $2, $3, 'escape', $4, CURRENT_TIMESTAMP)`,
      [`deny_device_${suffix}`, ids.orgB, ids.branchB, `deny-device-${suffix}`],
    ],
    [
      'restaurant_terminal_sessions',
      `INSERT INTO "restaurant_terminal_sessions" (
        "id", "organizationId", "deviceId", "tokenHash", "updatedAt"
      ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
      [`deny_session_${suffix}`, ids.orgB, ids.deviceB, `deny-session-${suffix}`],
    ],
    [
      'restaurant_co_authorizations',
      `INSERT INTO "restaurant_co_authorizations" (
        "id", "organizationId", "actingStaffProfileId", "approvingStaffProfileId", "capability", "reason"
      ) VALUES ($1, $2, $3, $4, 'orders:void', 'escape')`,
      [`deny_coauth_${suffix}`, ids.orgB, ids.staffB, ids.managerB],
    ],
  ] as const)('%s rejects a tenant-B insert under tenant-A scope', async (_table, sql, values) => {
    await expectDatabaseError('42501', sql, [...values]);
  });
});
