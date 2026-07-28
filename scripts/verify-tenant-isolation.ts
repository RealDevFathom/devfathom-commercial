import { randomUUID } from 'node:crypto';

import pg from 'pg';

const { Client } = pg;

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required; tenant isolation tests never use DATABASE_URL.');
}

const parsedUrl = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname) &&
  process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
) {
  throw new Error('Refusing to run the destructive RLS verifier against a non-local database.');
}

const client = new Client({ connectionString: databaseUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const runtimeRole = `devfathom_rls_${suffix}`;
const organizationB = `org_rls_${suffix}`;
const userB = `user_rls_${suffix}`;
const projectA = `project_rls_${suffix}`;

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

async function expectDatabaseError(code: string, run: () => Promise<unknown>) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await run();
    throw new Error(`Expected PostgreSQL error ${code}, but the statement succeeded.`);
  } catch (error) {
    const received = error instanceof Error && 'code' in error ? String(error.code) : null;
    if (received !== code) throw error;
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client.query('RELEASE SAVEPOINT expected_failure');
  }
}

async function main() {
  await client.connect();

  try {
    await client.query('BEGIN');

    const legacy = await client.query<{ organizationId: string }>(
      `SELECT "organizationId" FROM "users" WHERE "id" = 'user_legacy'`
    );
    assertEqual(legacy.rows[0]?.organizationId, 'org_devfathom', 'legacy rows must be backfilled');

    await client.query(`CREATE ROLE "${runtimeRole}" NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${runtimeRole}"`
    );

    await client.query(
      `INSERT INTO "organizations" (
      "id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt"
    ) VALUES ($1, $2, 'Isolation B', 'Isolation B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [organizationB, `isolation-${suffix}`]
    );
    await client.query(
      `INSERT INTO "users" (
      "id", "organizationId", "name", "email", "role", "department", "title",
      "startDate", "status", "createdAt", "updatedAt"
    ) VALUES ($1, $2, 'Tenant B User', $3, 'ADMIN', 'LEADERSHIP', 'Administrator',
      CURRENT_TIMESTAMP, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [userB, organizationB, `${userB}@example.test`]
    );
    await client.query(
      `INSERT INTO "projects" (
      "id", "organizationId", "name", "status", "type", "createdAt", "updatedAt"
    ) VALUES ($1, 'org_devfathom', 'Tenant A Project', 'ACTIVE', 'INTERNAL',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [projectA]
    );

    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
    await client.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    await client.query(`SELECT set_config('app.current_organization_id', 'org_devfathom', true)`);

    const tenantA = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "users" WHERE "id" IN ('user_legacy', $1)`,
      [userB]
    );
    assertEqual(tenantA.rows[0]?.count, 1, 'tenant A must only see its own user');

    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
      organizationB,
    ]);
    const tenantB = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "users" WHERE "id" IN ('user_legacy', $1)`,
      [userB]
    );
    assertEqual(tenantB.rows[0]?.count, 1, 'tenant B must only see its own user');

    await client.query(`SELECT set_config('app.current_organization_id', '', true)`);
    const unscoped = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "users"`
    );
    assertEqual(unscoped.rows[0]?.count, 0, 'an unscoped tenant transaction must see no rows');

    await client.query(`SELECT set_config('app.current_organization_id', 'org_devfathom', true)`);
    await expectDatabaseError('23503', async () => {
      await client.query(
        `INSERT INTO "project_members" ("id", "organizationId", "projectId", "userId", "role")
       VALUES ($1, 'org_devfathom', $2, $3, 'MEMBER')`,
        [`membership_${suffix}`, projectA, userB]
      );
      await client.query(`SET CONSTRAINTS "tenant_project_members_userId_users_fk" IMMEDIATE`);
    });

    await expectDatabaseError('42501', () =>
      client.query(
        `INSERT INTO "users" (
        "id", "organizationId", "name", "email", "role", "department", "title",
        "startDate", "status", "createdAt", "updatedAt"
      ) VALUES ($1, $2, 'RLS Escape', $3, 'EMPLOYEE', 'ENGINEERING', 'Engineer',
        CURRENT_TIMESTAMP, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [`escape_${suffix}`, organizationB, `escape-${suffix}@example.test`]
      )
    );

    await expectDatabaseError('42501', () =>
      client.query(
        `INSERT INTO "platform_leads" ("id", "name", "status", "createdAt", "updatedAt")
       VALUES ($1, 'Forbidden lead', 'NEW', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [`lead_denied_${suffix}`]
      )
    );

    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `INSERT INTO "platform_leads" ("id", "name", "status", "createdAt", "updatedAt")
     VALUES ($1, 'Allowed lead', 'NEW', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`lead_allowed_${suffix}`]
    );
    const platformVisible = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "platform_leads" WHERE "id" = $1`,
      [`lead_allowed_${suffix}`]
    );
    assertEqual(platformVisible.rows[0]?.count, 1, 'platform scope must unlock control-plane rows');

    console.log(
      'RLS verification passed: backfill, read isolation, fail-closed access, composite ownership, and platform-only policies.'
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
