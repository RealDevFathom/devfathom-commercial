import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { defaultDepartmentRowsForVertical } from '../src/lib/vertical-catalog.js';

const { Client } = pg;

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required; tenant isolation tests never use DATABASE_URL.');
}

const parsedUrl = new URL(databaseUrl);
// WHATWG `URL.hostname` keeps the brackets around an IPv6 host, so the IPv6
// loopback arrives as "[::1]" (every spelling of it normalises to that); a bare
// "::1" is never what the parser yields.
if (
  !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsedUrl.hostname) &&
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

// `context` names the statement in the one failure that is otherwise anonymous
// (it ran through); a wrong error code rethrows the PostgreSQL error itself,
// which already names the table or constraint.
async function expectDatabaseError(code: string, run: () => Promise<unknown>, context?: string) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await run();
    throw new Error(
      `Expected PostgreSQL error ${code}${context ? ` (${context})` : ''}, but the statement succeeded.`
    );
  } catch (error) {
    const received = error instanceof Error && 'code' in error ? String(error.code) : null;
    if (received !== code) throw error;
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client.query('RELEASE SAVEPOINT expected_failure');
  }
}

// A write that names an existing row (WHERE "id" = ..., SET x = x) reads it, and
// PostgreSQL then applies the SELECT policy to the UPDATE or DELETE as well — so
// such a probe cannot tell a scoped UPDATE/DELETE policy from a permissive one.
// A blind write (a constant SET, no WHERE) reads nothing: only the UPDATE or
// DELETE policy decides which rows it reaches, and it must reach exactly the
// rows the current scope can see. It runs inside a savepoint that is rolled
// back, so the scope's own rows survive for the probes that follow.
async function expectBlindWriteScoped(table: string, sql: string, before: string[] = []) {
  const visible = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM "${table}"`
  );
  const visibleCount = visible.rows[0]?.count ?? 0;
  if (visibleCount < 1) {
    throw new Error(`tenant A must see its own "${table}" row before the blind write probe`);
  }
  await client.query('SAVEPOINT blind_write');
  try {
    // A RESTRICT child the probe table holds has to go first, inside the same
    // rolled-back savepoint; the count under probe is still the parent's.
    for (const statement of before) await client.query(statement);
    const written = await client.query(sql);
    assertEqual(
      written.rowCount,
      visibleCount,
      `a blind write to "${table}" must reach only the rows tenant A can see`
    );
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT blind_write');
    await client.query('RELEASE SAVEPOINT blind_write');
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
    // H1: the hospitality probes need two more members of tenant A — one who is
    // assigned beside user A at the property, and one who is not assigned at all.
    const tenantAColleagues = await client.query<{ id: string }>(
      `SELECT "id" FROM "users"
       WHERE "organizationId" = 'org_devfathom' AND "status" = 'ACTIVE' AND "id" <> $1
       ORDER BY "createdAt" ASC LIMIT 2`,
      [userA]
    );
    assertEqual(
      tenantAColleagues.rows.length,
      2,
      'the seeded tenant must hold at least three active members for the hotel probes'
    );
    const colleagueA = tenantAColleagues.rows[0]!.id;
    const strangerA = tenantAColleagues.rows[1]!.id;
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
    // The runtime role's sequence grants too (docs/LOCAL_SETUP.md). Without them
    // an insert that draws a sequence default (restaurant_branches.code) fails
    // 42501 on the sequence before RLS WITH CHECK runs, masking the policy.
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${runtimeRole}"`);

    await client.query(
      `INSERT INTO "organizations" (
      "id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt"
    ) VALUES ($1, $2, 'Isolation B', 'Isolation B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [organizationB, `isolation-${suffix}`]
    );
    // WHA-290: `users.department` is a composite foreign key onto
    // `organization_departments`, so this fixture organization needs its own
    // catalog before it can hold the tenant B user below (and before the
    // later 42501 probe inserts an ENGINEERING employee into it). Organization
    // B is created without a vertical, so it takes the AGENCY default.
    for (const department of defaultDepartmentRowsForVertical('AGENCY')) {
      await client.query(
        `INSERT INTO "organization_departments" (
        "id", "organizationId", "key", "name", "sortOrder", "createdAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          `department_${suffix}_${department.key.toLowerCase()}`,
          organizationB,
          department.key,
          department.name,
          department.sortOrder,
        ]
      );
    }
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
    // M2-L1: staff/operator/device/session/co-authorization ids. Two staff
    // profiles per tenant so the co-authorization can pin two distinct identities.
    const staffA1 = `staff_a1_${suffix}`;
    const staffA2 = `staff_a2_${suffix}`;
    const staffB1 = `staff_b1_${suffix}`;
    const staffB2 = `staff_b2_${suffix}`;
    const deviceA = `device_a_${suffix}`;
    const deviceB = `device_b_${suffix}`;
    const credentialA = `credential_a_${suffix}`;
    const credentialB = `credential_b_${suffix}`;
    const sessionA = `terminal_session_a_${suffix}`;
    const sessionB = `terminal_session_b_${suffix}`;
    const coAuthA = `coauth_a_${suffix}`;
    const coAuthB = `coauth_b_${suffix}`;
    // M3-L1: representative catalog/menu ids per tenant. The probe covers a
    // canonical row (product), a versioned row (recipe version), an effective-
    // dated priced row (price-list entry), the branch-linked publication, and a
    // per-publication override — plus the intermediate rows they hang off.
    const brandA = `rbrand_a_${suffix}`;
    const brandB = `rbrand_b_${suffix}`;
    const productA = `rprod_a_${suffix}`;
    const productB = `rprod_b_${suffix}`;
    const recipeA = `rrecipe_a_${suffix}`;
    const recipeB = `rrecipe_b_${suffix}`;
    const recipeVersionA = `rrecver_a_${suffix}`;
    const recipeVersionB = `rrecver_b_${suffix}`;
    const priceListA = `rplist_a_${suffix}`;
    const priceListB = `rplist_b_${suffix}`;
    const priceListVersionA = `rplver_a_${suffix}`;
    const priceListVersionB = `rplver_b_${suffix}`;
    const priceEntryA = `rplentry_a_${suffix}`;
    const priceEntryB = `rplentry_b_${suffix}`;
    const menuA = `rmenu_a_${suffix}`;
    const menuB = `rmenu_b_${suffix}`;
    const menuSectionA = `rmsec_a_${suffix}`;
    const menuSectionB = `rmsec_b_${suffix}`;
    const menuItemA = `rmitem_a_${suffix}`;
    const menuItemB = `rmitem_b_${suffix}`;
    const publicationA = `rpub_a_${suffix}`;
    const publicationB = `rpub_b_${suffix}`;
    const itemOverrideA = `rovr_a_${suffix}`;
    const itemOverrideB = `rovr_b_${suffix}`;
    // M4-L1: representative order/kitchen/floor ids per tenant. The probe covers
    // an order, an order item, an append-only order event, a kitchen ticket, a
    // floor table, a section assignment, an outbox row, and a device idempotency
    // key — plus the floor/station/section parents they hang off.
    const floorA = `rfloor_a_${suffix}`;
    const floorB = `rfloor_b_${suffix}`;
    const tableA = `rtable_a_${suffix}`;
    const tableB = `rtable_b_${suffix}`;
    const sectionA = `rsection_a_${suffix}`;
    const sectionB = `rsection_b_${suffix}`;
    const sectionAssignmentA = `rsecassign_a_${suffix}`;
    const sectionAssignmentB = `rsecassign_b_${suffix}`;
    const stationA = `rstation_a_${suffix}`;
    const stationB = `rstation_b_${suffix}`;
    const orderA = `rorder_a_${suffix}`;
    const orderB = `rorder_b_${suffix}`;
    const orderItemA = `roitem_a_${suffix}`;
    const orderItemB = `roitem_b_${suffix}`;
    const orderEventA = `roevent_a_${suffix}`;
    const orderEventB = `roevent_b_${suffix}`;
    const ticketA = `rticket_a_${suffix}`;
    const ticketB = `rticket_b_${suffix}`;
    const outboxA = `routbox_a_${suffix}`;
    const outboxB = `routbox_b_${suffix}`;
    const idempotencyA = `ridem_a_${suffix}`;
    const idempotencyB = `ridem_b_${suffix}`;
    // M5-L1: representative money ids per tenant. The probe covers a bill, a bill
    // line, a payment, an append-only payment event, an append-only tender, an
    // append-only refund, a drawer session, an append-only drawer movement, an
    // append-only daily close, an append-only close tender total, a receipt-number
    // sequence, and a money idempotency key — the 12 M5 tables.
    const billA = `rbill_a_${suffix}`;
    const billB = `rbill_b_${suffix}`;
    const billLineA = `rbline_a_${suffix}`;
    const billLineB = `rbline_b_${suffix}`;
    const paymentA = `rpay_a_${suffix}`;
    const paymentB = `rpay_b_${suffix}`;
    const paymentEventA = `rpayev_a_${suffix}`;
    const paymentEventB = `rpayev_b_${suffix}`;
    const tenderA = `rtender_a_${suffix}`;
    const tenderB = `rtender_b_${suffix}`;
    const refundA = `rrefund_a_${suffix}`;
    const refundB = `rrefund_b_${suffix}`;
    const drawerSessionA = `rdrawer_a_${suffix}`;
    const drawerSessionB = `rdrawer_b_${suffix}`;
    const drawerMovementA = `rdmove_a_${suffix}`;
    const drawerMovementB = `rdmove_b_${suffix}`;
    const dailyCloseA = `rclose_a_${suffix}`;
    const dailyCloseB = `rclose_b_${suffix}`;
    const closeTenderTotalA = `rclosett_a_${suffix}`;
    const closeTenderTotalB = `rclosett_b_${suffix}`;
    const receiptSeqA = `rrcpt_a_${suffix}`;
    const receiptSeqB = `rrcpt_b_${suffix}`;
    const moneyIdemA = `rmidem_a_${suffix}`;
    const moneyIdemB = `rmidem_b_${suffix}`;
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

    // M2-L1: staff operators, devices, credentials, terminal sessions and
    // co-authorizations. One (or two, for staff) mirrored row per tenant per
    // table so every read below distinguishes "isolated" from "empty".
    await client.query(
      `INSERT INTO "restaurant_staff_profiles" (
        "id", "organizationId", "displayName", "primaryBranchId", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', 'Tenant A Operator', $2, CURRENT_TIMESTAMP),
        ($3, 'org_devfathom', 'Tenant A Manager', $2, CURRENT_TIMESTAMP),
        ($4, $5, 'Tenant B Operator', $6, CURRENT_TIMESTAMP),
        ($7, $5, 'Tenant B Manager', $6, CURRENT_TIMESTAMP)`,
      [staffA1, branchA, staffA2, staffB1, organizationB, branchB, staffB2]
    );
    await client.query(
      `INSERT INTO "restaurant_registered_devices" (
        "id", "organizationId", "branchId", "name", "deviceSecretHash", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, 'Tenant A POS', $3, CURRENT_TIMESTAMP),
        ($4, $5, $6, 'Tenant B POS', $7, CURRENT_TIMESTAMP)`,
      [
        deviceA,
        branchA,
        `device-hash-a-${suffix}`,
        deviceB,
        organizationB,
        branchB,
        `device-hash-b-${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_operator_credentials" (
        "id", "organizationId", "staffProfileId", "deviceId", "type", "credentialHash", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, 'PIN', $4, CURRENT_TIMESTAMP),
        ($5, $6, $7, $8, 'PIN', $9, CURRENT_TIMESTAMP)`,
      [
        credentialA,
        staffA1,
        deviceA,
        `pin-hash-a-${suffix}`,
        credentialB,
        organizationB,
        staffB1,
        deviceB,
        `pin-hash-b-${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_terminal_sessions" (
        "id", "organizationId", "deviceId", "activeStaffProfileId", "tokenHash", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, $4, CURRENT_TIMESTAMP),
        ($5, $6, $7, $8, $9, CURRENT_TIMESTAMP)`,
      [
        sessionA,
        deviceA,
        staffA1,
        `session-hash-a-${suffix}`,
        sessionB,
        organizationB,
        deviceB,
        staffB1,
        `session-hash-b-${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_co_authorizations" (
        "id", "organizationId", "actingStaffProfileId", "approvingStaffProfileId",
        "capability", "reason", "deviceId", "terminalSessionId"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, 'orders:void', 'Tenant A void', $4, $5),
        ($6, $7, $8, $9, 'orders:void', 'Tenant B void', $10, $11)`,
      [
        coAuthA,
        staffA1,
        staffA2,
        deviceA,
        sessionA,
        coAuthB,
        organizationB,
        staffB1,
        staffB2,
        deviceB,
        sessionB,
      ]
    );

    // M3-L1: brand -> product -> (recipe version | price-list entry) and
    // brand -> menu -> section -> item plus branch -> publication -> item
    // override, one mirrored graph per tenant. Parents precede children so the
    // immediate single-column FKs pass during seeding; the deferred composite
    // tenant FKs are validated at COMMIT.
    await client.query(
      `INSERT INTO "restaurant_brands" (
        "id", "organizationId", "name", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', 'Tenant A Brand', CURRENT_TIMESTAMP),
        ($2, $3, 'Tenant B Brand', CURRENT_TIMESTAMP)`,
      [brandA, brandB, organizationB]
    );
    await client.query(
      `INSERT INTO "restaurant_products" (
        "id", "organizationId", "type", "status", "name", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', 'ITEM', 'ACTIVE', 'Tenant A Product', CURRENT_TIMESTAMP),
        ($2, $3, 'ITEM', 'ACTIVE', 'Tenant B Product', CURRENT_TIMESTAMP)`,
      [productA, productB, organizationB]
    );
    await client.query(
      `INSERT INTO "restaurant_recipes" (
        "id", "organizationId", "productId", "name", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, 'Tenant A Recipe', CURRENT_TIMESTAMP),
        ($3, $4, $5, 'Tenant B Recipe', CURRENT_TIMESTAMP)`,
      [recipeA, productA, recipeB, organizationB, productB]
    );
    await client.query(
      `INSERT INTO "restaurant_recipe_versions" (
        "id", "organizationId", "recipeId", "versionNumber", "status", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, 1, 'ACTIVE', CURRENT_TIMESTAMP),
        ($3, $4, $5, 1, 'ACTIVE', CURRENT_TIMESTAMP)`,
      [recipeVersionA, recipeA, recipeVersionB, organizationB, recipeB]
    );
    await client.query(
      `INSERT INTO "restaurant_price_lists" (
        "id", "organizationId", "name", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', 'Tenant A List', CURRENT_TIMESTAMP),
        ($2, $3, 'Tenant B List', CURRENT_TIMESTAMP)`,
      [priceListA, priceListB, organizationB]
    );
    await client.query(
      `INSERT INTO "restaurant_price_list_versions" (
        "id", "organizationId", "priceListId", "versionNumber", "effectiveFrom", "status", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, 1, CURRENT_TIMESTAMP, 'ACTIVE', CURRENT_TIMESTAMP),
        ($3, $4, $5, 1, CURRENT_TIMESTAMP, 'ACTIVE', CURRENT_TIMESTAMP)`,
      [priceListVersionA, priceListA, priceListVersionB, organizationB, priceListB]
    );
    await client.query(
      `INSERT INTO "restaurant_price_list_entries" (
        "id", "organizationId", "priceListVersionId", "productId", "price", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, 9.99, CURRENT_TIMESTAMP),
        ($4, $5, $6, $7, 9.99, CURRENT_TIMESTAMP)`,
      [
        priceEntryA,
        priceListVersionA,
        productA,
        priceEntryB,
        organizationB,
        priceListVersionB,
        productB,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_menus" (
        "id", "organizationId", "brandId", "name", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, 'Tenant A Menu', CURRENT_TIMESTAMP),
        ($3, $4, $5, 'Tenant B Menu', CURRENT_TIMESTAMP)`,
      [menuA, brandA, menuB, organizationB, brandB]
    );
    await client.query(
      `INSERT INTO "restaurant_menu_sections" (
        "id", "organizationId", "menuId", "name", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, 'Tenant A Section', CURRENT_TIMESTAMP),
        ($3, $4, $5, 'Tenant B Section', CURRENT_TIMESTAMP)`,
      [menuSectionA, menuA, menuSectionB, organizationB, menuB]
    );
    await client.query(
      `INSERT INTO "restaurant_menu_items" (
        "id", "organizationId", "sectionId", "productId", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, CURRENT_TIMESTAMP),
        ($4, $5, $6, $7, CURRENT_TIMESTAMP)`,
      [menuItemA, menuSectionA, productA, menuItemB, organizationB, menuSectionB, productB]
    );
    await client.query(
      `INSERT INTO "restaurant_branch_menu_publications" (
        "id", "organizationId", "branchId", "menuId", "status", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, 'PUBLISHED', CURRENT_TIMESTAMP),
        ($4, $5, $6, $7, 'PUBLISHED', CURRENT_TIMESTAMP)`,
      [publicationA, branchA, menuA, publicationB, organizationB, branchB, menuB]
    );
    await client.query(
      `INSERT INTO "restaurant_branch_menu_item_overrides" (
        "id", "organizationId", "publicationId", "menuItemId", "isAvailable", "updatedAt"
      ) VALUES
        ($1, 'org_devfathom', $2, $3, true, CURRENT_TIMESTAMP),
        ($4, $5, $6, $7, true, CURRENT_TIMESTAMP)`,
      [
        itemOverrideA,
        publicationA,
        menuItemA,
        itemOverrideB,
        organizationB,
        publicationB,
        menuItemB,
      ]
    );

    // M4-L1: floor/service, station, section, order graph + kitchen ticket,
    // outbox, and idempotency key — one mirrored set per tenant. Parents precede
    // children so the immediate single-column FKs pass during seeding; the
    // deferred composite tenant FKs are validated at COMMIT (rolled back here).
    await client.query(
      `INSERT INTO "restaurant_floors" ("id", "organizationId", "branchId", "name", "updatedAt")
       VALUES ($1, 'org_devfathom', $2, 'Tenant A Floor', CURRENT_TIMESTAMP),
              ($3, $4, $5, 'Tenant B Floor', CURRENT_TIMESTAMP)`,
      [floorA, branchA, floorB, organizationB, branchB]
    );
    await client.query(
      `INSERT INTO "restaurant_tables" ("id", "organizationId", "floorId", "code", "capacity", "updatedAt")
       VALUES ($1, 'org_devfathom', $2, 'A1', 4, CURRENT_TIMESTAMP),
              ($3, $4, $5, 'B1', 4, CURRENT_TIMESTAMP)`,
      [tableA, floorA, tableB, organizationB, floorB]
    );
    await client.query(
      `INSERT INTO "restaurant_server_sections" ("id", "organizationId", "branchId", "name", "updatedAt")
       VALUES ($1, 'org_devfathom', $2, 'Tenant A Section', CURRENT_TIMESTAMP),
              ($3, $4, $5, 'Tenant B Section', CURRENT_TIMESTAMP)`,
      [sectionA, branchA, sectionB, organizationB, branchB]
    );
    await client.query(
      `INSERT INTO "restaurant_server_section_assignments" (
        "id", "organizationId", "sectionId", "staffProfileId", "businessDate", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, DATE '2030-01-01', CURRENT_TIMESTAMP),
               ($4, $5, $6, $7, DATE '2030-01-01', CURRENT_TIMESTAMP)`,
      [sectionAssignmentA, sectionA, staffA1, sectionAssignmentB, organizationB, sectionB, staffB1]
    );
    await client.query(
      `INSERT INTO "restaurant_kitchen_stations" ("id", "organizationId", "branchId", "name", "updatedAt")
       VALUES ($1, 'org_devfathom', $2, 'Tenant A Grill', CURRENT_TIMESTAMP),
              ($3, $4, $5, 'Tenant B Grill', CURRENT_TIMESTAMP)`,
      [stationA, branchA, stationB, organizationB, branchB]
    );
    await client.query(
      `INSERT INTO "restaurant_orders" (
        "id", "organizationId", "branchId", "orderNumber", "businessDate", "channel",
        "staffProfileId", "deviceId", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, 1, DATE '2030-01-01', 'DINE_IN', $3, $4, CURRENT_TIMESTAMP),
               ($5, $6, $7, 1, DATE '2030-01-01', 'DINE_IN', $8, $9, CURRENT_TIMESTAMP)`,
      [orderA, branchA, staffA1, deviceA, orderB, organizationB, branchB, staffB1, deviceB]
    );
    await client.query(
      `INSERT INTO "restaurant_order_items" (
        "id", "organizationId", "orderId", "productId", "name", "unitPrice", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, 'Tenant A Item', 9.99, CURRENT_TIMESTAMP),
               ($4, $5, $6, $7, 'Tenant B Item', 9.99, CURRENT_TIMESTAMP)`,
      [orderItemA, orderA, productA, orderItemB, organizationB, orderB, productB]
    );
    await client.query(
      `INSERT INTO "restaurant_order_events" (
        "id", "organizationId", "orderId", "sequence", "eventType", "payload"
      ) VALUES ($1, 'org_devfathom', $2, 1, 'order.opened', '{}'),
               ($3, $4, $5, 1, 'order.opened', '{}')`,
      [orderEventA, orderA, orderEventB, organizationB, orderB]
    );
    await client.query(
      `INSERT INTO "restaurant_kitchen_tickets" (
        "id", "organizationId", "orderId", "stationId", "businessDate", "ticketNumber", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, DATE '2030-01-01', 1, CURRENT_TIMESTAMP),
               ($4, $5, $6, $7, DATE '2030-01-01', 1, CURRENT_TIMESTAMP)`,
      [ticketA, orderA, stationA, ticketB, organizationB, orderB, stationB]
    );
    await client.query(
      `INSERT INTO "restaurant_event_outbox" (
        "id", "organizationId", "eventType", "aggregateType", "aggregateId", "payload", "updatedAt"
      ) VALUES ($1, 'org_devfathom', 'order.opened', 'restaurant.order', $2, '{}', CURRENT_TIMESTAMP),
               ($3, $4, 'order.opened', 'restaurant.order', $5, '{}', CURRENT_TIMESTAMP)`,
      [outboxA, orderA, outboxB, organizationB, orderB]
    );
    await client.query(
      `INSERT INTO "restaurant_order_idempotency_keys" (
        "id", "organizationId", "deviceId", "key", "commandType", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, 'order.open', CURRENT_TIMESTAMP),
               ($4, $5, $6, $7, 'order.open', CURRENT_TIMESTAMP)`,
      [
        idempotencyA,
        deviceA,
        `idem-a-${suffix}`,
        idempotencyB,
        organizationB,
        deviceB,
        `idem-b-${suffix}`,
      ]
    );

    // M5-L1: bill -> (bill line | payment -> payment event) and drawer session ->
    // tender -> (refund | drawer movement) plus daily close -> tender total, the
    // receipt-number sequence, and the money idempotency key — one mirrored graph
    // per tenant. Parents precede children so the immediate single-column FKs pass
    // during seeding; the deferred composite tenant FKs are validated at COMMIT
    // (rolled back here). Every money value is DECIMAL(12,2) (C2).
    await client.query(
      `INSERT INTO "restaurant_bills" (
        "id", "organizationId", "orderId", "branchId", "businessDate",
        "openerStaffProfileId", "deviceId", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, DATE '2030-01-01', $4, $5, CURRENT_TIMESTAMP),
               ($6, $7, $8, $9, DATE '2030-01-01', $10, $11, CURRENT_TIMESTAMP)`,
      [
        billA,
        orderA,
        branchA,
        staffA1,
        deviceA,
        billB,
        organizationB,
        orderB,
        branchB,
        staffB1,
        deviceB,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_bill_lines" (
        "id", "organizationId", "billId", "orderItemId", "name", "unitPrice",
        "lineSubtotal", "lineTotal", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, 'Tenant A Line', 9.99, 9.99, 9.99, CURRENT_TIMESTAMP),
               ($4, $5, $6, $7, 'Tenant B Line', 9.99, 9.99, 9.99, CURRENT_TIMESTAMP)`,
      [billLineA, billA, orderItemA, billLineB, organizationB, billB, orderItemB]
    );
    await client.query(
      `INSERT INTO "restaurant_payments" (
        "id", "organizationId", "billId", "capability", "status", "amount",
        "staffProfileId", "deviceId", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, 'SALE', 'CAPTURED', 20.00, $3, $4, CURRENT_TIMESTAMP),
               ($5, $6, $7, 'SALE', 'CAPTURED', 20.00, $8, $9, CURRENT_TIMESTAMP)`,
      [paymentA, billA, staffA1, deviceA, paymentB, organizationB, billB, staffB1, deviceB]
    );
    await client.query(
      `INSERT INTO "restaurant_payment_events" (
        "id", "organizationId", "paymentId", "capability", "eventType", "payload"
      ) VALUES ($1, 'org_devfathom', $2, 'SALE', 'sale.captured', '{}'),
               ($3, $4, $5, 'SALE', 'sale.captured', '{}')`,
      [paymentEventA, paymentA, paymentEventB, organizationB, paymentB]
    );
    await client.query(
      `INSERT INTO "restaurant_drawer_sessions" (
        "id", "organizationId", "branchId", "deviceId", "staffProfileId",
        "businessDate", "openingFloat", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, $4, DATE '2030-01-01', 100.00, CURRENT_TIMESTAMP),
               ($5, $6, $7, $8, $9, DATE '2030-01-01', 100.00, CURRENT_TIMESTAMP)`,
      [
        drawerSessionA,
        branchA,
        deviceA,
        staffA1,
        drawerSessionB,
        organizationB,
        branchB,
        deviceB,
        staffB1,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_tenders" (
        "id", "organizationId", "billId", "type", "amount", "drawerSessionId",
        "businessDate", "staffProfileId", "deviceId"
      ) VALUES ($1, 'org_devfathom', $2, 'CASH', 10.00, $3, DATE '2030-01-01', $4, $5),
               ($6, $7, $8, 'CASH', 10.00, $9, DATE '2030-01-01', $10, $11)`,
      [
        tenderA,
        billA,
        drawerSessionA,
        staffA1,
        deviceA,
        tenderB,
        organizationB,
        billB,
        drawerSessionB,
        staffB1,
        deviceB,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_refunds" (
        "id", "organizationId", "originalTenderId", "billId", "amount", "kind",
        "businessDate", "reason", "coAuthorizationId", "staffProfileId", "deviceId"
      ) VALUES ($1, 'org_devfathom', $2, $3, 5.00, 'REFUND', DATE '2030-01-01', 'Tenant A refund', $4, $5, $6),
               ($7, $8, $9, $10, 5.00, 'REFUND', DATE '2030-01-01', 'Tenant B refund', $11, $12, $13)`,
      [
        refundA,
        tenderA,
        billA,
        coAuthA,
        staffA1,
        deviceA,
        refundB,
        organizationB,
        tenderB,
        billB,
        coAuthB,
        staffB1,
        deviceB,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_drawer_movements" (
        "id", "organizationId", "drawerSessionId", "kind", "amount", "tenderId",
        "staffProfileId", "deviceId"
      ) VALUES ($1, 'org_devfathom', $2, 'CASH_SALE', 10.00, $3, $4, $5),
               ($6, $7, $8, 'CASH_SALE', 10.00, $9, $10, $11)`,
      [
        drawerMovementA,
        drawerSessionA,
        tenderA,
        staffA1,
        deviceA,
        drawerMovementB,
        organizationB,
        drawerSessionB,
        tenderB,
        staffB1,
        deviceB,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_daily_closes" (
        "id", "organizationId", "branchId", "businessDate", "cutByStaffProfileId"
      ) VALUES ($1, 'org_devfathom', $2, DATE '2030-01-01', $3),
               ($4, $5, $6, DATE '2030-01-01', $7)`,
      [dailyCloseA, branchA, staffA1, dailyCloseB, organizationB, branchB, staffB1]
    );
    await client.query(
      `INSERT INTO "restaurant_daily_close_tender_totals" (
        "id", "organizationId", "dailyCloseId", "tenderType", "amount", "count"
      ) VALUES ($1, 'org_devfathom', $2, 'CASH', 10.00, 1),
               ($3, $4, $5, 'CASH', 10.00, 1)`,
      [closeTenderTotalA, dailyCloseA, closeTenderTotalB, organizationB, dailyCloseB]
    );
    await client.query(
      `INSERT INTO "restaurant_receipt_number_sequences" (
        "id", "organizationId", "branchId", "businessDate", "nextNumber", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, DATE '2030-01-01', 1, CURRENT_TIMESTAMP),
               ($3, $4, $5, DATE '2030-01-01', 1, CURRENT_TIMESTAMP)`,
      [receiptSeqA, branchA, receiptSeqB, organizationB, branchB]
    );
    await client.query(
      `INSERT INTO "restaurant_money_idempotency_keys" (
        "id", "organizationId", "deviceId", "key", "commandType", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, 'tender.apply', CURRENT_TIMESTAMP),
               ($4, $5, $6, $7, 'tender.apply', CURRENT_TIMESTAMP)`,
      [
        moneyIdemA,
        deviceA,
        `money-idem-a-${suffix}`,
        moneyIdemB,
        organizationB,
        deviceB,
        `money-idem-b-${suffix}`,
      ]
    );

    // M7-L1: representative scheduler/SOP/notification ids per tenant. The probe
    // covers a durable job, its APPEND-ONLY execution row, a webhook-inbox
    // envelope, an in-app notification, and its APPEND-ONLY delivery row — org-
    // scoped tables plus two of the five DB-enforced append-only ledgers, which
    // deny UPDATE/DELETE even to the owner (asserted below). Forced RLS on all 17
    // M7 tables is proven by the auto-discovery probe above; the append-only
    // policy shape of all five ledgers is pinned by restaurant-m5-governance.
    const jobA = `rjob_a_${suffix}`;
    const jobB = `rjob_b_${suffix}`;
    const jobExecA = `rjobx_a_${suffix}`;
    const jobExecB = `rjobx_b_${suffix}`;
    const webhookInboxA = `rwhi_a_${suffix}`;
    const webhookInboxB = `rwhi_b_${suffix}`;
    const notificationA = `rnotif_a_${suffix}`;
    const notificationB = `rnotif_b_${suffix}`;
    const notifDeliveryA = `rndlv_a_${suffix}`;
    const notifDeliveryB = `rndlv_b_${suffix}`;
    await client.query(
      `INSERT INTO "restaurant_jobs" (
        "id", "organizationId", "type", "updatedAt"
      ) VALUES ($1, 'org_devfathom', 'sop.sweep', CURRENT_TIMESTAMP),
               ($2, $3, 'sop.sweep', CURRENT_TIMESTAMP)`,
      [jobA, jobB, organizationB]
    );
    await client.query(
      `INSERT INTO "restaurant_job_executions" (
        "id", "organizationId", "jobId", "workerId", "attempt", "startedAt", "finishedAt", "outcome"
      ) VALUES ($1, 'org_devfathom', $2, 'worker-a', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'SUCCEEDED'),
               ($3, $4, $5, 'worker-b', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'SUCCEEDED')`,
      [jobExecA, jobA, jobExecB, organizationB, jobB]
    );
    await client.query(
      `INSERT INTO "restaurant_webhook_inbox" (
        "id", "organizationId", "source", "externalEventId", "updatedAt"
      ) VALUES ($1, 'org_devfathom', 'stripe', $2, CURRENT_TIMESTAMP),
               ($3, $4, 'stripe', $5, CURRENT_TIMESTAMP)`,
      [webhookInboxA, `evt_a_${suffix}`, webhookInboxB, organizationB, `evt_b_${suffix}`]
    );
    await client.query(
      `INSERT INTO "restaurant_notifications" (
        "id", "organizationId", "recipientStaffProfileId", "category", "title", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, 'sop.due', 'SOP due', CURRENT_TIMESTAMP),
               ($3, $4, $5, 'sop.due', 'SOP due', CURRENT_TIMESTAMP)`,
      [notificationA, staffA1, notificationB, organizationB, staffB1]
    );
    await client.query(
      `INSERT INTO "restaurant_notification_deliveries" (
        "id", "organizationId", "notificationId", "channel", "status"
      ) VALUES ($1, 'org_devfathom', $2, 'IN_APP', 'DELIVERED_IN_APP'),
               ($3, $4, $5, 'IN_APP', 'DELIVERED_IN_APP')`,
      [notifDeliveryA, notificationA, notifDeliveryB, organizationB, notificationB]
    );

    // M8-L1: one mirrored row per customer/loyalty/insight table. Identifiers,
    // tags and idempotency keys deliberately reuse the same values across orgs:
    // dedupe is tenant-local, never a cross-tenant existence oracle.
    const customerA = `rcustomer_a_${suffix}`;
    const customerB = `rcustomer_b_${suffix}`;
    const customerIdentifierA = `rcustid_a_${suffix}`;
    const customerIdentifierB = `rcustid_b_${suffix}`;
    const customerInteractionA = `rcustix_a_${suffix}`;
    const customerInteractionB = `rcustix_b_${suffix}`;
    const customerTagA = `rcusttag_a_${suffix}`;
    const customerTagB = `rcusttag_b_${suffix}`;
    const customerTagAssignmentA = `rcustta_a_${suffix}`;
    const customerTagAssignmentB = `rcustta_b_${suffix}`;
    const customerConsentA = `rcustco_a_${suffix}`;
    const customerConsentB = `rcustco_b_${suffix}`;
    const loyaltyProgramA = `rloyalprog_a_${suffix}`;
    const loyaltyProgramB = `rloyalprog_b_${suffix}`;
    const loyaltyAccountA = `rloyalacct_a_${suffix}`;
    const loyaltyAccountB = `rloyalacct_b_${suffix}`;
    const loyaltyPointsA = `rloyalpts_a_${suffix}`;
    const loyaltyPointsB = `rloyalpts_b_${suffix}`;
    const insightDailyA = `rinsday_a_${suffix}`;
    const insightDailyB = `rinsday_b_${suffix}`;
    const insightLiabilityA = `rinsliab_a_${suffix}`;
    const insightLiabilityB = `rinsliab_b_${suffix}`;
    const insightItemA = `rinsitem_a_${suffix}`;
    const insightItemB = `rinsitem_b_${suffix}`;
    const labourFactA = `rlabour_a_${suffix}`;
    const labourFactB = `rlabour_b_${suffix}`;
    const sharedCustomerEmail = `shared-${suffix}@example.test`;
    const sharedInteractionKey = `interaction-${suffix}`;
    const sharedConsentKey = `consent-${suffix}`;
    const sharedPointsKey = `points-${suffix}`;
    const sharedLabourKey = `labour-${suffix}`;

    await client.query(
      `INSERT INTO "restaurant_customers" (
        "id", "organizationId", "displayName", "updatedAt"
      ) VALUES ($1, 'org_devfathom', 'Tenant A Customer', CURRENT_TIMESTAMP),
               ($2, $3, 'Tenant B Customer', CURRENT_TIMESTAMP)`,
      [customerA, customerB, organizationB]
    );
    await client.query(
      `INSERT INTO "restaurant_customer_identifiers" (
        "id", "organizationId", "customerId", "kind", "normalizedValue", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, 'EMAIL', $3, CURRENT_TIMESTAMP),
               ($4, $5, $6, 'EMAIL', $3, CURRENT_TIMESTAMP)`,
      [
        customerIdentifierA,
        customerA,
        sharedCustomerEmail,
        customerIdentifierB,
        organizationB,
        customerB,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_customer_interactions" (
        "id", "organizationId", "customerId", "branchId", "orderId", "type", "idempotencyKey"
      ) VALUES ($1, 'org_devfathom', $2, $3, $4, 'ORDER', $5),
               ($6, $7, $8, $9, $10, 'ORDER', $5)`,
      [
        customerInteractionA,
        customerA,
        branchA,
        orderA,
        sharedInteractionKey,
        customerInteractionB,
        organizationB,
        customerB,
        branchB,
        orderB,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_customer_tags" (
        "id", "organizationId", "name", "updatedAt"
      ) VALUES ($1, 'org_devfathom', 'Regular', CURRENT_TIMESTAMP),
               ($2, $3, 'Regular', CURRENT_TIMESTAMP)`,
      [customerTagA, customerTagB, organizationB]
    );
    await client.query(
      `INSERT INTO "restaurant_customer_tag_assignments" (
        "id", "organizationId", "customerId", "tagId"
      ) VALUES ($1, 'org_devfathom', $2, $3),
               ($4, $5, $6, $7)`,
      [
        customerTagAssignmentA,
        customerA,
        customerTagA,
        customerTagAssignmentB,
        organizationB,
        customerB,
        customerTagB,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_customer_consents" (
        "id", "organizationId", "customerId", "channel", "granted", "source",
        "actorId", "policyVersion", "idempotencyKey"
      ) VALUES ($1, 'org_devfathom', $2, 'EMAIL', true, 'customer', $3, 'v1', $4),
               ($5, $6, $7, 'EMAIL', true, 'customer', $8, 'v1', $4)`,
      [
        customerConsentA,
        customerA,
        userA,
        sharedConsentKey,
        customerConsentB,
        organizationB,
        customerB,
        userB,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_loyalty_program_versions" (
        "id", "organizationId", "versionNumber", "effectiveFrom", "earnRate",
        "redemptionValue", "updatedAt"
      ) VALUES ($1, 'org_devfathom', 1, CURRENT_TIMESTAMP - INTERVAL '1 minute', 1, 0.01, CURRENT_TIMESTAMP),
               ($2, $3, 1, CURRENT_TIMESTAMP - INTERVAL '1 minute', 1, 0.01, CURRENT_TIMESTAMP)`,
      [loyaltyProgramA, loyaltyProgramB, organizationB]
    );
    await client.query(
      `INSERT INTO "restaurant_loyalty_accounts" (
        "id", "organizationId", "customerId", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, CURRENT_TIMESTAMP),
               ($3, $4, $5, CURRENT_TIMESTAMP)`,
      [loyaltyAccountA, customerA, loyaltyAccountB, organizationB, customerB]
    );
    await client.query(
      `INSERT INTO "restaurant_loyalty_points_entries" (
        "id", "organizationId", "accountId", "programVersionId", "kind", "points",
        "billId", "idempotencyKey"
      ) VALUES ($1, 'org_devfathom', $2, $3, 'EARN', 10, $4, $5),
               ($6, $7, $8, $9, 'EARN', 10, $10, $5)`,
      [
        loyaltyPointsA,
        loyaltyAccountA,
        loyaltyProgramA,
        billA,
        sharedPointsKey,
        loyaltyPointsB,
        organizationB,
        loyaltyAccountB,
        loyaltyProgramB,
        billB,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_insight_daily_rollups" (
        "id", "organizationId", "branchId", "businessDate", "sourceDailyCloseId", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, DATE '2030-01-01', $3, CURRENT_TIMESTAMP),
               ($4, $5, $6, DATE '2030-01-01', $7, CURRENT_TIMESTAMP)`,
      [insightDailyA, branchA, dailyCloseA, insightDailyB, organizationB, branchB, dailyCloseB]
    );
    await client.query(
      `INSERT INTO "restaurant_insight_loyalty_liabilities" (
        "id", "organizationId", "businessDate", "cutoffAt", "programVersionId",
        "redemptionValue", "positivePoints", "signedPoints", "liability", "updatedAt"
      ) VALUES ($1, 'org_devfathom', DATE '2030-01-01', TIMESTAMPTZ '2030-01-02T00:00:00Z', $2, 0.01, 100, 80, 1, CURRENT_TIMESTAMP),
               ($3, $4, DATE '2030-01-01', TIMESTAMPTZ '2030-01-02T00:00:00Z', $5, 0.01, 200, 180, 2, CURRENT_TIMESTAMP)`,
      [insightLiabilityA, loyaltyProgramA, insightLiabilityB, organizationB, loyaltyProgramB]
    );
    await client.query(
      `INSERT INTO "restaurant_insight_item_mix_rollups" (
        "id", "organizationId", "branchId", "businessDate", "productId",
        "sourceDailyCloseId", "quantity", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, DATE '2030-01-01', $3, $4, 1, CURRENT_TIMESTAMP),
               ($5, $6, $7, DATE '2030-01-01', $8, $9, 1, CURRENT_TIMESTAMP)`,
      [
        insightItemA,
        branchA,
        productA,
        dailyCloseA,
        insightItemB,
        organizationB,
        branchB,
        productB,
        dailyCloseB,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_labour_cost_facts" (
        "id", "organizationId", "branchId", "businessDate", "labourHours",
        "labourCost", "source", "idempotencyKey"
      ) VALUES ($1, 'org_devfathom', $2, DATE '2030-01-01', 8, 100, 'import', $3),
               ($4, $5, $6, DATE '2030-01-01', 8, 100, 'import', $3)`,
      [labourFactA, branchA, sharedLabourKey, labourFactB, organizationB, branchB]
    );
    await client.query(
      `UPDATE "restaurant_orders" SET "customerId" = CASE "id" WHEN $1 THEN $2 WHEN $3 THEN $4 END
        WHERE "id" IN ($1, $3)`,
      [orderA, customerA, orderB, customerB]
    );

    // WHA-298 wallet (L2), print-bridge enrollment / printer registry, and the
    // pharmacy unidentified-return hold and pack-price tables (L1): the eleven
    // org-scoped tables the forced-RLS discovery above covers only by flag. One
    // mirrored row per tenant per table, hung off the restaurant parents seeded
    // above (customer, loyalty account, branch, registered device) and a minimal
    // pharmacy chain seeded here, so every read below distinguishes "isolated"
    // from "empty" and every denied insert references real org-B parents.
    const walletConfigA = `rwcfg_a_${suffix}`;
    const walletConfigB = `rwcfg_b_${suffix}`;
    const walletPassA = `rwpass_a_${suffix}`;
    const walletPassB = `rwpass_b_${suffix}`;
    const walletRegistrationA = `rwreg_a_${suffix}`;
    const walletRegistrationB = `rwreg_b_${suffix}`;
    const walletUpdateA = `rwupd_a_${suffix}`;
    const walletUpdateB = `rwupd_b_${suffix}`;
    const walletLinkA = `rwlink_a_${suffix}`;
    const walletLinkB = `rwlink_b_${suffix}`;
    const walletAttemptA = `rwatt_a_${suffix}`;
    const walletAttemptB = `rwatt_b_${suffix}`;
    const enrollmentCodeA = `rpbcode_a_${suffix}`;
    const enrollmentCodeB = `rpbcode_b_${suffix}`;
    const printerA = `rprinter_a_${suffix}`;
    const printerB = `rprinter_b_${suffix}`;
    const pharmacyBranchA = `phbranch_a_${suffix}`;
    const pharmacyBranchB = `phbranch_b_${suffix}`;
    const quarantineLocationA = `phloc_a_${suffix}`;
    const quarantineLocationB = `phloc_b_${suffix}`;
    const medicineA = `phmed_a_${suffix}`;
    const medicineB = `phmed_b_${suffix}`;
    const presentationA = `phpres_a_${suffix}`;
    const presentationB = `phpres_b_${suffix}`;
    const packLevelA = `phpack_a_${suffix}`;
    const packLevelB = `phpack_b_${suffix}`;
    const pharmacySaleA = `phsale_a_${suffix}`;
    const pharmacySaleB = `phsale_b_${suffix}`;
    const saleLineA = `phline_a_${suffix}`;
    const saleLineB = `phline_b_${suffix}`;
    const saleReturnA = `phret_a_${suffix}`;
    const saleReturnB = `phret_b_${suffix}`;
    // A hold is unique per return and a verification task unique per hold, so
    // org B gets two spare returns: one carries the hold the denied task insert
    // targets, the other is left free for the denied hold insert itself.
    const saleReturnB2 = `phret_b2_${suffix}`;
    const saleReturnB3 = `phret_b3_${suffix}`;
    const returnHoldA = `phhold_a_${suffix}`;
    const returnHoldB = `phhold_b_${suffix}`;
    const returnHoldB2 = `phhold_b2_${suffix}`;
    const returnTaskA = `phtask_a_${suffix}`;
    const returnTaskB = `phtask_b_${suffix}`;
    const packPriceA = `phprice_a_${suffix}`;
    const packPriceB = `phprice_b_${suffix}`;

    // Seeded after the loyalty points entries above on purpose: their AFTER
    // INSERT trigger enqueues a PENDING wallet update for every ACTIVE pass of
    // the account, which would collide with the explicit PENDING row below.
    await client.query(
      `INSERT INTO "restaurant_wallet_tenant_config" (
        "id", "organizationId", "programDisplayName", "googleClassSuffix", "updatedAt"
      ) VALUES ($1, 'org_devfathom', 'Tenant A Rewards', $2, CURRENT_TIMESTAMP),
               ($3, $4, 'Tenant B Rewards', $5, CURRENT_TIMESTAMP)`,
      [walletConfigA, `class-a-${suffix}`, walletConfigB, organizationB, `class-b-${suffix}`]
    );
    await client.query(
      `INSERT INTO "restaurant_wallet_passes" (
        "id", "organizationId", "customerId", "loyaltyAccountId", "platform", "serialNumber", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, 'APPLE', $4, CURRENT_TIMESTAMP),
               ($5, $6, $7, $8, 'APPLE', $9, CURRENT_TIMESTAMP)`,
      [
        walletPassA,
        customerA,
        loyaltyAccountA,
        `serial-a-${suffix}`,
        walletPassB,
        organizationB,
        customerB,
        loyaltyAccountB,
        `serial-b-${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_wallet_pass_registrations" (
        "id", "organizationId", "passId", "deviceLibraryIdentifier", "pushToken", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, $4, CURRENT_TIMESTAMP),
               ($5, $6, $7, $8, $9, CURRENT_TIMESTAMP)`,
      [
        walletRegistrationA,
        walletPassA,
        `device-library-a-${suffix}`,
        `push-token-a-${suffix}`,
        walletRegistrationB,
        organizationB,
        walletPassB,
        `device-library-b-${suffix}`,
        `push-token-b-${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_wallet_pass_updates" (
        "id", "organizationId", "passId", "reason", "status", "nextAttemptAt", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, 'LEDGER', 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
               ($3, $4, $5, 'LEDGER', 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [walletUpdateA, walletPassA, walletUpdateB, organizationB, walletPassB]
    );
    await client.query(
      `INSERT INTO "restaurant_wallet_enrollment_links" (
        "id", "organizationId", "branchId", "tokenHash"
      ) VALUES ($1, 'org_devfathom', $2, $3),
               ($4, $5, $6, $7)`,
      [
        walletLinkA,
        branchA,
        `wallet-link-a-${suffix}`,
        walletLinkB,
        organizationB,
        branchB,
        `wallet-link-b-${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_wallet_enrollment_attempts" (
        "id", "organizationId", "branchId", "identifierKind", "normalizedValue", "otpHash", "expiresAt"
      ) VALUES ($1, 'org_devfathom', $2, 'PHONE', '+15550000101', $3, CURRENT_TIMESTAMP + interval '10 minutes'),
               ($4, $5, $6, 'PHONE', '+15550000102', $7, CURRENT_TIMESTAMP + interval '10 minutes')`,
      [
        walletAttemptA,
        branchA,
        `otp-hash-a-${suffix}`,
        walletAttemptB,
        organizationB,
        branchB,
        `otp-hash-b-${suffix}`,
      ]
    );

    // Print bridge enrollment codes hang off a registered device; a printer off
    // a branch and a bridge device registered on that same branch.
    await client.query(
      `INSERT INTO "restaurant_print_bridge_enrollment_codes" (
        "id", "organizationId", "deviceId", "codeHash", "issuedDeviceSecretHash", "expiresAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, $4, CURRENT_TIMESTAMP + interval '10 minutes'),
               ($5, $6, $7, $8, $9, CURRENT_TIMESTAMP + interval '10 minutes')`,
      [
        enrollmentCodeA,
        deviceA,
        `bridge-code-a-${suffix}`,
        `bridge-secret-a-${suffix}`,
        enrollmentCodeB,
        organizationB,
        deviceB,
        `bridge-code-b-${suffix}`,
        `bridge-secret-b-${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO "restaurant_printers" (
        "id", "organizationId", "branchId", "bridgeId", "name", "connectionKind", "address", "paperWidthMm", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, 'Tenant A Printer', 'TCP', '10.0.0.1:9100', 80, CURRENT_TIMESTAMP),
               ($4, $5, $6, $7, 'Tenant B Printer', 'TCP', '10.0.0.2:9100', 80, CURRENT_TIMESTAMP)`,
      [printerA, branchA, deviceA, printerB, organizationB, branchB, deviceB]
    );

    // Pharmacy L1 chain: branch -> quarantine location, medicine -> presentation
    // -> pack level, branch -> sale -> sale line, sale -> return(s). The hold's
    // BEFORE INSERT guards need an active QUARANTINE location, a return whose
    // original sale owns the sale line, and sold >= returned + held units; both
    // pass here because the superuser seeding sees every parent.
    await client.query(
      `INSERT INTO "pharmacy_branches" (
        "id", "organizationId", "code", "name", "addressLine", "city", "provinceCode", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, 'Tenant A Pharmacy', '1 Isolation St', 'Lahore', 'PB', CURRENT_TIMESTAMP),
               ($3, $4, $5, 'Tenant B Pharmacy', '2 Isolation St', 'Lahore', 'PB', CURRENT_TIMESTAMP)`,
      [pharmacyBranchA, `rls-a-${suffix}`, pharmacyBranchB, organizationB, `rls-b-${suffix}`]
    );
    await client.query(
      `INSERT INTO "pharmacy_stock_locations" (
        "id", "organizationId", "branchId", "code", "name", "kind", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, 'QUARANTINE', 'Quarantine', 'QUARANTINE', CURRENT_TIMESTAMP),
               ($3, $4, $5, 'QUARANTINE', 'Quarantine', 'QUARANTINE', CURRENT_TIMESTAMP)`,
      [quarantineLocationA, pharmacyBranchA, quarantineLocationB, organizationB, pharmacyBranchB]
    );
    await client.query(
      `INSERT INTO "pharmacy_medicines" (
        "id", "organizationId", "productName", "productFamily", "updatedAt"
      ) VALUES ($1, 'org_devfathom', 'Tenant A Medicine', 'PHARMACEUTICAL', CURRENT_TIMESTAMP),
               ($2, $3, 'Tenant B Medicine', 'PHARMACEUTICAL', CURRENT_TIMESTAMP)`,
      [medicineA, medicineB, organizationB]
    );
    await client.query(
      `INSERT INTO "pharmacy_presentations" (
        "id", "organizationId", "medicineId", "presentation", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, 'Tablet', CURRENT_TIMESTAMP),
               ($3, $4, $5, 'Tablet', CURRENT_TIMESTAMP)`,
      [presentationA, medicineA, presentationB, organizationB, medicineB]
    );
    await client.query(
      `INSERT INTO "pharmacy_pack_levels" (
        "id", "organizationId", "presentationId", "versionGroupId", "version", "level", "unitsPerParent", "effectiveFrom"
      ) VALUES ($1, 'org_devfathom', $2, $3, 1, 'CARTON', 1, CURRENT_TIMESTAMP - interval '1 day'),
               ($4, $5, $6, $7, 1, 'CARTON', 1, CURRENT_TIMESTAMP - interval '1 day')`,
      [
        packLevelA,
        presentationA,
        `pack-group-a-${suffix}`,
        packLevelB,
        organizationB,
        presentationB,
        `pack-group-b-${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO "pharmacy_sales" (
        "id", "organizationId", "branchId", "createdByUserId", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, CURRENT_TIMESTAMP),
               ($4, $5, $6, $7, CURRENT_TIMESTAMP)`,
      [pharmacySaleA, pharmacyBranchA, userA, pharmacySaleB, organizationB, pharmacyBranchB, userB]
    );
    await client.query(
      `INSERT INTO "pharmacy_sale_lines" (
        "id", "organizationId", "branchId", "saleId", "medicineId", "presentationId", "packLevelId",
        "saleUnit", "quantity", "canonicalUnitsPerSaleUnit", "canonicalUnits",
        "unitPriceMinor", "grossMinor", "proRataCeilingMinor", "unitCostMinor", "idempotencyKey"
      ) VALUES ($1, 'org_devfathom', $2, $3, $4, $5, $6, 'PACK', 10, 1, 10, 100, 1000, 100, 50, $7),
               ($8, $9, $10, $11, $12, $13, $14, 'PACK', 10, 1, 10, 100, 1000, 100, 50, $15)`,
      [
        saleLineA,
        pharmacyBranchA,
        pharmacySaleA,
        medicineA,
        presentationA,
        packLevelA,
        `sale-line-a-${suffix}`,
        saleLineB,
        organizationB,
        pharmacyBranchB,
        pharmacySaleB,
        medicineB,
        presentationB,
        packLevelB,
        `sale-line-b-${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO "pharmacy_sale_returns" (
        "id", "organizationId", "branchId", "originalSaleId", "actorId", "reason"
      ) VALUES ($1, 'org_devfathom', $2, $3, $4, 'Tenant A return'),
               ($5, $6, $7, $8, $9, 'Tenant B return'),
               ($10, $6, $7, $8, $9, 'Tenant B return 2'),
               ($11, $6, $7, $8, $9, 'Tenant B return 3')`,
      [
        saleReturnA,
        pharmacyBranchA,
        pharmacySaleA,
        userA,
        saleReturnB,
        organizationB,
        pharmacyBranchB,
        pharmacySaleB,
        userB,
        saleReturnB2,
        saleReturnB3,
      ]
    );
    await client.query(
      `INSERT INTO "pharmacy_unidentified_return_holds" (
        "id", "organizationId", "branchId", "returnId", "saleLineId", "quarantineLocationId",
        "canonicalUnits", "integrityDecision", "actorId"
      ) VALUES ($1, 'org_devfathom', $2, $3, $4, $5, 1, 'intact', $6),
               ($7, $8, $9, $10, $11, $12, 1, 'intact', $13),
               ($14, $8, $9, $15, $11, $12, 1, 'intact', $13)`,
      [
        returnHoldA,
        pharmacyBranchA,
        saleReturnA,
        saleLineA,
        quarantineLocationA,
        userA,
        returnHoldB,
        organizationB,
        pharmacyBranchB,
        saleReturnB,
        saleLineB,
        quarantineLocationB,
        userB,
        returnHoldB2,
        saleReturnB2,
      ]
    );
    await client.query(
      `INSERT INTO "pharmacy_return_verification_tasks" (
        "id", "organizationId", "branchId", "holdingId", "requestedByUserId"
      ) VALUES ($1, 'org_devfathom', $2, $3, $4),
               ($5, $6, $7, $8, $9)`,
      [
        returnTaskA,
        pharmacyBranchA,
        returnHoldA,
        userA,
        returnTaskB,
        organizationB,
        pharmacyBranchB,
        returnHoldB,
        userB,
      ]
    );
    await client.query(
      `INSERT INTO "pharmacy_pack_prices" (
        "id", "organizationId", "presentationId", "packLevelId", "mrpMinor", "effectiveFrom", "source", "createdById"
      ) VALUES ($1, 'org_devfathom', $2, $3, 1000, TIMESTAMP '2030-01-01', 'manual', $4),
               ($5, $6, $7, $8, 1000, TIMESTAMP '2030-01-01', 'manual', $9)`,
      [
        packPriceA,
        presentationA,
        packLevelA,
        userA,
        packPriceB,
        organizationB,
        presentationB,
        packLevelB,
        userB,
      ]
    );

    // H1 — the hospitality foundation: the property (in hospitality the branch IS
    // the property), the explicit per-property assignment that makes it reachable
    // under the RESTRICTIVE `hotel_properties_assigned_user` policy, and the
    // extras catalog hanging off it. One mirrored row per table in each tenant,
    // plus a second tenant-A assignment held by a colleague, so the assignment
    // write policies can be told apart from the read policy below. The Owner
    // role rows only satisfy the assignment's composite role key; which keys
    // resolve a tRPC scope is the resolver's rule, not a SQL one.
    const hotelRoleA = `hotel_role_a_${suffix}`;
    const hotelRoleB = `hotel_role_b_${suffix}`;
    const hotelPropertyA = `hotel_property_a_${suffix}`;
    // A second tenant-A property that user A holds no assignment at: it is what
    // makes a blind write on `hotel_properties` tell the RESTRICTIVE policy
    // apart from the tenant one (both reach one row when the tenant owns one).
    const hotelPropertyA2 = `hotel_property_a2_${suffix}`;
    const hotelPropertyB = `hotel_property_b_${suffix}`;
    const hotelAssignmentA = `hotel_assignment_a_${suffix}`;
    const hotelAssignmentA2 = `hotel_assignment_a2_${suffix}`;
    const hotelAssignmentA3 = `hotel_assignment_a3_${suffix}`;
    const hotelAssignmentB = `hotel_assignment_b_${suffix}`;
    const hotelExtraA = `hotel_extra_a_${suffix}`;
    const hotelExtraB = `hotel_extra_b_${suffix}`;
    await client.query(
      `INSERT INTO "organization_roles" (
        "id", "organizationId", "key", "name", "isSystem", "createdAt", "updatedAt"
      ) VALUES ($1, 'org_devfathom', 'owner', 'Owner', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
               ($2, $3, 'owner', 'Owner', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [hotelRoleA, hotelRoleB, organizationB]
    );
    await client.query(
      `INSERT INTO "hotel_properties" (
        "branchId", "organizationId", "name", "addressLine", "city", "timezone", "bookingEngineSlug", "updatedAt"
      ) VALUES ($1, 'org_devfathom', 'Tenant A Property', '1 Isolation St', 'Lahore', 'Asia/Karachi', $2, CURRENT_TIMESTAMP),
               ($3, 'org_devfathom', 'Tenant A Second Property', '1b Isolation St', 'Lahore', 'Asia/Karachi', $4, CURRENT_TIMESTAMP),
               ($5, $6, 'Tenant B Property', '2 Isolation St', 'Lahore', 'Asia/Karachi', $7, CURRENT_TIMESTAMP)`,
      [
        hotelPropertyA,
        `hotel-a-${suffix}`,
        hotelPropertyA2,
        `hotel-a2-${suffix}`,
        hotelPropertyB,
        organizationB,
        `hotel-b-${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO "hotel_property_assignments" (
        "id", "organizationId", "branchId", "userId", "organizationRoleId", "active", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, $4, true, CURRENT_TIMESTAMP),
               ($5, 'org_devfathom', $2, $6, $4, true, CURRENT_TIMESTAMP),
               ($7, 'org_devfathom', $8, $6, $4, true, CURRENT_TIMESTAMP),
               ($9, $10, $11, $12, $13, true, CURRENT_TIMESTAMP)`,
      [
        hotelAssignmentA,
        hotelPropertyA,
        userA,
        hotelRoleA,
        hotelAssignmentA2,
        colleagueA,
        hotelAssignmentA3,
        hotelPropertyA2,
        hotelAssignmentB,
        organizationB,
        hotelPropertyB,
        userB,
        hotelRoleB,
      ]
    );
    await client.query(
      `INSERT INTO "hotel_extras" (
        "id", "organizationId", "branchId", "code", "name", "priceMinor", "taxClass", "department", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, 'LAUNDRY', 'Laundry', 1000, 'SERVICES', 'LAUNDRY', CURRENT_TIMESTAMP),
               ($3, $4, $5, 'LAUNDRY', 'Laundry', 1000, 'SERVICES', 'LAUNDRY', CURRENT_TIMESTAMP)`,
      [hotelExtraA, hotelPropertyA, hotelExtraB, organizationB, hotelPropertyB]
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
      // M2-L1: explicit read/update/delete isolation for the five new tables.
      ['restaurant_staff_profiles', staffA1, staffB1],
      ['restaurant_registered_devices', deviceA, deviceB],
      ['restaurant_operator_credentials', credentialA, credentialB],
      ['restaurant_terminal_sessions', sessionA, sessionB],
      ['restaurant_co_authorizations', coAuthA, coAuthB],
      // M3-L1: explicit read/update/delete isolation for representative catalog,
      // recipe, pricing, publication and override rows (beyond auto-discovery).
      ['restaurant_products', productA, productB],
      ['restaurant_recipe_versions', recipeVersionA, recipeVersionB],
      ['restaurant_price_list_entries', priceEntryA, priceEntryB],
      ['restaurant_branch_menu_publications', publicationA, publicationB],
      ['restaurant_branch_menu_item_overrides', itemOverrideA, itemOverrideB],
      // M4-L1: explicit read/update/delete isolation for the representative
      // order, item, event, kitchen ticket, floor table, section assignment,
      // outbox, and idempotency-key rows.
      ['restaurant_orders', orderA, orderB],
      ['restaurant_order_items', orderItemA, orderItemB],
      ['restaurant_order_events', orderEventA, orderEventB],
      ['restaurant_kitchen_tickets', ticketA, ticketB],
      ['restaurant_tables', tableA, tableB],
      ['restaurant_server_section_assignments', sectionAssignmentA, sectionAssignmentB],
      ['restaurant_event_outbox', outboxA, outboxB],
      ['restaurant_order_idempotency_keys', idempotencyA, idempotencyB],
      // M5-L1: explicit read/update/delete isolation for the representative bill,
      // bill line, payment, payment event, tender, refund, drawer session, drawer
      // movement, daily close, close tender total, receipt sequence, and money
      // idempotency-key rows. (Cross-tenant update/delete is denied here; the
      // append-only ledgers among these also deny mutation on the OWNER's row —
      // asserted separately below.)
      ['restaurant_bills', billA, billB],
      ['restaurant_bill_lines', billLineA, billLineB],
      ['restaurant_payments', paymentA, paymentB],
      ['restaurant_payment_events', paymentEventA, paymentEventB],
      ['restaurant_tenders', tenderA, tenderB],
      ['restaurant_refunds', refundA, refundB],
      ['restaurant_drawer_sessions', drawerSessionA, drawerSessionB],
      ['restaurant_drawer_movements', drawerMovementA, drawerMovementB],
      ['restaurant_daily_closes', dailyCloseA, dailyCloseB],
      ['restaurant_daily_close_tender_totals', closeTenderTotalA, closeTenderTotalB],
      ['restaurant_receipt_number_sequences', receiptSeqA, receiptSeqB],
      ['restaurant_money_idempotency_keys', moneyIdemA, moneyIdemB],
      // M7-L1: explicit read/update/delete isolation for the representative job,
      // append-only execution, webhook-inbox envelope, notification, and append-
      // only delivery rows. (Cross-tenant update/delete is denied here; the
      // append-only ledgers among these also deny mutation on the OWNER's row —
      // asserted separately below.)
      ['restaurant_jobs', jobA, jobB],
      ['restaurant_job_executions', jobExecA, jobExecB],
      ['restaurant_webhook_inbox', webhookInboxA, webhookInboxB],
      ['restaurant_notifications', notificationA, notificationB],
      ['restaurant_notification_deliveries', notifDeliveryA, notifDeliveryB],
      // M8-L1: every customer, loyalty, insight and labour table is explicitly
      // probed in addition to the generic forced-RLS discovery above.
      ['restaurant_customers', customerA, customerB],
      ['restaurant_customer_identifiers', customerIdentifierA, customerIdentifierB],
      ['restaurant_customer_interactions', customerInteractionA, customerInteractionB],
      ['restaurant_customer_tags', customerTagA, customerTagB],
      ['restaurant_customer_tag_assignments', customerTagAssignmentA, customerTagAssignmentB],
      ['restaurant_customer_consents', customerConsentA, customerConsentB],
      ['restaurant_loyalty_program_versions', loyaltyProgramA, loyaltyProgramB],
      ['restaurant_loyalty_accounts', loyaltyAccountA, loyaltyAccountB],
      ['restaurant_loyalty_points_entries', loyaltyPointsA, loyaltyPointsB],
      ['restaurant_insight_daily_rollups', insightDailyA, insightDailyB],
      ['restaurant_insight_loyalty_liabilities', insightLiabilityA, insightLiabilityB],
      ['restaurant_insight_item_mix_rollups', insightItemA, insightItemB],
      ['restaurant_labour_cost_facts', labourFactA, labourFactB],
      // Wallet (L2), print bridge / printer registry, and pharmacy return-hold
      // and pack-price (L1) tables: explicit read/update/delete isolation for
      // the eleven tables that were covered only by the forced-RLS flag check.
      // The cross-tenant UPDATE/DELETE below matches zero rows under the
      // policy's USING clause, so the append-only and no-delete triggers on the
      // three pharmacy tables never fire here; their owner-row denial is
      // asserted separately below.
      ['restaurant_wallet_tenant_config', walletConfigA, walletConfigB],
      ['restaurant_wallet_passes', walletPassA, walletPassB],
      ['restaurant_wallet_pass_registrations', walletRegistrationA, walletRegistrationB],
      ['restaurant_wallet_pass_updates', walletUpdateA, walletUpdateB],
      ['restaurant_wallet_enrollment_links', walletLinkA, walletLinkB],
      ['restaurant_wallet_enrollment_attempts', walletAttemptA, walletAttemptB],
      ['restaurant_print_bridge_enrollment_codes', enrollmentCodeA, enrollmentCodeB],
      ['restaurant_printers', printerA, printerB],
      ['pharmacy_unidentified_return_holds', returnHoldA, returnHoldB],
      ['pharmacy_return_verification_tasks', returnTaskA, returnTaskB],
      ['pharmacy_pack_prices', packPriceA, packPriceB],
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

    // Blind UPDATE/DELETE on the eleven newer tables: the shape a tenant-scoped
    // bulk statement takes, and the one a permissive per-command policy (this
    // schema adds FOR DELETE policies for the demo reset) would leak through
    // while the WHERE-based probes above still pass. The two return-hold tables
    // deny UPDATE and DELETE to every role by trigger, and pack prices deny
    // DELETE the same way (all pinned below), so those commands are left out
    // where no policy could make a difference.
    const blindWrites: Array<[table: string, updateSet: string, deletable: boolean]> = [
      ['restaurant_wallet_tenant_config', '"updatedAt" = CURRENT_TIMESTAMP', true],
      ['restaurant_wallet_passes', '"updatedAt" = CURRENT_TIMESTAMP', true],
      ['restaurant_wallet_pass_registrations', '"updatedAt" = CURRENT_TIMESTAMP', true],
      ['restaurant_wallet_pass_updates', '"updatedAt" = CURRENT_TIMESTAMP', true],
      ['restaurant_wallet_enrollment_links', '"revokedAt" = NULL', true],
      ['restaurant_wallet_enrollment_attempts', '"failedAttempts" = 0', true],
      ['restaurant_print_bridge_enrollment_codes', '"usedAt" = NULL', true],
      ['restaurant_printers', '"updatedAt" = CURRENT_TIMESTAMP', true],
      ['pharmacy_pack_prices', '"sellingPriceMinor" = NULL', false],
    ];
    for (const [table, updateSet, deletable] of blindWrites) {
      await expectBlindWriteScoped(table, `UPDATE "${table}" SET ${updateSet}`);
      if (deletable) {
        await expectBlindWriteScoped(table, `DELETE FROM "${table}"`);
      }
    }

    // M5-L1 / C3: the six append-only ledgers are DB-enforced append-only — with
    // forced RLS and SELECT+INSERT policies (plus the guarded refund reversal-link
    // UPDATE), the unprivileged app role cannot mutate or delete ANY row, not even its OWN.
    // (Read isolation for these tables is covered by the loop above; here we prove
    // the mutation denial on tenant A's own rows — updates either match zero rows or
    // fail through the guarded refund trigger.
    // A correction is observable only as a NEW record referencing the original.)
    for (const [table, ownId] of [
      ['restaurant_tenders', tenderA],
      ['restaurant_payment_events', paymentEventA],
      ['restaurant_refunds', refundA],
      ['restaurant_drawer_movements', drawerMovementA],
      ['restaurant_daily_closes', dailyCloseA],
      ['restaurant_daily_close_tender_totals', closeTenderTotalA],
      // M7-L1: two of the five append-only ledgers proved end-to-end here (the
      // job-attempt execution history and notification-delivery records); the
      // other three (SOP evidence, verifications, escalation events) have their
      // SELECT+INSERT-only policy shape pinned by restaurant-m5-governance.
      ['restaurant_job_executions', jobExecA],
      ['restaurant_notification_deliveries', notifDeliveryA],
      ['restaurant_customer_interactions', customerInteractionA],
      ['restaurant_customer_consents', customerConsentA],
      ['restaurant_loyalty_points_entries', loyaltyPointsA],
      ['restaurant_labour_cost_facts', labourFactA],
    ] as const) {
      const visible = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "${table}" WHERE "id" = $1`,
        [ownId]
      );
      assertEqual(
        visible.rows[0]?.count,
        1,
        `tenant A must see its own append-only "${table}" row`
      );
      const updateOwnRow = () =>
        client.query(`UPDATE "${table}" SET "createdAt" = "createdAt" WHERE "id" = $1`, [ownId]);
      if (table === 'restaurant_refunds') {
        await expectDatabaseError('55000', updateOwnRow);
      } else {
        const updated = await updateOwnRow();
        assertEqual(
          updated.rowCount,
          0,
          `append-only "${table}" must deny UPDATE even on the owner's own row`
        );
      }
      const deleted = await client.query(`DELETE FROM "${table}" WHERE "id" = $1`, [ownId]);
      assertEqual(
        deleted.rowCount,
        0,
        `append-only "${table}" must deny DELETE even on the owner's own row`
      );
    }

    // L1: the two return-hold tables are append-only and pack prices are never
    // hard-deleted for every role, the owner included — enforced by BEFORE
    // triggers (pharmacy_rx_append_only, pharmacy_reject_delete) rather than by
    // a SELECT+INSERT-only policy, so the owner's own row raises 23514 instead
    // of matching zero rows. (A pack price's own row stays updatable.)
    for (const [table, ownId] of [
      ['pharmacy_unidentified_return_holds', returnHoldA],
      ['pharmacy_return_verification_tasks', returnTaskA],
    ] as const) {
      await expectDatabaseError(
        '23514',
        () =>
          client.query(
            `UPDATE "${table}" SET "organizationId" = "organizationId" WHERE "id" = $1`,
            [ownId]
          ),
        `owner UPDATE on append-only "${table}"`
      );
      await expectDatabaseError(
        '23514',
        () => client.query(`DELETE FROM "${table}" WHERE "id" = $1`, [ownId]),
        `owner DELETE on append-only "${table}"`
      );
    }
    await expectDatabaseError(
      '23514',
      () => client.query(`DELETE FROM "pharmacy_pack_prices" WHERE "id" = $1`, [packPriceA]),
      'owner DELETE on "pharmacy_pack_prices"'
    );

    // H1 — the hospitality foundation tables. `hotel_properties` is keyed by
    // "branchId" and carries a RESTRICTIVE policy on top of the tenant one (a
    // row is reachable only by an acting user holding an active assignment at
    // that property), and `hotel_property_assignments` has per-command
    // policies that read the acting user too — so neither fits the generic
    // "id" loop above, and every probe here names the acting user explicitly.
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userA]);
    const assignedProperties = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "hotel_properties" WHERE "branchId" IN ($1, $2)`,
      [hotelPropertyA, hotelPropertyB]
    );
    assertEqual(
      assignedProperties.rows[0]?.count,
      1,
      'an assigned member must see exactly their own tenant property'
    );
    const propertyUpdatedAcross = await client.query(
      `UPDATE "hotel_properties" SET "organizationId" = "organizationId" WHERE "branchId" = $1`,
      [hotelPropertyB]
    );
    assertEqual(
      propertyUpdatedAcross.rowCount,
      0,
      'tenant A must not update tenant B\'s "hotel_properties" row'
    );
    const propertyDeletedAcross = await client.query(
      `DELETE FROM "hotel_properties" WHERE "branchId" = $1`,
      [hotelPropertyB]
    );
    assertEqual(
      propertyDeletedAcross.rowCount,
      0,
      'tenant A must not delete tenant B\'s "hotel_properties" row'
    );
    for (const [table, idA, idB] of [
      ['hotel_property_assignments', hotelAssignmentA, hotelAssignmentB],
      ['hotel_extras', hotelExtraA, hotelExtraB],
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
    // Blind writes on the property and the catalog reach exactly the rows the
    // acting user can see — the RESTRICTIVE policy filters UPDATE and DELETE as
    // it filters SELECT. The organization holds two properties here and user A
    // is assigned at one, so a policy that stopped covering DELETE would show
    // as a second row reached. The inventory, meal plans and function spaces
    // are seeded later, after this probe: a property with RESTRICT children
    // cannot be deleted from any scope, which would make this probe vacuous.
    const tenantAProperties = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "hotel_properties"`
    );
    assertEqual(
      tenantAProperties.rows[0]?.count,
      1,
      'user A must see one of the two tenant-A properties before the blind write probes'
    );
    await expectBlindWriteScoped(
      'hotel_properties',
      `UPDATE "hotel_properties" SET "updatedAt" = CURRENT_TIMESTAMP`
    );
    await expectBlindWriteScoped('hotel_properties', `DELETE FROM "hotel_properties"`);
    await expectBlindWriteScoped(
      'hotel_extras',
      `UPDATE "hotel_extras" SET "updatedAt" = CURRENT_TIMESTAMP`
    );
    await expectBlindWriteScoped('hotel_extras', `DELETE FROM "hotel_extras"`);
    // Assignments: a manager at the property may retarget a colleague's row,
    // never their own, and nobody deletes one — revocation is a flag.
    const ownAssignmentUpdated = await client.query(
      `UPDATE "hotel_property_assignments" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [hotelAssignmentA]
    );
    assertEqual(
      ownAssignmentUpdated.rowCount,
      0,
      'a member must not change their own "hotel_property_assignments" row'
    );
    const colleagueAssignmentUpdated = await client.query(
      `UPDATE "hotel_property_assignments" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [hotelAssignmentA2]
    );
    assertEqual(
      colleagueAssignmentUpdated.rowCount,
      1,
      'an assigned manager must be able to change a colleague\'s "hotel_property_assignments" row'
    );
    const assignmentDeleted = await client.query(
      `DELETE FROM "hotel_property_assignments" WHERE "id" IN ($1, $2)`,
      [hotelAssignmentA, hotelAssignmentA2]
    );
    assertEqual(
      assignmentDeleted.rowCount,
      0,
      'no tenant scope may delete a "hotel_property_assignments" row'
    );
    // No self-grant: the acting user cannot write an assignment naming themself,
    // even at a property they already hold. Granting a colleague at that
    // property is what the policy admits (rolled back with the savepoint), so
    // the refusals around it are not vacuous.
    await expectDatabaseError(
      '42501',
      () =>
        client.query(
          `INSERT INTO "hotel_property_assignments" (
            "id", "organizationId", "branchId", "userId", "organizationRoleId", "active", "updatedAt"
          ) VALUES ($1, 'org_devfathom', $2, $3, $4, true, CURRENT_TIMESTAMP)`,
          [`hotel_self_grant_${suffix}`, hotelPropertyA, userA, hotelRoleA]
        ),
      'a member granting themself a "hotel_property_assignments" row'
    );
    await client.query('SAVEPOINT hotel_grant');
    try {
      const granted = await client.query(
        `INSERT INTO "hotel_property_assignments" (
          "id", "organizationId", "branchId", "userId", "organizationRoleId", "active", "updatedAt"
        ) VALUES ($1, 'org_devfathom', $2, $3, $4, true, CURRENT_TIMESTAMP)`,
        [`hotel_grant_${suffix}`, hotelPropertyA, strangerA, hotelRoleA]
      );
      assertEqual(
        granted.rowCount,
        1,
        'an assigned manager must be able to grant a colleague at their own property'
      );
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT hotel_grant');
      await client.query('RELEASE SAVEPOINT hotel_grant');
    }
    // Cross-tenant and tenant-minted rows all fail closed. The own-organization
    // property insert is refused because the restrictive policy needs an
    // assignment that cannot exist before the row does: tenants never create
    // properties; the control plane does, in one transaction with the first
    // assignment.
    const hotelWriteDenied: Array<[table: string, sql: string, values: unknown[]]> = [
      [
        'hotel_properties (org B)',
        `INSERT INTO "hotel_properties" (
          "branchId", "organizationId", "name", "addressLine", "city", "timezone", "bookingEngineSlug", "updatedAt"
        ) VALUES ($1, $2, 'Escape Property', '3 Isolation St', 'Lahore', 'Asia/Karachi', $3, CURRENT_TIMESTAMP)`,
        [`hotel_property_escape_${suffix}`, organizationB, `hotel-escape-${suffix}`],
      ],
      [
        'hotel_properties (own organization, unassigned)',
        `INSERT INTO "hotel_properties" (
          "branchId", "organizationId", "name", "addressLine", "city", "timezone", "bookingEngineSlug", "updatedAt"
        ) VALUES ($1, 'org_devfathom', 'Minted Property', '4 Isolation St', 'Lahore', 'Asia/Karachi', $2, CURRENT_TIMESTAMP)`,
        [`hotel_property_minted_${suffix}`, `hotel-minted-${suffix}`],
      ],
      [
        'hotel_property_assignments (org B)',
        `INSERT INTO "hotel_property_assignments" (
          "id", "organizationId", "branchId", "userId", "organizationRoleId", "active", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, true, CURRENT_TIMESTAMP)`,
        [`hotel_assignment_escape_${suffix}`, organizationB, hotelPropertyB, userB, hotelRoleB],
      ],
      [
        'hotel_extras (org B)',
        `INSERT INTO "hotel_extras" (
          "id", "organizationId", "branchId", "code", "name", "priceMinor", "taxClass", "department", "updatedAt"
        ) VALUES ($1, $2, $3, 'ESCAPE', 'Escape', 1000, 'SERVICES', 'LAUNDRY', CURRENT_TIMESTAMP)`,
        [`hotel_extra_escape_${suffix}`, organizationB, hotelPropertyB],
      ],
    ];
    for (const [table, sql, values] of hotelWriteDenied) {
      await expectDatabaseError(
        '42501',
        () => client.query(sql, values),
        `tenant A inserting a ${table} row`
      );
    }
    // An unassigned member of the same organization reaches no property, and a
    // tenant transaction with no acting user reaches neither a property nor an
    // assignment; the catalog stays organization-scoped in both cases.
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [strangerA]);
    const strangerProperties = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "hotel_properties"`
    );
    assertEqual(
      strangerProperties.rows[0]?.count,
      0,
      'an unassigned member must see no "hotel_properties" row'
    );
    await client.query(`SELECT set_config('app.current_user_id', '', true)`);
    const anonymousProperties = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "hotel_properties"`
    );
    assertEqual(
      anonymousProperties.rows[0]?.count,
      0,
      'a tenant transaction without an acting user must see no "hotel_properties" row'
    );
    const anonymousAssignments = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "hotel_property_assignments"`
    );
    assertEqual(
      anonymousAssignments.rows[0]?.count,
      0,
      'a tenant transaction without an acting user must see no "hotel_property_assignments" row'
    );
    const anonymousExtras = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "hotel_extras" WHERE "id" IN ($1, $2)`,
      [hotelExtraA, hotelExtraB]
    );
    assertEqual(
      anonymousExtras.rows[0]?.count,
      1,
      'the extras catalog stays organization-scoped without an acting user'
    );
    // The control plane reaches both tenants' rows on every hotel table.
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    for (const [table, column, idA, idB] of [
      ['hotel_properties', 'branchId', hotelPropertyA, hotelPropertyB],
      ['hotel_property_assignments', 'id', hotelAssignmentA, hotelAssignmentB],
      ['hotel_extras', 'id', hotelExtraA, hotelExtraB],
    ] as const) {
      const both = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "${table}" WHERE "${column}" IN ($1, $2)`,
        [idA, idB]
      );
      assertEqual(both.rows[0]?.count, 2, `platform scope must read both tenants' "${table}" rows`);
    }
    // The control plane's own assignment writes — the first assignment of a
    // property's life and a retarget after manager loss — are admitted
    // (rolled back with the savepoint), with the organization named explicitly
    // because the column default is blank in a platform transaction.
    await client.query('SAVEPOINT hotel_platform_assignment');
    try {
      const bootstrapped = await client.query(
        `INSERT INTO "hotel_property_assignments" (
          "id", "organizationId", "branchId", "userId", "organizationRoleId", "active", "updatedAt"
        ) VALUES ($1, 'org_devfathom', $2, $3, $4, true, CURRENT_TIMESTAMP)`,
        [`hotel_platform_grant_${suffix}`, hotelPropertyA, strangerA, hotelRoleA]
      );
      assertEqual(bootstrapped.rowCount, 1, 'platform scope must be able to write an assignment');
      const retargeted = await client.query(
        `UPDATE "hotel_property_assignments" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [hotelAssignmentB]
      );
      assertEqual(retargeted.rowCount, 1, 'platform scope must be able to retarget an assignment');
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT hotel_platform_assignment');
      await client.query('RELEASE SAVEPOINT hotel_platform_assignment');
    }
    await client.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);

    // H1-03 — inventory: a BED room type, one room, one bed and a live block per
    // tenant, seeded as the superuser in a second block so the property probes
    // above ran before any RESTRICT child existed. The status triggers write
    // each row's first ledger line themselves (a direct insert is refused), and
    // they attribute it to the acting user and reason GUCs, so the seeding
    // names those too and clears them afterwards.
    await client.query('RESET ROLE');
    const hotelRoomTypeA = `hotel_room_type_a_${suffix}`;
    const hotelRoomTypeB = `hotel_room_type_b_${suffix}`;
    const hotelRoomA = `hotel_room_a_${suffix}`;
    const hotelRoomB = `hotel_room_b_${suffix}`;
    const hotelBedA = `hotel_bed_a_${suffix}`;
    const hotelBedB = `hotel_bed_b_${suffix}`;
    const hotelBlockA = `hotel_block_a_${suffix}`;
    const hotelBlockB = `hotel_block_b_${suffix}`;
    await client.query(
      `SELECT set_config('app.current_user_id', $1, true),
              set_config('app.hotel_inventory_reason', 'Isolation seed', true)`,
      [userA]
    );
    await client.query(
      `INSERT INTO "hotel_room_types" (
        "id", "organizationId", "branchId", "code", "name", "inventoryKind", "bedsPerRoom", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, 'DORM', 'Dormitory', 'BED', 2, CURRENT_TIMESTAMP),
               ($3, $4, $5, 'DORM', 'Dormitory', 'BED', 2, CURRENT_TIMESTAMP)`,
      [hotelRoomTypeA, hotelPropertyA, hotelRoomTypeB, organizationB, hotelPropertyB]
    );
    await client.query(
      `INSERT INTO "hotel_rooms" (
        "id", "organizationId", "branchId", "roomTypeId", "inventoryKind", "number", "statusChangedBy", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, 'BED', '101', $4, CURRENT_TIMESTAMP),
               ($5, $6, $7, $8, 'BED', '101', $9, CURRENT_TIMESTAMP)`,
      [
        hotelRoomA,
        hotelPropertyA,
        hotelRoomTypeA,
        userA,
        hotelRoomB,
        organizationB,
        hotelPropertyB,
        hotelRoomTypeB,
        userB,
      ]
    );
    await client.query(
      `INSERT INTO "hotel_beds" (
        "id", "organizationId", "branchId", "roomId", "label", "statusChangedBy", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, $3, '1', $4, CURRENT_TIMESTAMP),
               ($5, $6, $7, $8, '1', $9, CURRENT_TIMESTAMP)`,
      [
        hotelBedA,
        hotelPropertyA,
        hotelRoomA,
        userA,
        hotelBedB,
        organizationB,
        hotelPropertyB,
        hotelRoomB,
        userB,
      ]
    );
    const hotelLedger = await client.query<{ roomId: string; id: string }>(
      `SELECT "roomId", "id" FROM "hotel_room_status_events"
       WHERE "roomId" IN ($1, $2) AND "bedId" IS NULL`,
      [hotelRoomA, hotelRoomB]
    );
    assertEqual(hotelLedger.rows.length, 2, 'each seeded room must open its own ledger');
    const hotelEventA = hotelLedger.rows.find((row) => row.roomId === hotelRoomA)!.id;
    const hotelEventB = hotelLedger.rows.find((row) => row.roomId === hotelRoomB)!.id;
    await client.query(
      `INSERT INTO "hotel_room_blocks" (
        "id", "organizationId", "branchId", "roomId", "kind", "startDate", "endDate", "reason", "createdBy"
      ) VALUES ($1, 'org_devfathom', $2, $3, 'OUT_OF_ORDER', DATE '2030-01-10', DATE '2030-01-12', 'Isolation seed', $4),
               ($5, $6, $7, $8, 'OUT_OF_ORDER', DATE '2030-01-10', DATE '2030-01-12', 'Isolation seed', $9)`,
      [
        hotelBlockA,
        hotelPropertyA,
        hotelRoomA,
        userA,
        hotelBlockB,
        organizationB,
        hotelPropertyB,
        hotelRoomB,
        userB,
      ]
    );
    await client.query(
      `SELECT set_config('app.current_user_id', '', true),
              set_config('app.hotel_inventory_reason', '', true)`
    );
    // H1-07 — one meal plan per tenant, in the shape provisioning writes
    // (`hotel_meal_plan_meals_valid` validates the document on the way in).
    const hotelMealPlanA = `hotel_meal_plan_a_${suffix}`;
    const hotelMealPlanB = `hotel_meal_plan_b_${suffix}`;
    await client.query(
      `INSERT INTO "hotel_meal_plans" (
        "id", "organizationId", "branchId", "code", "name", "nameUr", "meals", "active", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, 'CP', 'Bed & breakfast', 'کمرہ اور ناشتہ', $3::jsonb, true, CURRENT_TIMESTAMP),
               ($4, $5, $6, 'CP', 'Bed & breakfast', 'کمرہ اور ناشتہ', $3::jsonb, true, CURRENT_TIMESTAMP)`,
      [
        hotelMealPlanA,
        hotelPropertyA,
        JSON.stringify([{ meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: true }]),
        hotelMealPlanB,
        organizationB,
        hotelPropertyB,
      ]
    );
    // H1-05 — one function space per tenant (30 minutes of setup, 15 of
    // teardown) and one booking of it, written in SQL as every booking is; the
    // BEFORE trigger fills the buffered range the exclusion constraint judges.
    const hotelSpaceA = `hotel_space_a_${suffix}`;
    const hotelSpaceB = `hotel_space_b_${suffix}`;
    await client.query(
      `INSERT INTO "hotel_function_spaces" (
        "id", "organizationId", "branchId", "name", "layouts", "setupMinutes", "teardownMinutes", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, 'Crystal Hall', $3::jsonb, 30, 15, CURRENT_TIMESTAMP),
               ($4, $5, $6, 'Crystal Hall', $3::jsonb, 30, 15, CURRENT_TIMESTAMP)`,
      [
        hotelSpaceA,
        hotelPropertyA,
        JSON.stringify([{ layout: 'Theatre', capacity: 300 }]),
        hotelSpaceB,
        organizationB,
        hotelPropertyB,
      ]
    );
    const hotelBookings = await client.query<{ id: string; organizationId: string }>(
      `INSERT INTO "hotel_space_bookings" (
        "organizationId", "branchId", "spaceId", "startsAt", "endsAt", "kind", "ref", "createdBy", "updatedAt"
      ) VALUES ('org_devfathom', $1, $2, TIMESTAMPTZ '2030-01-01 10:00:00+00', TIMESTAMPTZ '2030-01-01 11:00:00+00', 'FUNCTION', '{"label":"Isolation seed"}', $3, CURRENT_TIMESTAMP),
               ($4, $5, $6, TIMESTAMPTZ '2030-01-01 10:00:00+00', TIMESTAMPTZ '2030-01-01 11:00:00+00', 'FUNCTION', '{"label":"Isolation seed"}', $7, CURRENT_TIMESTAMP)
       RETURNING "id", "organizationId"`,
      [hotelPropertyA, hotelSpaceA, userA, organizationB, hotelPropertyB, hotelSpaceB, userB]
    );
    const hotelBookingA = hotelBookings.rows.find(
      (row) => row.organizationId === 'org_devfathom'
    )!.id;
    const hotelBookingB = hotelBookings.rows.find(
      (row) => row.organizationId === organizationB
    )!.id;
    // H1-14 — one guest-message draft per tenant, in the shape provisioning
    // writes (version 1, DRAFT, no approval facts).
    const hotelJourneyA = `hotel_journey_a_${suffix}`;
    const hotelJourneyB = `hotel_journey_b_${suffix}`;
    await client.query(
      `INSERT INTO "hotel_journey_templates" (
        "id", "organizationId", "branchId", "moment", "channel", "language", "body", "createdByUserId", "updatedAt"
      ) VALUES ($1, 'org_devfathom', $2, 'BOOKING_CONFIRMED', 'WHATSAPP', 'EN', 'Dear {{guest_name}}, your booking is confirmed.', $3, CURRENT_TIMESTAMP),
               ($4, $5, $6, 'BOOKING_CONFIRMED', 'WHATSAPP', 'EN', 'Dear {{guest_name}}, your booking is confirmed.', $7, CURRENT_TIMESTAMP)`,
      [hotelJourneyA, hotelPropertyA, userA, hotelJourneyB, organizationB, hotelPropertyB, userB]
    );
    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);

    // H1-03 — the five inventory tables, as the acting assigned user. Read,
    // UPDATE and DELETE isolation first; then the trigger rules that make the
    // ledger trustworthy under RLS; then the fail-closed inserts.
    await client.query(
      `SELECT set_config('app.current_user_id', $1, true),
              set_config('app.hotel_inventory_reason', 'Isolation probe', true)`,
      [userA]
    );
    const hotelInventoryRows: Array<[table: string, idA: string, idB: string]> = [
      ['hotel_room_types', hotelRoomTypeA, hotelRoomTypeB],
      ['hotel_rooms', hotelRoomA, hotelRoomB],
      ['hotel_beds', hotelBedA, hotelBedB],
      ['hotel_room_status_events', hotelEventA, hotelEventB],
      ['hotel_room_blocks', hotelBlockA, hotelBlockB],
    ];
    for (const [table, idA, idB] of hotelInventoryRows) {
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
    // A tenant status change under RLS writes its own attributed ledger line.
    const cleaned = await client.query(
      `UPDATE "hotel_rooms" SET "status" = 'VACANT_CLEAN' WHERE "id" = $1`,
      [hotelRoomA]
    );
    assertEqual(cleaned.rowCount, 1, 'tenant A must be able to change its own room status');
    const ledgerLine = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "hotel_room_status_events"
       WHERE "roomId" = $1 AND "bedId" IS NULL AND "fromStatus" = 'VACANT_DIRTY'
         AND "toStatus" = 'VACANT_CLEAN' AND "actorId" = $2 AND "reason" = 'Isolation probe'`,
      [hotelRoomA, userA]
    );
    assertEqual(
      ledgerLine.rows[0]?.count,
      1,
      'a status change must write one ledger line attributed to the acting user and reason'
    );
    // No reason, or a stay-owned target, and the change is refused by the guard.
    await client.query(`SELECT set_config('app.hotel_inventory_reason', '', true)`);
    await expectDatabaseError(
      '23514',
      () =>
        client.query(`UPDATE "hotel_rooms" SET "status" = 'INSPECTED' WHERE "id" = $1`, [
          hotelRoomA,
        ]),
      'a status change without a reason'
    );
    await client.query(`SELECT set_config('app.hotel_inventory_reason', 'Isolation probe', true)`);
    await expectDatabaseError(
      '23514',
      () =>
        client.query(`UPDATE "hotel_rooms" SET "status" = 'OCCUPIED' WHERE "id" = $1`, [
          hotelRoomA,
        ]),
      'a status change into the stay-owned OCCUPIED state'
    );
    // The ledger is append-only and trigger-owned for the owner's own rows too:
    // no update, no delete, and no direct insert in any tenant.
    await expectDatabaseError(
      '23514',
      () =>
        client.query(
          `UPDATE "hotel_room_status_events" SET "reason" = 'rewritten' WHERE "id" = $1`,
          [hotelEventA]
        ),
      'owner UPDATE on "hotel_room_status_events"'
    );
    await expectDatabaseError(
      '23514',
      () => client.query(`DELETE FROM "hotel_room_status_events" WHERE "id" = $1`, [hotelEventA]),
      'owner DELETE on "hotel_room_status_events"'
    );
    for (const [label, organizationId, branchId, roomId] of [
      ['own-organization', 'org_devfathom', hotelPropertyA, hotelRoomA],
      ['org-B', organizationB, hotelPropertyB, hotelRoomB],
    ] as const) {
      await expectDatabaseError(
        '23514',
        () =>
          client.query(
            `INSERT INTO "hotel_room_status_events" (
              "organizationId", "branchId", "roomId", "toStatus", "actorId", "reason"
            ) VALUES ($1, $2, $3, 'VACANT_CLEAN', $4, 'forged')`,
            [organizationId, branchId, roomId, userA]
          ),
        `a direct ${label} insert into "hotel_room_status_events"`
      );
    }
    // Blind UPDATEs reach exactly the visible rows. A block's only legal update
    // is its release, so that is the statement probed; nothing here is blind-
    // deletable from a tenant scope (RESTRICT children, the ledger's cascade, or
    // the trigger refusals pinned below), so DELETE is probed by its refusal.
    await expectBlindWriteScoped(
      'hotel_room_types',
      `UPDATE "hotel_room_types" SET "updatedAt" = CURRENT_TIMESTAMP`
    );
    await expectBlindWriteScoped(
      'hotel_rooms',
      `UPDATE "hotel_rooms" SET "updatedAt" = CURRENT_TIMESTAMP`
    );
    await expectBlindWriteScoped(
      'hotel_beds',
      `UPDATE "hotel_beds" SET "updatedAt" = CURRENT_TIMESTAMP`
    );
    await expectBlindWriteScoped(
      'hotel_room_blocks',
      `UPDATE "hotel_room_blocks" SET "releasedAt" = CURRENT_TIMESTAMP, "releasedBy" = 'probe', "releaseReason" = 'Isolation probe'`
    );
    await expectDatabaseError(
      '23514',
      () =>
        client.query(`UPDATE "hotel_room_blocks" SET "reason" = 'rewritten' WHERE "id" = $1`, [
          hotelBlockA,
        ]),
      'a non-release UPDATE on "hotel_room_blocks"'
    );
    await expectDatabaseError(
      '23514',
      () => client.query(`DELETE FROM "hotel_room_blocks" WHERE "id" = $1`, [hotelBlockA]),
      'owner DELETE on "hotel_room_blocks"'
    );
    // Two live blocks never overlap on one room (23P01, the gist exclusion); the
    // range is half-open, so a block starting on the day another ends is fine.
    await expectDatabaseError(
      '23P01',
      () =>
        client.query(
          `INSERT INTO "hotel_room_blocks" (
            "id", "organizationId", "branchId", "roomId", "kind", "startDate", "endDate", "reason", "createdBy"
          ) VALUES ($1, 'org_devfathom', $2, $3, 'OUT_OF_SERVICE', DATE '2030-01-11', DATE '2030-01-13', 'Overlap', $4)`,
          [`hotel_block_overlap_${suffix}`, hotelPropertyA, hotelRoomA, userA]
        ),
      'an overlapping live block'
    );
    await client.query('SAVEPOINT hotel_adjacent_block');
    try {
      const adjacent = await client.query(
        `INSERT INTO "hotel_room_blocks" (
          "id", "organizationId", "branchId", "roomId", "kind", "startDate", "endDate", "reason", "createdBy"
        ) VALUES ($1, 'org_devfathom', $2, $3, 'OUT_OF_SERVICE', DATE '2030-01-12', DATE '2030-01-13', 'Adjacent', $4)`,
        [`hotel_block_adjacent_${suffix}`, hotelPropertyA, hotelRoomA, userA]
      );
      assertEqual(adjacent.rowCount, 1, 'an adjacent block must be admitted (half-open ranges)');
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT hotel_adjacent_block');
      await client.query('RELEASE SAVEPOINT hotel_adjacent_block');
    }
    // Each table's WITH CHECK fails closed for an org-B row. Three refusals
    // arrive before the policy of the table under probe and say nothing about
    // it: the bed insert is refused by the structure guard (it cannot see org
    // B's room under tenant A's scope), a room or bed insert that passed would
    // be refused when its status trigger writes the org-B ledger line, and a
    // direct ledger insert is refused by the event guard whatever the tenant.
    // So, as for the pharmacy L1 guards, each is pinned with its guard on and
    // then probed with the guard switched off as the superuser, inside this
    // rolled-back transaction, and the guard is switched back on after.
    await expectDatabaseError(
      '42501',
      () =>
        client.query(
          `INSERT INTO "hotel_room_types" (
            "id", "organizationId", "branchId", "code", "name", "updatedAt"
          ) VALUES ($1, $2, $3, 'ESCAPE', 'Escape', CURRENT_TIMESTAMP)`,
          [`hotel_room_type_escape_${suffix}`, organizationB, hotelPropertyB]
        ),
      'tenant A inserting an org-B "hotel_room_types" row'
    );
    await expectDatabaseError(
      '42501',
      () =>
        client.query(
          `INSERT INTO "hotel_room_blocks" (
            "id", "organizationId", "branchId", "roomId", "kind", "startDate", "endDate", "reason", "createdBy"
          ) VALUES ($1, $2, $3, $4, 'OUT_OF_SERVICE', DATE '2030-02-01', DATE '2030-02-02', 'Escape', $5)`,
          [`hotel_block_escape_${suffix}`, organizationB, hotelPropertyB, hotelRoomB, userA]
        ),
      'tenant A inserting an org-B "hotel_room_blocks" row'
    );
    const deniedRoomInsert = () =>
      client.query(
        `INSERT INTO "hotel_rooms" (
          "id", "organizationId", "branchId", "roomTypeId", "inventoryKind", "number", "statusChangedBy", "updatedAt"
        ) VALUES ($1, $2, $3, $4, 'BED', '102', $5, CURRENT_TIMESTAMP)`,
        [`hotel_room_escape_${suffix}`, organizationB, hotelPropertyB, hotelRoomTypeB, userA]
      );
    const deniedBedInsert = () =>
      client.query(
        `INSERT INTO "hotel_beds" (
          "id", "organizationId", "branchId", "roomId", "label", "statusChangedBy", "updatedAt"
        ) VALUES ($1, $2, $3, $4, '2', $5, CURRENT_TIMESTAMP)`,
        [`hotel_bed_escape_${suffix}`, organizationB, hotelPropertyB, hotelRoomB, userA]
      );
    const deniedEventInsert = () =>
      client.query(
        `INSERT INTO "hotel_room_status_events" (
          "organizationId", "branchId", "roomId", "toStatus", "actorId", "reason"
        ) VALUES ($1, $2, $3, 'VACANT_CLEAN', $4, 'forged')`,
        [organizationB, hotelPropertyB, hotelRoomB, userA]
      );
    await expectDatabaseError(
      '42501',
      deniedRoomInsert,
      'guarded tenant A insert of an org-B "hotel_rooms" row'
    );
    await expectDatabaseError(
      '23514',
      deniedBedInsert,
      'guarded tenant A insert of an org-B "hotel_beds" row'
    );
    await expectDatabaseError(
      '23514',
      deniedEventInsert,
      'guarded tenant A insert of an org-B "hotel_room_status_events" row'
    );
    const hotelInsertGuards = [
      ['hotel_rooms', 'hotel_rooms_status_event'],
      ['hotel_beds', 'hotel_beds_structure_guard'],
      ['hotel_beds', 'hotel_beds_status_event'],
      ['hotel_room_status_events', 'hotel_inventory_event_guard'],
    ] as const;
    await client.query('RESET ROLE');
    for (const [table, trigger] of hotelInsertGuards) {
      await client.query(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    }
    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
    await expectDatabaseError(
      '42501',
      deniedRoomInsert,
      'tenant A inserting an org-B "hotel_rooms" row'
    );
    await expectDatabaseError(
      '42501',
      deniedBedInsert,
      'tenant A inserting an org-B "hotel_beds" row'
    );
    await expectDatabaseError(
      '42501',
      deniedEventInsert,
      'tenant A inserting an org-B "hotel_room_status_events" row'
    );
    // With the event guard off, the ledger's own UPDATE and DELETE policies are
    // what decide which rows a blind write reaches.
    await expectBlindWriteScoped(
      'hotel_room_status_events',
      `UPDATE "hotel_room_status_events" SET "reason" = 'Blind probe'`
    );
    await expectBlindWriteScoped(
      'hotel_room_status_events',
      `DELETE FROM "hotel_room_status_events"`
    );
    await client.query('RESET ROLE');
    for (const [table, trigger] of hotelInsertGuards) {
      await client.query(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
    }
    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
    // The control plane reads both tenants' rows on every inventory table.
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    for (const [table, idA, idB] of hotelInventoryRows) {
      const both = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "${table}" WHERE "id" IN ($1, $2)`,
        [idA, idB]
      );
      assertEqual(both.rows[0]?.count, 2, `platform scope must read both tenants' "${table}" rows`);
    }
    await client.query(
      `SELECT set_config('app.is_platform_admin', 'false', true),
              set_config('app.current_user_id', '', true),
              set_config('app.hotel_inventory_reason', '', true)`
    );

    // Hotel MVP (PR #964) — guests, rate plans and prices, reservations, stay
    // units, folios, the folio ledger, payments, operation idempotency and the
    // housekeeping queue. Seeded as the superuser, one mirrored row per table
    // in each tenant; then probed as tenant A's assigned user for read, UPDATE
    // and DELETE isolation, the append-only and reversal triggers, the folio,
    // payment and rate-plan guards, fail-closed org-B inserts, platform reads
    // and the sanctioned purge path.
    await client.query('RESET ROLE');
    const hotelMvp = (name: string, tag: 'a' | 'b') => `hotel_mvp_${name}_${tag}_${suffix}`;
    for (const [tag, organizationId, branchId, roomTypeId, roomId, extraId, actorId] of [
      ['a', 'org_devfathom', hotelPropertyA, hotelRoomTypeA, hotelRoomA, hotelExtraA, userA],
      ['b', organizationB, hotelPropertyB, hotelRoomTypeB, hotelRoomB, hotelExtraB, userB],
    ] as const) {
      const scopeArgs = [organizationId, branchId];
      await client.query(
        `INSERT INTO "hotel_guests" ("id", "organizationId", "branchId", "firstName", "lastName")
         VALUES ($3, $1, $2, 'Isolation', 'Guest')`,
        [...scopeArgs, hotelMvp('guest', tag)]
      );
      await client.query(
        `INSERT INTO "hotel_confirmation_sequences" ("id", "organizationId", "branchId", "nextNumber")
         VALUES ($3, $1, $2, 2)`,
        [...scopeArgs, hotelMvp('sequence', tag)]
      );
      await client.query(
        `INSERT INTO "hotel_rate_plans" (
          "id", "organizationId", "branchId", "roomTypeId", "code", "name", "currency", "taxBasisPoints", "createdById"
        ) VALUES ($3, $1, $2, $4, 'BAR', 'Best available', 'PKR', 1600, $5)`,
        [...scopeArgs, hotelMvp('rate_plan', tag), roomTypeId, actorId]
      );
      await client.query(
        `INSERT INTO "hotel_rate_plan_prices" (
          "id", "organizationId", "branchId", "roomTypeId", "ratePlanId", "validFrom", "validTo", "netMinor", "published", "createdById"
        ) VALUES ($3, $1, $2, $4, $5, DATE '2030-03-01', DATE '2030-03-31', 10000, true, $6)`,
        [...scopeArgs, hotelMvp('price', tag), roomTypeId, hotelMvp('rate_plan', tag), actorId]
      );
      await client.query(
        `INSERT INTO "hotel_reservations" (
          "id", "organizationId", "branchId", "confirmationNumber", "source", "primaryGuestId",
          "arrivalDate", "departureDate", "adults", "currency", "createdById"
        ) VALUES ($3, $1, $2, 'RSV-2030-000001', 'DIRECT', $4, DATE '2030-03-02', DATE '2030-03-03', 1, 'PKR', $5)`,
        [...scopeArgs, hotelMvp('reservation', tag), hotelMvp('guest', tag), actorId]
      );
      await client.query(
        `INSERT INTO "hotel_reservation_stay_units" (
          "id", "organizationId", "branchId", "reservationId", "roomTypeId", "ratePlanId", "adults",
          "arrivalDate", "departureDate", "netMinor", "taxMinor", "totalMinor", "taxBasisPoints", "nightlyRates", "currency"
        ) VALUES ($3, $1, $2, $4, $5, $6, 1, DATE '2030-03-02', DATE '2030-03-03', 10000, 1600, 11600, 1600, '[]'::jsonb, 'PKR')`,
        [
          ...scopeArgs,
          hotelMvp('stay_unit', tag),
          hotelMvp('reservation', tag),
          roomTypeId,
          hotelMvp('rate_plan', tag),
        ]
      );
      await client.query(
        `INSERT INTO "hotel_folios" ("id", "organizationId", "branchId", "reservationId", "folioNumber", "currency")
         VALUES ($3, $1, $2, $4, 'FOL-2030-000001', 'PKR')`,
        [...scopeArgs, hotelMvp('folio', tag), hotelMvp('reservation', tag)]
      );
      await client.query(
        `INSERT INTO "hotel_folio_entries" (
          "id", "organizationId", "branchId", "folioId", "kind", "catalogItemId", "description", "quantity",
          "unitMinor", "netMinor", "taxMinor", "grossMinor", "currency", "createdById"
        ) VALUES ($3, $1, $2, $4, 'EXTRA', $5, 'Laundry', 1, 1000, 1000, 0, 1000, 'PKR', $6)`,
        [...scopeArgs, hotelMvp('entry', tag), hotelMvp('folio', tag), extraId, actorId]
      );
      await client.query(
        `INSERT INTO "hotel_folio_payments" (
          "id", "organizationId", "branchId", "folioId", "direction", "amountMinor", "currency", "createdById"
        ) VALUES ($3, $1, $2, $4, 'COLLECTION', 1000, 'PKR', $5)`,
        [...scopeArgs, hotelMvp('payment', tag), hotelMvp('folio', tag), actorId]
      );
      await client.query(
        `INSERT INTO "hotel_operation_idempotency_keys" (
          "id", "organizationId", "branchId", "scope", "key", "requestHash"
        ) VALUES ($3, $1, $2, 'folio.postExtra', 'isolation-key', 'hash')`,
        [...scopeArgs, hotelMvp('idempotency', tag)]
      );
      await client.query(
        `INSERT INTO "hotel_housekeeping_tasks" ("id", "organizationId", "branchId", "roomId", "title", "createdById")
         VALUES ($3, $1, $2, $4, 'Turn down', $5)`,
        [...scopeArgs, hotelMvp('task', tag), roomId, actorId]
      );
    }
    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userA]);
    const hotelMvpRows: Array<[table: string, name: string]> = [
      ['hotel_guests', 'guest'],
      ['hotel_confirmation_sequences', 'sequence'],
      ['hotel_rate_plans', 'rate_plan'],
      ['hotel_rate_plan_prices', 'price'],
      ['hotel_reservations', 'reservation'],
      ['hotel_reservation_stay_units', 'stay_unit'],
      ['hotel_folios', 'folio'],
      ['hotel_folio_entries', 'entry'],
      ['hotel_folio_payments', 'payment'],
      ['hotel_operation_idempotency_keys', 'idempotency'],
      ['hotel_housekeeping_tasks', 'task'],
    ];
    for (const [table, name] of hotelMvpRows) {
      const forced = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
        [table]
      );
      assertEqual(forced.rows[0]?.relrowsecurity, true, `"${table}" must enable RLS`);
      assertEqual(forced.rows[0]?.relforcerowsecurity, true, `"${table}" must force RLS`);
      const idA = hotelMvp(name, 'a');
      const idB = hotelMvp(name, 'b');
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
    // Recorded money is append-only for its owner too.
    for (const [table, name] of [
      ['hotel_reservation_stay_units', 'stay_unit'],
      ['hotel_folio_entries', 'entry'],
      ['hotel_folio_payments', 'payment'],
    ] as const) {
      await expectDatabaseError(
        '55000',
        () =>
          client.query(`UPDATE "${table}" SET "currency" = 'PKR' WHERE "id" = $1`, [
            hotelMvp(name, 'a'),
          ]),
        `owner UPDATE on "${table}"`
      );
      await expectDatabaseError(
        '55000',
        () => client.query(`DELETE FROM "${table}" WHERE "id" = $1`, [hotelMvp(name, 'a')]),
        `owner DELETE on "${table}"`
      );
    }
    // A reversal is a positive copy, admitted once; a reversal of a reversal,
    // a second reversal and a mismatched copy are all refused.
    const reverseEntry = (id: string, reverses: string, grossMinor = 1000) =>
      client.query(
        `INSERT INTO "hotel_folio_entries" (
          "id", "organizationId", "branchId", "folioId", "kind", "catalogItemId", "description", "quantity",
          "unitMinor", "netMinor", "taxMinor", "grossMinor", "currency", "reversesEntryId", "reason", "createdById"
        ) VALUES ($1, 'org_devfathom', $2, $3, 'EXTRA', $4, 'Laundry', 1, 1000, $5, 0, $5, 'PKR', $6, 'Isolation probe', $7)`,
        [id, hotelPropertyA, hotelMvp('folio', 'a'), hotelExtraA, grossMinor, reverses, userA]
      );
    await expectDatabaseError(
      '23514',
      () => reverseEntry(`hotel_mvp_bad_reversal_${suffix}`, hotelMvp('entry', 'a'), 999),
      'a reversal that does not copy the original amount'
    );
    const reversal = await reverseEntry(`hotel_mvp_reversal_${suffix}`, hotelMvp('entry', 'a'));
    assertEqual(reversal.rowCount, 1, 'a positive-copy reversal must be admitted once');
    await expectDatabaseError(
      '23505',
      () => reverseEntry(`hotel_mvp_second_reversal_${suffix}`, hotelMvp('entry', 'a')),
      'a second reversal of one entry'
    );
    await expectDatabaseError(
      '23514',
      () =>
        reverseEntry(`hotel_mvp_reversal_of_reversal_${suffix}`, `hotel_mvp_reversal_${suffix}`),
      'a reversal of a reversal'
    );
    // An entry is in its folio's currency, on an open folio.
    await expectDatabaseError(
      '23514',
      () =>
        client.query(
          `INSERT INTO "hotel_folio_entries" (
            "id", "organizationId", "branchId", "folioId", "kind", "catalogItemId", "description", "quantity",
            "unitMinor", "netMinor", "taxMinor", "grossMinor", "currency", "createdById"
          ) VALUES ($1, 'org_devfathom', $2, $3, 'EXTRA', $4, 'Laundry', 1, 1000, 1000, 0, 1000, 'USD', $5)`,
          [
            `hotel_mvp_usd_entry_${suffix}`,
            hotelPropertyA,
            hotelMvp('folio', 'a'),
            hotelExtraA,
            userA,
          ]
        ),
      'a folio entry in another currency'
    );
    // A refund names a collection of the same folio and never exceeds it.
    const refund = (id: string, amountMinor: number) =>
      client.query(
        `INSERT INTO "hotel_folio_payments" (
          "id", "organizationId", "branchId", "folioId", "direction", "amountMinor", "currency", "refundsPaymentId", "createdById"
        ) VALUES ($1, 'org_devfathom', $2, $3, 'REFUND', $4, 'PKR', $5, $6)`,
        [id, hotelPropertyA, hotelMvp('folio', 'a'), amountMinor, hotelMvp('payment', 'a'), userA]
      );
    assertEqual(
      (await refund(`hotel_mvp_refund_1_${suffix}`, 600)).rowCount,
      1,
      'a partial refund must be admitted'
    );
    await expectDatabaseError(
      '23514',
      () => refund(`hotel_mvp_refund_2_${suffix}`, 401),
      'a refund beyond the remaining collected amount'
    );
    assertEqual(
      (await refund(`hotel_mvp_refund_3_${suffix}`, 400)).rowCount,
      1,
      'refunding the remainder must be admitted'
    );
    // A rate plan is in its property's currency, with tax at most 100%.
    for (const [label, currency, taxBasisPoints] of [
      ['a foreign-currency rate plan', 'USD', 0],
      ['a rate plan taxed above 100%', 'PKR', 10001],
    ] as const) {
      await expectDatabaseError(
        '23514',
        () =>
          client.query(
            `INSERT INTO "hotel_rate_plans" (
              "id", "organizationId", "branchId", "roomTypeId", "code", "name", "currency", "taxBasisPoints", "createdById"
            ) VALUES ($1, 'org_devfathom', $2, $3, $4, 'Probe', $5, $6, $7)`,
            [
              `hotel_mvp_plan_probe_${currency}_${suffix}`,
              hotelPropertyA,
              hotelRoomTypeA,
              `PROBE${taxBasisPoints}`,
              currency,
              taxBasisPoints,
              userA,
            ]
          ),
        label
      );
    }
    // Org-B rows fail closed on the tables with no BEFORE INSERT guard.
    await expectDatabaseError(
      '42501',
      () =>
        client.query(
          `INSERT INTO "hotel_guests" ("id", "organizationId", "branchId", "firstName", "lastName")
           VALUES ($1, $2, $3, 'Escape', 'Guest')`,
          [`hotel_mvp_guest_escape_${suffix}`, organizationB, hotelPropertyB]
        ),
      'tenant A inserting an org-B "hotel_guests" row'
    );
    await expectDatabaseError(
      '42501',
      () =>
        client.query(
          `INSERT INTO "hotel_housekeeping_tasks" ("id", "organizationId", "branchId", "roomId", "title", "createdById")
           VALUES ($1, $2, $3, $4, 'Escape', $5)`,
          [`hotel_mvp_task_escape_${suffix}`, organizationB, hotelPropertyB, hotelRoomB, userA]
        ),
      'tenant A inserting an org-B "hotel_housekeeping_tasks" row'
    );
    // The control plane reads both tenants' rows on every table.
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    for (const [table, name] of hotelMvpRows) {
      const both = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "${table}" WHERE "id" IN ($1, $2)`,
        [hotelMvp(name, 'a'), hotelMvp(name, 'b')]
      );
      assertEqual(both.rows[0]?.count, 2, `platform scope must read both tenants' "${table}" rows`);
    }
    // The only DELETE of recorded money is the sanctioned purge of that row's
    // own tenant: refused for another tenant's purge, admitted for its own.
    await client.query(`SELECT set_config('app.purging_organization_id', 'org_devfathom', true)`);
    await expectDatabaseError(
      '55000',
      () =>
        client.query(`DELETE FROM "hotel_folio_entries" WHERE "id" = $1`, [hotelMvp('entry', 'b')]),
      'a purge of tenant A deleting tenant B money'
    );
    await client.query(`SELECT set_config('app.purging_organization_id', $1, true)`, [
      organizationB,
    ]);
    await client.query('SAVEPOINT hotel_mvp_purge');
    try {
      const purged = await client.query(`DELETE FROM "hotel_folio_entries" WHERE "id" = $1`, [
        hotelMvp('entry', 'b'),
      ]);
      assertEqual(purged.rowCount, 1, 'the sanctioned purge must delete its own tenant money');
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT hotel_mvp_purge');
      await client.query('RELEASE SAVEPOINT hotel_mvp_purge');
    }
    await client.query(
      `SELECT set_config('app.is_platform_admin', 'false', true),
              set_config('app.purging_organization_id', '', true),
              set_config('app.current_user_id', '', true)`
    );

    // H1-07 — meal plans are organization-scoped configuration (no assignment
    // rule): read, UPDATE and DELETE isolation, blind writes reaching exactly
    // the tenant's rows, the org-B insert failing closed, and platform reads.
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userA]);
    const hotelMealPlanRows: Array<[table: string, idA: string, idB: string]> = [
      ['hotel_meal_plans', hotelMealPlanA, hotelMealPlanB],
    ];
    for (const [table, idA, idB] of hotelMealPlanRows) {
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
    await expectBlindWriteScoped(
      'hotel_meal_plans',
      `UPDATE "hotel_meal_plans" SET "active" = false`
    );
    await expectBlindWriteScoped('hotel_meal_plans', `DELETE FROM "hotel_meal_plans"`);
    await expectDatabaseError(
      '42501',
      () =>
        client.query(
          `INSERT INTO "hotel_meal_plans" (
            "id", "organizationId", "branchId", "code", "name", "meals", "updatedAt"
          ) VALUES ($1, $2, $3, 'ESCAPE', 'Escape', '[]'::jsonb, CURRENT_TIMESTAMP)`,
          [`hotel_meal_plan_escape_${suffix}`, organizationB, hotelPropertyB]
        ),
      'tenant A inserting an org-B "hotel_meal_plans" row'
    );
    // Same tenant, the other tenant's property: the composite foreign key is
    // what refuses, because (org_devfathom, property B) is not a property.
    await expectDatabaseError(
      '23503',
      () =>
        client.query(
          `INSERT INTO "hotel_meal_plans" (
            "id", "organizationId", "branchId", "code", "name", "meals", "updatedAt"
          ) VALUES ($1, 'org_devfathom', $2, 'BORROWED', 'Borrowed', '[]'::jsonb, CURRENT_TIMESTAMP)`,
          [`hotel_meal_plan_borrowed_${suffix}`, hotelPropertyB]
        ),
      'tenant A hanging a "hotel_meal_plans" row off tenant B\'s property'
    );
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    for (const [table, idA, idB] of hotelMealPlanRows) {
      const both = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "${table}" WHERE "id" IN ($1, $2)`,
        [idA, idB]
      );
      assertEqual(both.rows[0]?.count, 2, `platform scope must read both tenants' "${table}" rows`);
    }
    await client.query(
      `SELECT set_config('app.is_platform_admin', 'false', true),
              set_config('app.current_user_id', '', true)`
    );

    // H1-05 — function spaces and the bookings that make them exclusive. Read,
    // UPDATE and DELETE isolation; blind writes (a space's RESTRICT bookings go
    // first inside the savepoint); the inserts that fail closed — an org-B space
    // (42501), an org-B booking (P0001 from the BEFORE trigger, which cannot see
    // the foreign space; 42501 once that guard is switched off), a same-tenant
    // space on the other tenant's property and a booking naming its own space
    // under another property (23503, the pins); then invariant 25: an overlap
    // and a buffer-only collision both 23P01, a gap of teardown plus setup
    // admitted, and widening a buffer into a collision refused; then platform
    // reads of both tenants' rows.
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userA]);
    const hotelSpaceRows: Array<[table: string, idA: string, idB: string]> = [
      ['hotel_function_spaces', hotelSpaceA, hotelSpaceB],
      ['hotel_space_bookings', hotelBookingA, hotelBookingB],
    ];
    for (const [table, idA, idB] of hotelSpaceRows) {
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
    await expectBlindWriteScoped(
      'hotel_function_spaces',
      `UPDATE "hotel_function_spaces" SET "updatedAt" = CURRENT_TIMESTAMP`
    );
    await expectBlindWriteScoped('hotel_function_spaces', `DELETE FROM "hotel_function_spaces"`, [
      `DELETE FROM "hotel_space_bookings"`,
    ]);
    await expectBlindWriteScoped(
      'hotel_space_bookings',
      `UPDATE "hotel_space_bookings" SET "ref" = '{"label":"Blind probe"}'`
    );
    await expectBlindWriteScoped('hotel_space_bookings', `DELETE FROM "hotel_space_bookings"`);
    await expectDatabaseError(
      '42501',
      () =>
        client.query(
          `INSERT INTO "hotel_function_spaces" (
            "id", "organizationId", "branchId", "name", "layouts", "updatedAt"
          ) VALUES ($1, $2, $3, 'Escape', '[{"layout":"Theatre","capacity":1}]'::jsonb, CURRENT_TIMESTAMP)`,
          [`hotel_space_escape_${suffix}`, organizationB, hotelPropertyB]
        ),
      'tenant A inserting an org-B "hotel_function_spaces" row'
    );
    await expectDatabaseError(
      '23503',
      () =>
        client.query(
          `INSERT INTO "hotel_function_spaces" (
            "id", "organizationId", "branchId", "name", "layouts", "updatedAt"
          ) VALUES ($1, 'org_devfathom', $2, 'Borrowed', '[{"layout":"Theatre","capacity":1}]'::jsonb, CURRENT_TIMESTAMP)`,
          [`hotel_space_borrowed_${suffix}`, hotelPropertyB]
        ),
      'tenant A hanging a "hotel_function_spaces" row off tenant B\'s property'
    );
    // A booking carries its own buffered range here, so that with the trigger
    // disabled below the row reaches the policy rather than a NOT NULL check.
    const deniedBookingInsert = () =>
      client.query(
        `INSERT INTO "hotel_space_bookings" (
          "organizationId", "branchId", "spaceId", "startsAt", "endsAt", "kind", "bufferedRange", "updatedAt"
        ) VALUES ($1, $2, $3, TIMESTAMPTZ '2030-02-01 10:00:00+00', TIMESTAMPTZ '2030-02-01 11:00:00+00', 'HOLD',
                  tstzrange(TIMESTAMPTZ '2030-02-01 10:00:00+00', TIMESTAMPTZ '2030-02-01 11:00:00+00', '[)'), CURRENT_TIMESTAMP)`,
        [organizationB, hotelPropertyB, hotelSpaceB]
      );
    await expectDatabaseError(
      'P0001',
      deniedBookingInsert,
      'guarded tenant A insert of an org-B "hotel_space_bookings" row'
    );
    await expectDatabaseError(
      'P0001',
      () =>
        client.query(
          `INSERT INTO "hotel_space_bookings" (
            "organizationId", "branchId", "spaceId", "startsAt", "endsAt", "kind", "updatedAt"
          ) VALUES ('org_devfathom', $1, $2, TIMESTAMPTZ '2030-02-01 10:00:00+00', TIMESTAMPTZ '2030-02-01 11:00:00+00', 'HOLD', CURRENT_TIMESTAMP)`,
          [hotelPropertyA, hotelSpaceB]
        ),
      "tenant A booking tenant B's space under its own property"
    );
    await expectDatabaseError(
      '23503',
      () =>
        client.query(
          `INSERT INTO "hotel_space_bookings" (
            "organizationId", "branchId", "spaceId", "startsAt", "endsAt", "kind", "updatedAt"
          ) VALUES ('org_devfathom', $1, $2, TIMESTAMPTZ '2030-02-01 10:00:00+00', TIMESTAMPTZ '2030-02-01 11:00:00+00', 'HOLD', CURRENT_TIMESTAMP)`,
          [hotelPropertyA2, hotelSpaceA]
        ),
      'tenant A booking its own space under another of its properties'
    );
    await client.query('RESET ROLE');
    await client.query(
      `ALTER TABLE "hotel_space_bookings" DISABLE TRIGGER "hotel_space_bookings_buffered_range"`
    );
    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
    await expectDatabaseError(
      '42501',
      deniedBookingInsert,
      'tenant A inserting an org-B "hotel_space_bookings" row'
    );
    await client.query('RESET ROLE');
    await client.query(
      `ALTER TABLE "hotel_space_bookings" ENABLE TRIGGER "hotel_space_bookings_buffered_range"`
    );
    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
    // Invariant 25. The seeded booking holds 10:00–11:00 with 30 minutes of
    // setup and 15 of teardown, so its range is [09:30, 11:15).
    const bookSpaceA = (startsAt: string, endsAt: string) =>
      client.query(
        `INSERT INTO "hotel_space_bookings" (
          "organizationId", "branchId", "spaceId", "startsAt", "endsAt", "kind", "updatedAt"
        ) VALUES ('org_devfathom', $1, $2, $3::timestamptz, $4::timestamptz, 'HOLD', CURRENT_TIMESTAMP)`,
        [hotelPropertyA, hotelSpaceA, startsAt, endsAt]
      );
    await expectDatabaseError(
      '23P01',
      () => bookSpaceA('2030-01-01 10:30:00+00', '2030-01-01 11:30:00+00'),
      'a booking overlapping another in the same space'
    );
    await expectDatabaseError(
      '23P01',
      () => bookSpaceA('2030-01-01 11:00:00+00', '2030-01-01 12:00:00+00'),
      'a back-to-back booking that the buffers alone collide'
    );
    await client.query('SAVEPOINT hotel_space_gap');
    try {
      const admitted = await bookSpaceA('2030-01-01 11:45:00+00', '2030-01-01 12:45:00+00');
      assertEqual(
        admitted.rowCount,
        1,
        'a booking leaving exactly teardown plus setup must be admitted'
      );
      await expectDatabaseError(
        '23P01',
        () =>
          client.query(`UPDATE "hotel_function_spaces" SET "setupMinutes" = 31 WHERE "id" = $1`, [
            hotelSpaceA,
          ]),
        'widening a buffer into a collision between existing bookings'
      );
      const narrowed = await client.query(
        `UPDATE "hotel_function_spaces" SET "setupMinutes" = 10 WHERE "id" = $1`,
        [hotelSpaceA]
      );
      assertEqual(narrowed.rowCount, 1, 'narrowing a buffer must be admitted');
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT hotel_space_gap');
      await client.query('RELEASE SAVEPOINT hotel_space_gap');
    }
    // 20261021104000 (a): the range cannot be written around the trigger. A
    // direct overwrite of "bufferedRange" is recomputed from the booking's own
    // bounds and the space's buffers, so the collision it tried to hide is
    // still refused.
    await client.query('SAVEPOINT hotel_space_overwrite');
    try {
      const overwritten = await client.query(
        `UPDATE "hotel_space_bookings" SET "bufferedRange" = 'empty' WHERE "id" = $1`,
        [hotelBookingA]
      );
      assertEqual(
        overwritten.rowCount,
        1,
        'tenant A must reach its own booking for the range-overwrite probe'
      );
      const recomputed = await client.query<{ intact: boolean | null }>(
        `SELECT "bufferedRange" = tstzrange(
                  "startsAt" - interval '30 minutes', "endsAt" + interval '15 minutes', '[)'
                ) AS intact
           FROM "hotel_space_bookings" WHERE "id" = $1`,
        [hotelBookingA]
      );
      assertEqual(
        recomputed.rows[0]?.intact,
        true,
        'a direct write to "bufferedRange" must be recomputed by the trigger'
      );
      await expectDatabaseError(
        '23P01',
        () => bookSpaceA('2030-01-01 10:30:00+00', '2030-01-01 11:30:00+00'),
        'a booking overlapping another whose range was written around the trigger'
      );
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT hotel_space_overwrite');
      await client.query('RELEASE SAVEPOINT hotel_space_overwrite');
    }
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    for (const [table, idA, idB] of hotelSpaceRows) {
      const both = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "${table}" WHERE "id" IN ($1, $2)`,
        [idA, idB]
      );
      assertEqual(both.rows[0]?.count, 2, `platform scope must read both tenants' "${table}" rows`);
    }
    await client.query(
      `SELECT set_config('app.is_platform_admin', 'false', true),
              set_config('app.current_user_id', '', true)`
    );

    // H1-14 — guest-message templates are property configuration under the
    // standard policy: read, UPDATE and DELETE isolation; blind writes reaching
    // exactly the tenant's rows; the org-B insert failing closed; a same-tenant
    // row hung off the other tenant's property refused by the composite key;
    // UPS-04's "one approved version per message", held by the partial unique
    // index (a second APPROVED version is 23505, and admitted once the first is
    // retired); then platform reads of both tenants' rows.
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userA]);
    const hotelJourneyRows: Array<[table: string, idA: string, idB: string]> = [
      ['hotel_journey_templates', hotelJourneyA, hotelJourneyB],
    ];
    for (const [table, idA, idB] of hotelJourneyRows) {
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
    await expectBlindWriteScoped(
      'hotel_journey_templates',
      `UPDATE "hotel_journey_templates" SET "updatedAt" = CURRENT_TIMESTAMP`
    );
    await expectBlindWriteScoped(
      'hotel_journey_templates',
      `DELETE FROM "hotel_journey_templates"`
    );
    await expectDatabaseError(
      '42501',
      () =>
        client.query(
          `INSERT INTO "hotel_journey_templates" (
            "id", "organizationId", "branchId", "moment", "channel", "language", "body", "version", "createdByUserId", "updatedAt"
          ) VALUES ($1, $2, $3, 'WELCOME', 'SMS', 'EN', 'Escape', 1, $4, CURRENT_TIMESTAMP)`,
          [`hotel_journey_escape_${suffix}`, organizationB, hotelPropertyB, userA]
        ),
      'tenant A inserting an org-B "hotel_journey_templates" row'
    );
    // Same tenant, the other tenant's property: the composite foreign key is
    // what refuses, because (org_devfathom, property B) is not a property.
    await expectDatabaseError(
      '23503',
      () =>
        client.query(
          `INSERT INTO "hotel_journey_templates" (
            "id", "organizationId", "branchId", "moment", "channel", "language", "body", "version", "createdByUserId", "updatedAt"
          ) VALUES ($1, 'org_devfathom', $2, 'WELCOME', 'SMS', 'EN', 'Borrowed', 1, $3, CURRENT_TIMESTAMP)`,
          [`hotel_journey_borrowed_${suffix}`, hotelPropertyB, userA]
        ),
      'tenant A hanging a "hotel_journey_templates" row off tenant B\'s property'
    );
    // UPS-04. The seeded message is version 1, a draft; approving two further
    // versions of it at once must fail on the partial unique index, and succeed
    // once the first approval is retired.
    const approveJourneyA = (id: string, version: number) =>
      client.query(
        `INSERT INTO "hotel_journey_templates" (
          "id", "organizationId", "branchId", "moment", "channel", "language", "body", "version",
          "status", "approvedByUserId", "approvedAt", "createdByUserId", "updatedAt"
        ) VALUES ($1, 'org_devfathom', $2, 'BOOKING_CONFIRMED', 'WHATSAPP', 'EN', 'Approved wording', $3,
                  'APPROVED', $4, CURRENT_TIMESTAMP, $4, CURRENT_TIMESTAMP)`,
        [id, hotelPropertyA, version, userA]
      );
    await client.query('SAVEPOINT hotel_journey_approved');
    try {
      const first = await approveJourneyA(`hotel_journey_v2_${suffix}`, 2);
      assertEqual(first.rowCount, 1, 'the first approved version of a message must be admitted');
      await expectDatabaseError(
        '23505',
        () => approveJourneyA(`hotel_journey_v3_${suffix}`, 3),
        'a second approved version of the same message'
      );
      const retired = await client.query(
        `UPDATE "hotel_journey_templates" SET "status" = 'RETIRED' WHERE "id" = $1`,
        [`hotel_journey_v2_${suffix}`]
      );
      assertEqual(retired.rowCount, 1, 'retiring the approved version must be admitted');
      const next = await approveJourneyA(`hotel_journey_v3_${suffix}`, 3);
      assertEqual(next.rowCount, 1, 'approving the next version after retirement must be admitted');
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT hotel_journey_approved');
      await client.query('RELEASE SAVEPOINT hotel_journey_approved');
    }
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    for (const [table, idA, idB] of hotelJourneyRows) {
      const both = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "${table}" WHERE "id" IN ($1, $2)`,
        [idA, idB]
      );
      assertEqual(both.rows[0]?.count, 2, `platform scope must read both tenants' "${table}" rows`);
    }
    await client.query(
      `SELECT set_config('app.is_platform_admin', 'false', true),
              set_config('app.current_user_id', '', true)`
    );

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

    // M2-L1: each new table's WITH CHECK must fail closed — a tenant A scope may
    // not mint a staff profile, device, credential, terminal session, or
    // co-authorization owned by another organization. The referenced parents are
    // real org-B rows, so the 42501 is the RLS policy firing, not a dangling FK.
    const restaurantWriteDenied: Array<[sql: string, values: unknown[]]> = [
      [
        `INSERT INTO "restaurant_staff_profiles" ("id", "organizationId", "displayName", "updatedAt")
         VALUES ($1, $2, 'Escape Operator', CURRENT_TIMESTAMP)`,
        [`deny_staff_${suffix}`, organizationB],
      ],
      [
        `INSERT INTO "restaurant_registered_devices" (
          "id", "organizationId", "branchId", "name", "deviceSecretHash", "updatedAt"
        ) VALUES ($1, $2, $3, 'Escape POS', $4, CURRENT_TIMESTAMP)`,
        [`deny_device_${suffix}`, organizationB, branchB, `device-hash-escape-${suffix}`],
      ],
      [
        `INSERT INTO "restaurant_operator_credentials" (
          "id", "organizationId", "staffProfileId", "type", "credentialHash", "updatedAt"
        ) VALUES ($1, $2, $3, 'PIN', $4, CURRENT_TIMESTAMP)`,
        [`deny_credential_${suffix}`, organizationB, staffB1, `pin-hash-escape-${suffix}`],
      ],
      [
        `INSERT INTO "restaurant_terminal_sessions" (
          "id", "organizationId", "deviceId", "tokenHash", "updatedAt"
        ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
        [`deny_session_${suffix}`, organizationB, deviceB, `session-hash-escape-${suffix}`],
      ],
      [
        `INSERT INTO "restaurant_co_authorizations" (
          "id", "organizationId", "actingStaffProfileId", "approvingStaffProfileId", "capability", "reason"
        ) VALUES ($1, $2, $3, $4, 'orders:void', 'escape')`,
        [`deny_coauth_${suffix}`, organizationB, staffB1, staffB2],
      ],
      // M4-L1: each new table's WITH CHECK must fail closed — a tenant A scope may
      // not mint an order/item/event/ticket/table/assignment/outbox/idempotency
      // row owned by another organization. The referenced parents are real org-B
      // rows, so the 42501 is the RLS policy firing, not a dangling FK. Distinct
      // values on unique columns avoid a 23505 masking the RLS check.
      [
        `INSERT INTO "restaurant_orders" (
          "id", "organizationId", "branchId", "orderNumber", "businessDate", "channel",
          "staffProfileId", "deviceId", "updatedAt"
        ) VALUES ($1, $2, $3, 2, DATE '2030-01-02', 'DINE_IN', $4, $5, CURRENT_TIMESTAMP)`,
        [`deny_order_${suffix}`, organizationB, branchB, staffB1, deviceB],
      ],
      [
        `INSERT INTO "restaurant_order_items" (
          "id", "organizationId", "orderId", "productId", "name", "unitPrice", "updatedAt"
        ) VALUES ($1, $2, $3, $4, 'Escape Item', 1.00, CURRENT_TIMESTAMP)`,
        [`deny_oitem_${suffix}`, organizationB, orderB, productB],
      ],
      [
        `INSERT INTO "restaurant_order_events" (
          "id", "organizationId", "orderId", "sequence", "eventType", "payload"
        ) VALUES ($1, $2, $3, 2, 'order.escape', '{}')`,
        [`deny_oevent_${suffix}`, organizationB, orderB],
      ],
      [
        `INSERT INTO "restaurant_kitchen_tickets" (
          "id", "organizationId", "orderId", "stationId", "businessDate", "ticketNumber", "updatedAt"
        ) VALUES ($1, $2, $3, $4, DATE '2030-01-02', 2, CURRENT_TIMESTAMP)`,
        [`deny_ticket_${suffix}`, organizationB, orderB, stationB],
      ],
      [
        `INSERT INTO "restaurant_tables" (
          "id", "organizationId", "floorId", "code", "capacity", "updatedAt"
        ) VALUES ($1, $2, $3, 'DENY', 2, CURRENT_TIMESTAMP)`,
        [`deny_table_${suffix}`, organizationB, floorB],
      ],
      [
        `INSERT INTO "restaurant_server_section_assignments" (
          "id", "organizationId", "sectionId", "staffProfileId", "businessDate", "updatedAt"
        ) VALUES ($1, $2, $3, $4, DATE '2030-01-02', CURRENT_TIMESTAMP)`,
        [`deny_secassign_${suffix}`, organizationB, sectionB, staffB1],
      ],
      [
        `INSERT INTO "restaurant_event_outbox" (
          "id", "organizationId", "eventType", "aggregateType", "aggregateId", "payload", "updatedAt"
        ) VALUES ($1, $2, 'order.escape', 'restaurant.order', $3, '{}', CURRENT_TIMESTAMP)`,
        [`deny_outbox_${suffix}`, organizationB, orderB],
      ],
      [
        `INSERT INTO "restaurant_order_idempotency_keys" (
          "id", "organizationId", "deviceId", "key", "commandType", "updatedAt"
        ) VALUES ($1, $2, $3, $4, 'order.open', CURRENT_TIMESTAMP)`,
        [`deny_idem_${suffix}`, organizationB, deviceB, `deny-idem-${suffix}`],
      ],
      [
        `INSERT INTO "restaurant_customers" (
          "id", "organizationId", "displayName", "updatedAt"
        ) VALUES ($1, $2, 'Escape Customer', CURRENT_TIMESTAMP)`,
        [`deny_customer_${suffix}`, organizationB],
      ],
    ];
    for (const [sql, values] of restaurantWriteDenied) {
      await expectDatabaseError('42501', () => client.query(sql, values));
    }

    // Wallet (L2), print bridge / printer registry and the pharmacy return
    // verification task: each table's WITH CHECK must fail closed — a tenant A
    // scope may not mint a row owned by another organization. The referenced
    // parents are real org-B rows, so the 42501 is the policy firing, not a
    // dangling FK; and RLS WITH CHECK runs before index maintenance, so the
    // denied rows deliberately dodge every unique key (a second platform, a
    // non-PENDING update, an inactive link, a hold without a task) — all but the
    // one-config-per-organization key, which nothing can dodge. Were a policy
    // loosened, every one of these inserts would go through (the config one
    // would trip 23505 instead), so each probe detects its own table's policy.
    const newerTenantWriteDenied: Array<[table: string, sql: string, values: unknown[]]> = [
      [
        'restaurant_wallet_tenant_config',
        `INSERT INTO "restaurant_wallet_tenant_config" (
          "id", "organizationId", "programDisplayName", "googleClassSuffix", "updatedAt"
        ) VALUES ($1, $2, 'Escape Rewards', $3, CURRENT_TIMESTAMP)`,
        [`deny_rwcfg_${suffix}`, organizationB, `class-deny-${suffix}`],
      ],
      [
        'restaurant_wallet_passes',
        `INSERT INTO "restaurant_wallet_passes" (
          "id", "organizationId", "customerId", "loyaltyAccountId", "platform", "serialNumber", "updatedAt"
        ) VALUES ($1, $2, $3, $4, 'GOOGLE', $5, CURRENT_TIMESTAMP)`,
        [
          `deny_rwpass_${suffix}`,
          organizationB,
          customerB,
          loyaltyAccountB,
          `serial-deny-${suffix}`,
        ],
      ],
      [
        'restaurant_wallet_pass_registrations',
        `INSERT INTO "restaurant_wallet_pass_registrations" (
          "id", "organizationId", "passId", "deviceLibraryIdentifier", "pushToken", "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [
          `deny_rwreg_${suffix}`,
          organizationB,
          walletPassB,
          `device-library-deny-${suffix}`,
          `push-token-deny-${suffix}`,
        ],
      ],
      [
        'restaurant_wallet_pass_updates',
        `INSERT INTO "restaurant_wallet_pass_updates" (
          "id", "organizationId", "passId", "reason", "status", "nextAttemptAt", "updatedAt"
        ) VALUES ($1, $2, $3, 'PROGRAM', 'SENT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [`deny_rwupd_${suffix}`, organizationB, walletPassB],
      ],
      [
        'restaurant_wallet_enrollment_links',
        `INSERT INTO "restaurant_wallet_enrollment_links" (
          "id", "organizationId", "branchId", "tokenHash", "active"
        ) VALUES ($1, $2, $3, $4, false)`,
        [`deny_rwlink_${suffix}`, organizationB, branchB, `wallet-link-deny-${suffix}`],
      ],
      [
        'restaurant_wallet_enrollment_attempts',
        `INSERT INTO "restaurant_wallet_enrollment_attempts" (
          "id", "organizationId", "branchId", "identifierKind", "normalizedValue", "otpHash", "expiresAt"
        ) VALUES ($1, $2, $3, 'PHONE', '+15550000103', $4, CURRENT_TIMESTAMP + interval '10 minutes')`,
        [`deny_rwatt_${suffix}`, organizationB, branchB, `otp-hash-deny-${suffix}`],
      ],
      [
        'restaurant_print_bridge_enrollment_codes',
        `INSERT INTO "restaurant_print_bridge_enrollment_codes" (
          "id", "organizationId", "deviceId", "codeHash", "issuedDeviceSecretHash", "expiresAt"
        ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP + interval '10 minutes')`,
        [
          `deny_rpbcode_${suffix}`,
          organizationB,
          deviceB,
          `bridge-code-deny-${suffix}`,
          `bridge-secret-deny-${suffix}`,
        ],
      ],
      [
        'restaurant_printers',
        `INSERT INTO "restaurant_printers" (
          "id", "organizationId", "branchId", "bridgeId", "name", "connectionKind", "address", "paperWidthMm", "updatedAt"
        ) VALUES ($1, $2, $3, $4, 'Escape Printer', 'TCP', '10.0.0.3:9100', 58, CURRENT_TIMESTAMP)`,
        [`deny_rprinter_${suffix}`, organizationB, branchB, deviceB],
      ],
      [
        'pharmacy_return_verification_tasks',
        `INSERT INTO "pharmacy_return_verification_tasks" (
          "id", "organizationId", "branchId", "holdingId", "requestedByUserId"
        ) VALUES ($1, $2, $3, $4, $5)`,
        [`deny_phtask_${suffix}`, organizationB, pharmacyBranchB, returnHoldB2, userA],
      ],
    ];
    for (const [table, sql, values] of newerTenantWriteDenied) {
      await expectDatabaseError(
        '42501',
        () => client.query(sql, values),
        `tenant A inserting an org-B "${table}" row`
      );
    }

    // L1 guard ordering. PostgreSQL fires BEFORE ROW triggers before it
    // evaluates RLS WITH CHECK, and the hold and pack-price insert guards look
    // their parents up by NEW."organizationId" under the caller's RLS scope. A
    // tenant A scope therefore has an org-B row refused by the guard first: the
    // hold's quantity guard sees no org-B sale line (RETURN_EXCEEDS_SOLD, 23514)
    // and the price identity guard sees no org-B pack level (P0001). That
    // refusal is real but says nothing about the table's own policy — it would
    // hold with the policy loosened, too. So the guards are switched off for the
    // two WITH CHECK probes only, as the superuser, inside this rolled-back
    // transaction, and switched back on straight after; both states are pinned.
    const deniedHoldInsert = () =>
      client.query(
        `INSERT INTO "pharmacy_unidentified_return_holds" (
          "id", "organizationId", "branchId", "returnId", "saleLineId", "quarantineLocationId",
          "canonicalUnits", "integrityDecision", "actorId"
        ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'intact', $7)`,
        [
          `deny_phhold_${suffix}`,
          organizationB,
          pharmacyBranchB,
          saleReturnB3,
          saleLineB,
          quarantineLocationB,
          userA,
        ]
      );
    const deniedPackPriceInsert = () =>
      client.query(
        `INSERT INTO "pharmacy_pack_prices" (
          "id", "organizationId", "presentationId", "packLevelId", "mrpMinor", "effectiveFrom", "source", "createdById"
        ) VALUES ($1, $2, $3, $4, 1000, TIMESTAMP '2030-02-01', 'manual', $5)`,
        [`deny_phprice_${suffix}`, organizationB, presentationB, packLevelB, userA]
      );
    await expectDatabaseError(
      '23514',
      deniedHoldInsert,
      'guarded tenant A insert of an org-B "pharmacy_unidentified_return_holds" row'
    );
    await expectDatabaseError(
      'P0001',
      deniedPackPriceInsert,
      'guarded tenant A insert of an org-B "pharmacy_pack_prices" row'
    );
    const l1InsertGuards = [
      ['pharmacy_unidentified_return_holds', 'pharmacy_unidentified_return_hold_validate'],
      ['pharmacy_unidentified_return_holds', 'pharmacy_return_holding_quantity_guard'],
      ['pharmacy_pack_prices', 'pharmacy_price_identity'],
    ] as const;
    await client.query('RESET ROLE');
    for (const [table, trigger] of l1InsertGuards) {
      await client.query(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    }
    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
    await expectDatabaseError(
      '42501',
      deniedHoldInsert,
      'tenant A inserting an org-B "pharmacy_unidentified_return_holds" row'
    );
    await expectDatabaseError(
      '42501',
      deniedPackPriceInsert,
      'tenant A inserting an org-B "pharmacy_pack_prices" row'
    );
    await client.query('RESET ROLE');
    for (const [table, trigger] of l1InsertGuards) {
      await client.query(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
    }
    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);

    // M2-L1: owning the organizationId is not enough — the staff profile a
    // credential points at must be the same tenant's too. A tenant A credential
    // referencing tenant B's operator trips the deferred composite tenant FK.
    await expectDatabaseError('23503', async () => {
      await client.query(
        `INSERT INTO "restaurant_operator_credentials" (
          "id", "organizationId", "staffProfileId", "type", "credentialHash", "updatedAt"
        ) VALUES ($1, 'org_devfathom', $2, 'PIN', $3, CURRENT_TIMESTAMP)`,
        [`cross_credential_${suffix}`, staffB1, `pin-hash-cross-${suffix}`]
      );
      await client.query(`SET CONSTRAINTS "tenant_rest_cred_staffProfileId_fk" IMMEDIATE`);
    });

    // M8-L1: normalized identifiers dedupe only within an organization, and a
    // tenant-scoped child cannot reference another tenant's customer.
    await expectDatabaseError('23505', () =>
      client.query(
        `INSERT INTO "restaurant_customer_identifiers" (
          "id", "organizationId", "customerId", "kind", "normalizedValue", "updatedAt"
        ) VALUES ($1, 'org_devfathom', $2, 'EMAIL', $3, CURRENT_TIMESTAMP)`,
        [`duplicate_customer_identifier_${suffix}`, customerA, sharedCustomerEmail]
      )
    );
    await expectDatabaseError('23503', async () => {
      await client.query(
        `INSERT INTO "restaurant_customer_identifiers" (
          "id", "organizationId", "customerId", "kind", "normalizedValue", "updatedAt"
        ) VALUES ($1, 'org_devfathom', $2, 'PHONE', '+15550000000', CURRENT_TIMESTAMP)`,
        [`cross_customer_identifier_${suffix}`, customerB]
      );
      await client.query(`SET CONSTRAINTS "tenant_customer_identifier_customerId_fk" IMMEDIATE`);
    });

    // Normal CRUD RLS permits owner updates, but the database trigger blocks
    // effective loyalty-version mutation for every role.
    await expectDatabaseError('55000', () =>
      client.query(
        `UPDATE "restaurant_loyalty_program_versions" SET "earnRate" = 2 WHERE "id" = $1`,
        [loyaltyProgramA]
      )
    );
    await expectDatabaseError('55000', () =>
      client.query(`DELETE FROM "restaurant_loyalty_program_versions" WHERE "id" = $1`, [
        loyaltyProgramA,
      ])
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
      'RLS verification passed: forced policies, cross-tenant isolation, fail-closed writes, composite ownership, append-only ledgers, tenant-local customer dedupe, immutable effective loyalty versions, wallet/printer/pharmacy-return-hold/pack-price cross-tenant probes, hospitality property/assignment/catalog/inventory/meal-plan/function-space/journey-template probes, platform-only policies, and pending-login-intent control-plane isolation.'
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
