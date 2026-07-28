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

    const tenantAUser = await client.query<{ id: string; organizationId: string }>(
      `SELECT "id", "organizationId" FROM "users"
       WHERE "organizationId" = 'org_devfathom'
       ORDER BY "createdAt" ASC LIMIT 1`
    );
    assertEqual(
      tenantAUser.rows[0]?.organizationId,
      'org_devfathom',
      'the seeded tenant must be organization-scoped'
    );
    const userA = tenantAUser.rows[0]!.id;
    const platformUser = await client.query<{ id: string }>(
      `SELECT "id" FROM "platform_users" LIMIT 1`
    );
    const platformUserId = platformUser.rows[0]?.id;

    const missingRls = await client.query<{ tableName: string }>(
      `SELECT tables.table_name AS "tableName"
       FROM information_schema.columns columns
       JOIN information_schema.tables tables
         ON tables.table_schema = columns.table_schema
        AND tables.table_name = columns.table_name
       JOIN pg_class relation ON relation.relname = tables.table_name
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE columns.table_schema = 'public'
         AND columns.column_name = 'organizationId'
         AND namespace.nspname = 'public'
         AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity)`
    );
    assertEqual(
      missingRls.rows.length,
      0,
      `every organization-scoped table must FORCE RLS (${missingRls.rows
        .map((row) => row.tableName)
        .join(', ')})`
    );

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
    const identityA = `identity_a_${suffix}`;
    const identityB = `identity_b_${suffix}`;
    await client.query(
      `INSERT INTO "organization_identity_connections" (
        "id", "organizationId", "name", "protocol", "status", "domains", "createdAt", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', 'Tenant A OIDC', 'OIDC', 'DRAFT', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($2, $3, 'Tenant B OIDC', 'OIDC', 'DRAFT', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [identityA, identityB, organizationB]
    );
    await client.query(
      `INSERT INTO "organization_sso_states" (
        "id", "organizationId", "identityConnectionId", "key", "kind", "payload", "expiresAt"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, 'OIDC', '{}', CURRENT_TIMESTAMP + interval '10 minutes'),
        ($4, $5, $6, $7, 'OIDC', '{}', CURRENT_TIMESTAMP + interval '10 minutes')`,
      [
        `state_a_${suffix}`,
        identityA,
        `state-key-a-${suffix}`,
        `state_b_${suffix}`,
        organizationB,
        identityB,
        `state-key-b-${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO "tenant_sso_tickets" (
        "id", "organizationId", "userId", "tokenHash", "expiresAt"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, CURRENT_TIMESTAMP + interval '10 minutes'),
        ($4, $5, $6, $7, CURRENT_TIMESTAMP + interval '10 minutes')`,
      [
        `ticket_a_${suffix}`,
        userA,
        `ticket-hash-a-${suffix}`,
        `ticket_b_${suffix}`,
        organizationB,
        userB,
        `ticket-hash-b-${suffix}`,
      ]
    );

    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
    await client.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    await client.query(`SELECT set_config('app.current_organization_id', 'org_devfathom', true)`);

    const tenantA = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "users" WHERE "id" IN ($1, $2)`,
      [userA, userB]
    );
    assertEqual(tenantA.rows[0]?.count, 1, 'tenant A must only see its own user');
    const tenantASso = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "organization_sso_states"
       WHERE "id" IN ($1, $2)`,
      [`state_a_${suffix}`, `state_b_${suffix}`]
    );
    assertEqual(tenantASso.rows[0]?.count, 1, 'tenant A must only see its own SSO state');
    const tenantATicket = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "tenant_sso_tickets"
       WHERE "id" IN ($1, $2)`,
      [`ticket_a_${suffix}`, `ticket_b_${suffix}`]
    );
    assertEqual(tenantATicket.rows[0]?.count, 1, 'tenant A must only see its own SSO ticket');

    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
      organizationB,
    ]);
    const tenantB = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "users" WHERE "id" IN ($1, $2)`,
      [userA, userB]
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

    if (platformUserId) {
      await expectDatabaseError('42501', () =>
        client.query(
          `INSERT INTO "platform_recovery_codes" (
            "id", "platformUserId", "codeHash", "createdAt"
          ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
          [`recovery_denied_${suffix}`, platformUserId, `hash-${suffix}`]
        )
      );
    }

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
      'RLS verification passed: forced policies, read isolation, SSO/ticket isolation, fail-closed access, composite ownership, and platform-only policies.'
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
