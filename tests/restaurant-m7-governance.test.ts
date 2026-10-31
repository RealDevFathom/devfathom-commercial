import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const client = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;

const M7_COLUMNS = {
  restaurant_jobs: [
    'id',
    'organizationId',
    'type',
    'payload',
    'status',
    'attempts',
    'maxAttempts',
    'scheduledAt',
    'nextAttemptAt',
    'claimedAt',
    'claimedBy',
    'lastError',
    'idempotencyKey',
    'createdAt',
    'updatedAt',
    // ALTER TABLE appends the claim token after the existing columns.
    'claimToken',
  ],
  restaurant_job_executions: [
    'id',
    'organizationId',
    'jobId',
    'workerId',
    'attempt',
    'startedAt',
    'finishedAt',
    'outcome',
    'error',
    'createdAt',
  ],
  restaurant_webhook_inbox: [
    'id',
    'organizationId',
    'source',
    'externalEventId',
    'eventType',
    'payload',
    'verificationStatus',
    'status',
    'attempts',
    'lastError',
    'receivedAt',
    'processedAt',
    'createdAt',
    'updatedAt',
  ],
  restaurant_sop_templates: [
    'id',
    'organizationId',
    'name',
    'description',
    'category',
    'isActive',
    'createdAt',
    'updatedAt',
  ],
  restaurant_sop_template_versions: [
    'id',
    'organizationId',
    'templateId',
    'versionNumber',
    'status',
    'publishedAt',
    'retiredAt',
    'createdAt',
    'updatedAt',
  ],
  restaurant_sop_template_steps: [
    'id',
    'organizationId',
    'templateVersionId',
    'stepOrder',
    'title',
    'instructions',
    'requiresPhoto',
    'requiresSignature',
    'requiresNote',
    'createdAt',
    'updatedAt',
  ],
  restaurant_sop_assignments: [
    'id',
    'organizationId',
    'branchId',
    'templateId',
    'frequency',
    'interval',
    'daysOfWeek',
    'monthDay',
    'startDate',
    'endDate',
    'dueTimeMinutes',
    'windowMinutes',
    'graceMinutes',
    'active',
    'createdAt',
    'updatedAt',
    'assigneeJobRoleId',
    'assigneeStaffProfileId',
    'assigneeTargetType',
    // 20260902180000_restaurant_sop_interval_recurrence appended these three:
    // the INTERVAL-frequency window end, and the supersession chain that
    // versions an assignment instead of mutating it in place.
    'intervalEndTimeMinutes',
    'supersedesAssignmentId',
    'supersededAt',
  ],
  restaurant_sop_occurrences: [
    'id',
    'organizationId',
    'assignmentId',
    'templateVersionId',
    'branchId',
    'businessDate',
    'status',
    'dueAt',
    'windowEndsAt',
    'startedAt',
    'submittedAt',
    'resolvedAt',
    'createdAt',
    'updatedAt',
    // SOP-1 (WHA-224/284): an occurrence is owned either by the person it was
    // assigned to, or by whoever claimed it out of its job-role pool.
    'assignedStaffProfileId',
    'claimedAt',
    'claimedByStaffProfileId',
    'poolJobRoleId',
  ],
  restaurant_sop_occurrence_steps: [
    'id',
    'organizationId',
    'occurrenceId',
    'templateStepId',
    'completed',
    'completedAt',
    'completedByStaffProfileId',
    'note',
    'createdAt',
    'updatedAt',
  ],
  restaurant_sop_evidence: [
    'id',
    'organizationId',
    'occurrenceId',
    'occurrenceStepId',
    'contentHash',
    'mimeType',
    'sizeBytes',
    'storageRef',
    'uploaderStaffProfileId',
    'capturedAt',
    'createdAt',
  ],
  restaurant_sop_verifications: [
    'id',
    'organizationId',
    'occurrenceId',
    'action',
    'actorStaffProfileId',
    'coAuthorizationId',
    'reason',
    'createdAt',
  ],
  restaurant_sop_escalation_policies: [
    'id',
    'organizationId',
    'name',
    'scope',
    'branchId',
    'stopOnAcknowledged',
    'stopOnVerified',
    'quietHoursStartMinutes',
    'quietHoursEndMinutes',
    'active',
    'createdAt',
    'updatedAt',
  ],
  restaurant_sop_escalation_steps: [
    'id',
    'organizationId',
    'policyId',
    'stepOrder',
    'delayMinutes',
    'target',
    'channel',
    'maxAttempts',
    'createdAt',
    'updatedAt',
  ],
  restaurant_sop_escalation_events: [
    'id',
    'organizationId',
    'occurrenceId',
    'escalationStepId',
    'kind',
    'actorStaffProfileId',
    'detail',
    'createdAt',
  ],
  restaurant_notifications: [
    'id',
    'organizationId',
    'recipientStaffProfileId',
    'branchId',
    'category',
    'title',
    'body',
    'entityType',
    'entityId',
    'isRead',
    'readAt',
    'createdAt',
    'updatedAt',
  ],
  restaurant_notification_channel_settings: [
    'id',
    'organizationId',
    'branchId',
    'category',
    'channel',
    'enabled',
    'createdAt',
    'updatedAt',
  ],
  restaurant_notification_deliveries: [
    'id',
    'organizationId',
    'notificationId',
    'channel',
    'status',
    'attempt',
    'error',
    'createdAt',
  ],
} as const;

const M7_ENUMS = [
  ['RestaurantJobStatus', ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD']],
  [
    'RestaurantSopOccurrenceStatus',
    ['SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'LATE', 'MISSED', 'WAIVED'],
  ],
] as const;

const APPEND_ONLY_TABLES = [
  'restaurant_job_executions',
  'restaurant_sop_evidence',
  'restaurant_sop_verifications',
  'restaurant_sop_escalation_events',
  'restaurant_notification_deliveries',
] as const;

type M7Table = keyof typeof M7_COLUMNS;
const M7_TABLES = Object.keys(M7_COLUMNS) as M7Table[];

async function uniqueColumnSets(table: M7Table) {
  const result = await client!.query<{ columns: string[] }>(
    `SELECT array_agg(attribute_row.attname::text ORDER BY key_row.ordinality) AS columns
       FROM pg_catalog.pg_index index_row
       JOIN pg_catalog.pg_class table_row ON table_row.oid = index_row.indrelid
       JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
       CROSS JOIN LATERAL unnest(index_row.indkey::smallint[])
         WITH ORDINALITY AS key_row(attnum, ordinality)
       JOIN pg_catalog.pg_attribute attribute_row
         ON attribute_row.attrelid = table_row.oid
        AND attribute_row.attnum = key_row.attnum
      WHERE namespace_row.nspname = 'public'
        AND table_row.relname = $1
        AND index_row.indisunique
        AND index_row.indisvalid
        AND key_row.ordinality <= index_row.indnkeyatts
      GROUP BY index_row.indexrelid`,
    [table]
  );
  return result.rows.map((row) => row.columns);
}

describeIfDatabase('M7 schema governance (real PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(TEST_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run M7 governance probes against a non-local database.');
    }
    await client!.connect();
  }, 60_000);

  afterAll(async () => {
    await client?.end();
  });

  it('pins all 17 M7 table column allowlists in ordinal order', async () => {
    const result = await client!.query<{ table_name: M7Table; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position`,
      [M7_TABLES]
    );
    expect(
      Object.fromEntries(
        M7_TABLES.map((table) => [
          table,
          result.rows.filter((row) => row.table_name === table).map((row) => row.column_name),
        ])
      )
    ).toEqual(M7_COLUMNS);
  });

  it.each(M7_ENUMS)('pins the exact %s values', async (typeName, expected) => {
    const result = await client!.query<{ enumlabel: string }>(
      `SELECT enum_row.enumlabel
         FROM pg_catalog.pg_type type_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
         JOIN pg_catalog.pg_enum enum_row ON enum_row.enumtypid = type_row.oid
        WHERE namespace_row.nspname = 'public' AND type_row.typname = $1
        ORDER BY enum_row.enumsortorder`,
      [typeName]
    );
    expect(result.rows.map((row) => row.enumlabel)).toEqual(expected);
  });

  it('pins ENABLE and FORCE RLS on all 17 M7 tables', async () => {
    const result = await client!.query<{
      table_name: string;
      rls_enabled: boolean;
      rls_forced: boolean;
    }>(
      `SELECT table_row.relname AS table_name,
              table_row.relrowsecurity AS rls_enabled,
              table_row.relforcerowsecurity AS rls_forced
         FROM pg_catalog.pg_class table_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
        WHERE namespace_row.nspname = 'public' AND table_row.relname = ANY($1::text[])
        ORDER BY table_row.relname`,
      [M7_TABLES]
    );
    expect(result.rows).toEqual(
      [...M7_TABLES]
        .sort()
        .map((table_name) => ({ table_name, rls_enabled: true, rls_forced: true }))
    );
  });

  it('pins append-only INSERT/SELECT and the guarded demo-reset DELETE', async () => {
    const result = await client!.query<{ table_name: string; commands: string[] }>(
      `SELECT table_row.relname AS table_name,
              array_agg(CASE policy_row.polcmd
                WHEN 'r' THEN 'SELECT'
                WHEN 'a' THEN 'INSERT'
                WHEN 'w' THEN 'UPDATE'
                WHEN 'd' THEN 'DELETE'
                ELSE 'ALL'
              END ORDER BY CASE policy_row.polcmd
                WHEN 'r' THEN 'SELECT'
                WHEN 'a' THEN 'INSERT'
                WHEN 'w' THEN 'UPDATE'
                WHEN 'd' THEN 'DELETE'
                ELSE 'ALL'
              END) AS commands
         FROM pg_catalog.pg_class table_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
         JOIN pg_catalog.pg_policy policy_row ON policy_row.polrelid = table_row.oid
        WHERE namespace_row.nspname = 'public' AND table_row.relname = ANY($1::text[])
        GROUP BY table_row.relname
        ORDER BY table_row.relname`,
      [[...APPEND_ONLY_TABLES]]
    );
    // Ordinary tenants remain append-only; only the exact demo-reset DELETE is admitted.
    const resetPolicies = await client!.query(
      `SELECT tablename, policyname, cmd, permissive, roles::text[] AS roles, qual, with_check
         FROM pg_catalog.pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])
          AND (policyname = 'restaurant_demo_reset_delete' OR cmd IN ('DELETE', 'ALL'))
        ORDER BY tablename, policyname`,
      [APPEND_ONLY_TABLES]
    );
    expect(
      resetPolicies.rows.map((row) => ({
        ...row,
        // Match the catalog rendering already pinned by the demo-reset guard.
        qual: row.qual?.replace(/^public\./, ''),
      }))
    ).toEqual(
      [...APPEND_ONLY_TABLES].sort().map((tablename) => ({
        tablename,
        policyname: 'restaurant_demo_reset_delete',
        cmd: 'DELETE',
        permissive: 'PERMISSIVE',
        roles: ['public'],
        qual: 'restaurant_demo_reset_allowed("organizationId")',
        with_check: null,
      }))
    );

    expect(result.rows).toEqual(
      [...APPEND_ONLY_TABLES].sort().map((table_name) => ({
        table_name,
        commands: ['DELETE', 'INSERT', 'SELECT'],
      }))
    );
  });

  it.each([
    ['restaurant_jobs', ['organizationId', 'idempotencyKey']],
    ['restaurant_webhook_inbox', ['organizationId', 'source', 'externalEventId']],
    ['restaurant_notification_channel_settings', ['organizationId', 'category', 'channel']],
  ] as const)('%s enforces the required dedupe key', async (table, columns) => {
    expect(await uniqueColumnSets(table)).toContainEqual([...columns]);
  });
});
