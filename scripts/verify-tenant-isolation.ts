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

    // MEET-01. One mirrored row per meeting table in each tenant, so every
    // read below distinguishes "isolated" from "empty".
    const projectB = `project_b_rls_${suffix}`;
    await client.query(
      `INSERT INTO "projects" ("id", "organizationId", "name", "status", "type", "createdAt", "updatedAt")
       VALUES ($1, $2, 'Tenant B Project', 'ACTIVE', 'INTERNAL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [projectB, organizationB]
    );

    const meetingA = `meeting_a_${suffix}`;
    const meetingB = `meeting_b_${suffix}`;
    // "timezone" is deliberately omitted: the insert trigger must derive it
    // from the owning organization rather than default it to a guessed UTC.
    await client.query(
      `INSERT INTO "meetings" (
        "id", "organizationId", "title", "startTime", "endTime", "createdById", "createdAt", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', 'Tenant A Meeting', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '30 minutes', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, $4, 'Tenant B Meeting', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '30 minutes', $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [meetingA, userA, meetingB, organizationB, userB]
    );
    const derivedTimezones = await client.query<{ id: string; timezone: string | null }>(
      `SELECT "id", "timezone" FROM "meetings" WHERE "id" IN ($1, $2) ORDER BY "id"`,
      [meetingA, meetingB]
    );
    assertEqual(
      derivedTimezones.rows.filter((row) => !row.timezone).length,
      0,
      'every meeting must receive an organization-derived timezone'
    );

    const occurrenceA = `occurrence_a_${suffix}`;
    const occurrenceB = `occurrence_b_${suffix}`;
    await client.query(
      `INSERT INTO "meeting_occurrences" (
        "id", "organizationId", "meetingId", "seriesSlotStart", "scheduledStart", "scheduledEnd",
        "joinOpensAt", "joinClosesAt", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '30 minutes',
         CURRENT_TIMESTAMP - interval '15 minutes', CURRENT_TIMESTAMP + interval '90 minutes', CURRENT_TIMESTAMP),
        ($3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '30 minutes',
         CURRENT_TIMESTAMP - interval '15 minutes', CURRENT_TIMESTAMP + interval '90 minutes', CURRENT_TIMESTAMP)`,
      [occurrenceA, meetingA, occurrenceB, organizationB, meetingB]
    );

    // publicId is the anonymous tenant-resolution key: it must be globally
    // unique, and it must name exactly one organization.
    const publicIds = await client.query<{ id: string; publicId: string; organizationId: string }>(
      `SELECT "id", "publicId", "organizationId" FROM "meeting_occurrences"
       WHERE "id" IN ($1, $2) ORDER BY "id"`,
      [occurrenceA, occurrenceB]
    );
    assertEqual(publicIds.rows.length, 2, 'both occurrences must exist before the publicId checks');
    const publicIdA = publicIds.rows.find((row) => row.id === occurrenceA)!.publicId;
    assertEqual(
      new Set(publicIds.rows.map((row) => row.publicId)).size,
      2,
      'each occurrence must receive its own publicId'
    );
    const publicIdOwners = await client.query<{ count: number }>(
      `SELECT COUNT(DISTINCT "organizationId")::int AS count FROM "meeting_occurrences" WHERE "publicId" = $1`,
      [publicIdA]
    );
    assertEqual(
      publicIdOwners.rows[0]?.count,
      1,
      'a lookup by publicId must resolve exactly one organization'
    );
    // Global, not per-tenant: a second tenant may not reuse it.
    await expectDatabaseError('23505', () =>
      client.query(
        `INSERT INTO "meeting_occurrences" (
          "id", "organizationId", "meetingId", "publicId", "seriesSlotStart", "scheduledStart", "scheduledEnd",
          "joinOpensAt", "joinClosesAt", "updatedAt"
        ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + interval '1 day', CURRENT_TIMESTAMP + interval '1 day',
          CURRENT_TIMESTAMP + interval '1 day', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '2 days', CURRENT_TIMESTAMP)`,
        [`occurrence_clash_${suffix}`, organizationB, meetingB, publicIdA]
      )
    );

    const participantA = `participant_a_${suffix}`;
    const participantB = `participant_b_${suffix}`;
    await client.query(
      `INSERT INTO "meeting_participants" (
        "id", "organizationId", "meetingId", "userId", "displayName", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, 'Tenant A Invitee', CURRENT_TIMESTAMP),
        ($4, $5, $6, $7, 'Tenant B Invitee', CURRENT_TIMESTAMP)`,
      [participantA, meetingA, userA, participantB, organizationB, meetingB, userB]
    );

    // The guest credential is occurrence-scoped, never series-scoped.
    await client.query(
      `INSERT INTO "meeting_occurrence_participants" (
        "id", "organizationId", "occurrenceId", "participantId", "userId", "displayName",
        "guestTokenHash", "guestTokenExpiresAt", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, $4, 'Tenant A Guest', $5, CURRENT_TIMESTAMP + interval '1 hour', CURRENT_TIMESTAMP),
        ($6, $7, $8, $9, $10, 'Tenant B Guest', $11, CURRENT_TIMESTAMP + interval '1 hour', CURRENT_TIMESTAMP)`,
      [
        `occurrence_participant_a_${suffix}`,
        occurrenceA,
        participantA,
        userA,
        `guest-hash-a-${suffix}`,
        `occurrence_participant_b_${suffix}`,
        organizationB,
        occurrenceB,
        participantB,
        userB,
        `guest-hash-b-${suffix}`,
      ]
    );

    await client.query(
      `INSERT INTO "meeting_participant_sessions" (
        "id", "organizationId", "occurrenceId", "userId", "source", "joinedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, 'LEGACY_CLIENT', CURRENT_TIMESTAMP),
        ($4, $5, $6, $7, 'LEGACY_CLIENT', CURRENT_TIMESTAMP)`,
      [
        `session_a_${suffix}`,
        occurrenceA,
        userA,
        `session_b_${suffix}`,
        organizationB,
        occurrenceB,
        userB,
      ]
    );

    // The same provider event id in two tenants must both insert: a globally
    // unique key here would leak the existence of another tenant's event.
    const sharedProviderEventId = `provider-event-${suffix}`;
    await client.query(
      `INSERT INTO "meeting_provider_events" (
        "id", "organizationId", "occurrenceId", "providerEventId", "eventType", "payload"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, 'participant.joined', '{}'),
        ($4, $5, $6, $3, 'participant.joined', '{}')`,
      [
        `provider_event_a_${suffix}`,
        occurrenceA,
        sharedProviderEventId,
        `provider_event_b_${suffix}`,
        organizationB,
        occurrenceB,
      ]
    );

    await client.query(
      `INSERT INTO "meeting_entity_links" ("id", "organizationId", "meetingId", "projectId")
       VALUES ($1, 'org_devfathom', $2, $3), ($4, $5, $6, $7)`,
      [
        `entity_link_a_${suffix}`,
        meetingA,
        projectA,
        `entity_link_b_${suffix}`,
        organizationB,
        meetingB,
        projectB,
      ]
    );

    const apiTokenA = `api_token_a_${suffix}`;
    const apiTokenB = `api_token_b_${suffix}`;
    const webhookA = `webhook_a_${suffix}`;
    const webhookB = `webhook_b_${suffix}`;
    const deliveryA = `delivery_a_${suffix}`;
    const deliveryB = `delivery_b_${suffix}`;
    const branchA = `branch_a_${suffix}`;
    const branchB = `branch_b_${suffix}`;
    const assignmentA = `assignment_a_${suffix}`;
    const assignmentB = `assignment_b_${suffix}`;
    await client.query(
      `INSERT INTO "api_tokens" (
        "id", "organizationId", "name", "prefix", "tokenHash", "scopes", "userId"
      ) VALUES
        ($1, 'org_devfathom', 'Tenant A token', $2, $3, '{}', $4),
        ($5, $6, 'Tenant B token', $7, $8, '{}', $9)`,
      [
        apiTokenA,
        `df_a_${suffix}`,
        `hash_a_${suffix}`,
        userA,
        apiTokenB,
        organizationB,
        `df_b_${suffix}`,
        `hash_b_${suffix}`,
        userB,
      ]
    );
    await client.query(
      `INSERT INTO "webhooks" (
        "id", "organizationId", "url", "secret", "events", "active", "createdById", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', 'https://a.example.test/hook', $2, '{task.created}', true, $3, CURRENT_TIMESTAMP),
        ($4, $5, 'https://b.example.test/hook', $6, '{task.created}', true, $7, CURRENT_TIMESTAMP)`,
      [webhookA, `secret_a_${suffix}`, userA, webhookB, organizationB, `secret_b_${suffix}`, userB]
    );
    await client.query(
      `INSERT INTO "webhook_deliveries" (
        "id", "organizationId", "webhookId", "event", "payload", "success"
      ) VALUES
        ($1, 'org_devfathom', $2, 'task.created', '{}', true),
        ($3, $4, $5, 'task.created', '{}', true)`,
      [deliveryA, webhookA, deliveryB, organizationB, webhookB]
    );

    // M1-L1: restaurant branch tables carry a bare organizationId and forced
    // org-level RLS. One branch + one user-to-branch assignment per tenant, so
    // each read below distinguishes "isolated" from "empty".
    await client.query(
      `INSERT INTO "restaurant_branches" (
        "id", "organizationId", "name", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', 'Tenant A Branch', CURRENT_TIMESTAMP),
        ($2, $3, 'Tenant B Branch', CURRENT_TIMESTAMP)`,
      [branchA, branchB, organizationB]
    );
    await client.query(
      `INSERT INTO "restaurant_branch_assignments" (
        "id", "organizationId", "branchId", "userId", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, CURRENT_TIMESTAMP),
        ($4, $5, $6, $7, CURRENT_TIMESTAMP)`,
      [assignmentA, branchA, userA, assignmentB, organizationB, branchB, userB]
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

    for (const [table, idA, idB] of [
      ['api_tokens', apiTokenA, apiTokenB],
      ['webhooks', webhookA, webhookB],
      ['webhook_deliveries', deliveryA, deliveryB],
      ['restaurant_branches', branchA, branchB],
      ['restaurant_branch_assignments', assignmentA, assignmentB],
    ] as const) {
      const visible = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "${table}" WHERE "id" IN ($1, $2)`,
        [idA, idB]
      );
      assertEqual(visible.rows[0]?.count, 1, `tenant A must only see its own "${table}" row`);
      const updated = await client.query(
        `UPDATE "${table}" SET "organizationId" = "organizationId" WHERE "id" = $1`,
        [idB]
      );
      assertEqual(updated.rowCount, 0, `tenant A must not update tenant B's "${table}" row`);
      const deleted = await client.query(`DELETE FROM "${table}" WHERE "id" = $1`, [idB]);
      assertEqual(deleted.rowCount, 0, `tenant A must not delete tenant B's "${table}" row`);
    }

    // MEET-01: one read-isolation case per new meeting table. Each query names
    // both tenants' rows, so seeing exactly one proves isolation rather than an
    // empty table.
    const meetingIsolation: Array<[table: string, idA: string, idB: string]> = [
      ['meetings', meetingA, meetingB],
      ['meeting_occurrences', occurrenceA, occurrenceB],
      ['meeting_participants', participantA, participantB],
      [
        'meeting_occurrence_participants',
        `occurrence_participant_a_${suffix}`,
        `occurrence_participant_b_${suffix}`,
      ],
      ['meeting_participant_sessions', `session_a_${suffix}`, `session_b_${suffix}`],
      ['meeting_provider_events', `provider_event_a_${suffix}`, `provider_event_b_${suffix}`],
      ['meeting_entity_links', `entity_link_a_${suffix}`, `entity_link_b_${suffix}`],
    ];
    for (const [table, idA, idB] of meetingIsolation) {
      const visible = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "${table}" WHERE "id" IN ($1, $2)`,
        [idA, idB]
      );
      assertEqual(visible.rows[0]?.count, 1, `tenant A must only see its own "${table}" row`);

      const updated = await client.query(
        `UPDATE "${table}" SET "organizationId" = "organizationId" WHERE "id" = $1`,
        [idB]
      );
      assertEqual(
        updated.rowCount,
        0,
        `tenant A must not be able to write tenant B's "${table}" row`
      );

      const deleted = await client.query(`DELETE FROM "${table}" WHERE "id" = $1`, [idB]);
      assertEqual(
        deleted.rowCount,
        0,
        `tenant A must not be able to delete tenant B's "${table}" row`
      );
    }

    // A join link is a locator, not authorization: even holding tenant B's
    // publicId, a tenant A scope resolves nothing.
    const foreignPublicId = publicIds.rows.find((row) => row.id === occurrenceB)!.publicId;
    const foreignLookup = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "meeting_occurrences" WHERE "publicId" = $1`,
      [foreignPublicId]
    );
    assertEqual(
      foreignLookup.rows[0]?.count,
      0,
      "a tenant scope must not resolve another organization's occurrence by publicId"
    );

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

    // M1-L1: the branch table's WITH CHECK must fail closed too — a tenant A
    // scope cannot mint a branch owned by another organization.
    await expectDatabaseError('42501', () =>
      client.query(
        `INSERT INTO "restaurant_branches" ("id", "organizationId", "name", "updatedAt")
         VALUES ($1, $2, 'Escape Branch', CURRENT_TIMESTAMP)`,
        [`branch_escape_${suffix}`, organizationB]
      )
    );

    // MEET-01: a tenant scope may not insert a meeting row that belongs to
    // another organization.
    const meetingWriteDenied: Array<[sql: string, values: unknown[]]> = [
      [
        `INSERT INTO "meeting_occurrences" (
          "id", "organizationId", "meetingId", "seriesSlotStart", "scheduledStart", "scheduledEnd",
          "joinOpensAt", "joinClosesAt", "updatedAt"
        ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '30 minutes',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '1 hour', CURRENT_TIMESTAMP)`,
        [`deny_occurrence_${suffix}`, organizationB, meetingB],
      ],
      [
        `INSERT INTO "meeting_participants" (
          "id", "organizationId", "meetingId", "email", "displayName", "updatedAt"
        ) VALUES ($1, $2, $3, $4, 'Denied', CURRENT_TIMESTAMP)`,
        [`deny_participant_${suffix}`, organizationB, meetingB, `deny-${suffix}@example.test`],
      ],
      [
        `INSERT INTO "meeting_occurrence_participants" (
          "id", "organizationId", "occurrenceId", "displayName", "updatedAt"
        ) VALUES ($1, $2, $3, 'Denied', CURRENT_TIMESTAMP)`,
        [`deny_occurrence_participant_${suffix}`, organizationB, occurrenceB],
      ],
      [
        `INSERT INTO "meeting_participant_sessions" (
          "id", "organizationId", "occurrenceId", "source", "joinedAt"
        ) VALUES ($1, $2, $3, 'LEGACY_CLIENT', CURRENT_TIMESTAMP)`,
        [`deny_session_${suffix}`, organizationB, occurrenceB],
      ],
      [
        `INSERT INTO "meeting_provider_events" (
          "id", "organizationId", "occurrenceId", "providerEventId", "eventType", "payload"
        ) VALUES ($1, $2, $3, $4, 'participant.joined', '{}')`,
        [`deny_event_${suffix}`, organizationB, occurrenceB, `deny-event-${suffix}`],
      ],
      [
        `INSERT INTO "meeting_entity_links" ("id", "organizationId", "meetingId", "projectId")
         VALUES ($1, $2, $3, $4)`,
        [`deny_link_${suffix}`, organizationB, meetingB, projectB],
      ],
    ];
    for (const [sql, values] of meetingWriteDenied) {
      await expectDatabaseError('42501', () => client.query(sql, values));
    }

    // Owning the organizationId is not enough: the row it points at must be the
    // same tenant's too.
    await expectDatabaseError('23503', async () => {
      await client.query(
        `INSERT INTO "meeting_occurrences" (
          "id", "organizationId", "meetingId", "seriesSlotStart", "scheduledStart", "scheduledEnd",
          "joinOpensAt", "joinClosesAt", "updatedAt"
        ) VALUES ($1, 'org_devfathom', $2, CURRENT_TIMESTAMP + interval '3 days',
          CURRENT_TIMESTAMP + interval '3 days', CURRENT_TIMESTAMP + interval '3 days' + interval '30 minutes',
          CURRENT_TIMESTAMP + interval '3 days', CURRENT_TIMESTAMP + interval '4 days', CURRENT_TIMESTAMP)`,
        [`cross_occurrence_${suffix}`, meetingB]
      );
      await client.query(`SET CONSTRAINTS "tenant_mtg_occurrences_meetingId_fk" IMMEDIATE`);
    });

    // The series-level invitee table must never gain a credential column, and
    // the credential it must not hold has to exist somewhere occurrence-scoped
    // — otherwise this assertion passes for the wrong reason.
    const seriesCredentials = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'meeting_participants'
         AND (column_name ILIKE '%token%' OR column_name ILIKE '%secret%'
           OR column_name ILIKE '%password%' OR column_name ILIKE '%hash%'
           OR column_name ILIKE '%credential%' OR column_name ILIKE '%expires%')`
    );
    assertEqual(
      seriesCredentials.rows.length,
      0,
      `meeting_participants must hold no credential (found ${seriesCredentials.rows
        .map((row) => row.column_name)
        .join(', ')}); nothing credential-bearing may span a recurring series`
    );
    const occurrenceCredentials = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'meeting_occurrence_participants'
         AND column_name IN ('guestTokenHash', 'guestTokenExpiresAt', 'guestTokenRevokedAt')`
    );
    assertEqual(
      occurrenceCredentials.rows[0]?.count,
      3,
      'the guest credential must live on the occurrence-scoped grant'
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

    // D8: the pending-login intent spans organizations before one is chosen, so
    // it lives in the control plane. A tenant scope must not be able to read it
    // (it would expose which organizations an address belongs to) or write it
    // (it would forge the candidate set that authorizes workspace selection).
    await expectDatabaseError('42501', () =>
      client.query(
        `INSERT INTO "pending_login_intents" (
          "id", "tokenHash", "email", "host", "candidates", "expiresAt", "createdAt"
        ) VALUES ($1, $2, 'forged@example.test', 'www.example.test', $3::jsonb,
          CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
        [
          `intent_denied_${suffix}`,
          `hash_denied_${suffix}`,
          JSON.stringify([{ organizationId: organizationB, userId: userB }]),
        ]
      )
    );

    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // The same insert succeeds in the platform scope, and the row it creates is
    // then invisible again once the request returns to a tenant scope.
    await client.query(
      `INSERT INTO "pending_login_intents" (
        "id", "tokenHash", "email", "host", "candidates", "expiresAt", "createdAt"
      ) VALUES ($1, $2, 'discovery@example.test', 'www.example.test', $3::jsonb,
        CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
      [
        `intent_allowed_${suffix}`,
        `hash_allowed_${suffix}`,
        JSON.stringify([{ organizationId: organizationB, userId: userB }]),
      ]
    );
    const intentInPlatformScope = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "pending_login_intents" WHERE "id" = $1`,
      [`intent_allowed_${suffix}`]
    );
    assertEqual(
      intentInPlatformScope.rows[0]?.count,
      1,
      'platform scope must be able to read a pending login intent'
    );

    await client.query(
      `SELECT set_config('app.current_organization_id', 'org_devfathom', true),
              set_config('app.is_platform_admin', 'false', true)`
    );
    const intentInTenantScope = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "pending_login_intents"`
    );
    assertEqual(
      intentInTenantScope.rows[0]?.count,
      0,
      'tenant scope must never see a pending login intent'
    );

    // findLoginCandidates is the one new cross-tenant read in the login change.
    // It is only safe because it runs in the platform scope: the same query from
    // a tenant scope must return nothing for another organization's member.
    const crossTenantByEmail = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "users" WHERE "organizationId" = $1`,
      [organizationB]
    );
    assertEqual(
      crossTenantByEmail.rows[0]?.count,
      0,
      'a tenant scope must not reach another organization user by email discovery'
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
      'RLS verification passed: forced policies, read isolation, token/webhook isolation, restaurant branch/assignment isolation, SSO/ticket isolation, meeting occurrence/participant/session/event/link isolation, globally unique occurrence publicId, credential-free meeting series, fail-closed access, composite ownership, platform-only policies, and pending-login-intent control-plane isolation.'
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
