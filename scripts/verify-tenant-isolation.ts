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
      'RLS verification passed: forced policies, cross-tenant isolation, fail-closed writes, composite ownership, append-only ledgers, tenant-local customer dedupe, immutable effective loyalty versions, platform-only policies, and pending-login-intent control-plane isolation.'
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
