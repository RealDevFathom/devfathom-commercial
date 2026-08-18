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
      'RLS verification passed: forced policies, read isolation, token/webhook isolation, restaurant branch/assignment isolation, restaurant staff/credential/device/terminal-session/co-authorization isolation + fail-closed WITH CHECK + composite ownership, restaurant order/order-item/order-event/kitchen-ticket/floor-table/section-assignment/outbox/idempotency-key isolation + fail-closed WITH CHECK, SSO/ticket isolation, meeting occurrence/participant/session/event/link isolation, globally unique occurrence publicId, credential-free meeting series, fail-closed access, composite ownership, platform-only policies, and pending-login-intent control-plane isolation.'
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
