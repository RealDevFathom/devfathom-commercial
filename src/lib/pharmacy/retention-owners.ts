import 'server-only';

import type { PlatformJob } from '@/generated/prisma/client';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { runPharmacyRetentionPurge, type PharmacyRetentionOwner } from './retention';

/** The PlatformJobType value and the prefix of its per-tenant, per-UTC-day key. */
export const PHARMACY_RECORD_RETENTION_JOB = 'pharmacy.retention.v1';

/** The retention mutex is global, so each tenant's daily batch stays small. */
export const PHARMACY_RECORD_RETENTION_BATCH = 100;

/**
 * Audit records are the only class whose deletes the existing database guards
 * allow. The page skips rows under an active legal hold and rows younger than
 * the shortest confirmed AUDIT policy, so they cannot hold the head of the page
 * forever. The coordinator still rechecks every candidate under the mutex.
 */
export const auditRetentionOwner: PharmacyRetentionOwner = {
  recordClass: 'AUDIT',
  async candidates(tx, scope, limit) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      WITH policy AS (
        SELECT min(confirmed.days) AS days
        FROM (
          SELECT ("recordRetentionByClass"->'values'->>'AUDIT')::numeric AS days
          FROM "pharmacy_jurisdiction_rule_sets"
          WHERE NOT "isPlaceholder"
            AND "recordRetentionByClass"->'provisional' = 'false'::jsonb
            AND jsonb_typeof("recordRetentionByClass"->'values'->'AUDIT') = 'number'
        ) confirmed
        WHERE confirmed.days > 0
      )
      SELECT a."id"
      FROM "audit_logs" a, policy
      WHERE a."organizationId" = ${scope.organizationId}
        AND a."createdAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
          - make_interval(days => floor(least(policy.days, 1000000))::integer)
        AND NOT EXISTS (
          SELECT 1
          FROM (
            SELECT DISTINCT ON (h."holdKey") h."kind"
            FROM "pharmacy_legal_hold_events" h
            WHERE h."organizationId" = a."organizationId"
              AND h."recordClass"::text = 'AUDIT'
              AND h."recordId" = a."id"
            ORDER BY h."holdKey", h."createdAt" DESC, h."id" DESC
          ) latest
          WHERE latest."kind"::text = 'PLACED'
        )
      ORDER BY a."createdAt" ASC, a."id" ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  },
  async deleteAggregate(tx, scope, recordId) {
    const deleted = await tx.$executeRaw`
      DELETE FROM "audit_logs" WHERE "organizationId" = ${scope.organizationId} AND "id" = ${recordId}
    `;
    if (deleted !== 1) {
      throw new Error(`Audit retention delete removed ${deleted} rows instead of one.`);
    }
  },
};

/**
 * PRESCRIPTION, CONTROLLED_REGISTER and FISCAL stay unregistered: their
 * append-only and no-delete guards refuse every delete, so each batch would
 * throw and roll back. They are blocked until a regulator-approved change to
 * those guards; the retention policy alone never loosens them.
 */
export const PHARMACY_RECORD_RETENTION_OWNERS: readonly PharmacyRetentionOwner[] = [
  auditRetentionOwner,
];

/** One bounded purge batch for one tenant, in its own tenant transaction. */
export async function runPharmacyRecordRetentionJob(job: Pick<PlatformJob, 'organizationId'>) {
  const organizationId = job.organizationId;
  if (!organizationId) throw new Error('Pharmacy record retention requires an organization.');
  return withTenantDb(organizationId, (tx) =>
    runPharmacyRetentionPurge(
      tx,
      { organizationId },
      PHARMACY_RECORD_RETENTION_OWNERS,
      PHARMACY_RECORD_RETENTION_BATCH
    )
  );
}
