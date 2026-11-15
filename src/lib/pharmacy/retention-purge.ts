import 'server-only';

import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { PharmacyRecordClass } from './retention';

/**
 * The classes the purge may delete. AUDIT is deliberately absent: audit logs
 * are immutable for the whole life of a tenant, and only the platform's
 * tenant-deletion purge removes them. An AUDIT retention class or rule-set
 * value never drives deletion.
 */
export type PurgeableRecordClass = Exclude<PharmacyRecordClass, 'AUDIT'>;

/** The slice of a platform-scoped transaction the retention purge uses. */
export type RetentionPurgeDb = {
  $queryRaw: (query: Prisma.Sql) => Promise<unknown>;
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
};

type RecordSource = {
  table: string;
  anchor: string;
  /** Scope rows by branch (branch-bound records) or by organization. */
  branchBound: boolean;
  /** Deletes run in order with $1 = organizationId, $2 = record id; the last removes the root. */
  deletes: string[];
};

/**
 * DEV-96 — where each record class lives. The order of {@link PURGE_ORDER}
 * matters: register entries reference prescriptions, so they go first.
 */
const SOURCES: Record<PurgeableRecordClass, RecordSource> = {
  CONTROLLED_REGISTER: {
    table: 'pharmacy_controlled_register_entries',
    anchor: 'r."createdAt"',
    branchBound: true,
    deletes: [
      'DELETE FROM "pharmacy_controlled_register_entries" WHERE "organizationId" = $1 AND "id" = $2',
    ],
  },
  PRESCRIPTION: {
    table: 'pharmacy_prescriptions',
    anchor: 'r."capturedAt"',
    branchBound: false,
    deletes: [
      `DELETE FROM "pharmacy_prescription_fills" f USING "pharmacy_prescription_lines" l
        WHERE f."organizationId" = $1 AND l."organizationId" = $1
          AND l."prescriptionId" = $2 AND f."prescriptionLineId" = l."id"`,
      'DELETE FROM "pharmacy_prescription_lines" WHERE "organizationId" = $1 AND "prescriptionId" = $2',
      'DELETE FROM "pharmacy_prescriptions" WHERE "organizationId" = $1 AND "id" = $2',
    ],
  },
  FISCAL: {
    table: 'pharmacy_sales',
    anchor: 'COALESCE(r."completedAt", r."createdAt")',
    branchBound: true,
    deletes: ['DELETE FROM "pharmacy_sales" WHERE "organizationId" = $1 AND "id" = $2'],
  },
};

export const PURGE_ORDER: readonly PurgeableRecordClass[] = [
  'CONTROLLED_REGISTER',
  'PRESCRIPTION',
  'FISCAL',
];

const SCAN_BATCH = 200;
const SAVEPOINT = 'pharmacy_retention_purge';

type Candidate = { id: string; organizationId: string; anchor: Date; retentionDays: number };

/**
 * The audit row for one purged record. Written inside the record's savepoint,
 * so a delete the database refuses rolls the row back with it. Carries the
 * class, id, the record's own date and the period applied; never contents.
 */
export const PURGE_AUDIT_SQL = `INSERT INTO "audit_logs"
  ("id", "organizationId", "createdAt", "actorType", "actorName", "source", "category",
   "operation", "action", "description", "targetType", "targetId", "metadata", "outcome")
  VALUES ($1, $2, timezone('UTC', now()), 'SYSTEM', 'Retention purge', 'SYSTEM', 'PHARMACY',
   'DELETE', 'pharmacy.retention.purge', 'Record purged after its retention period elapsed',
   $3, $4, $5::jsonb, 'SUCCESS')`;

/**
 * Records of one class whose retention window — resolved in SQL by
 * pharmacy_retention_days() from the branch rule set and the tenant's
 * retention classes — has elapsed. A record with no resolvable period is never
 * a candidate.
 */
export function expiredRecordsSql(
  recordClass: PurgeableRecordClass,
  after: { anchor: Date; id: string } | null,
  limit: number
): Prisma.Sql {
  const source = SOURCES[recordClass];
  const anchor = Prisma.raw(source.anchor);
  const scope = source.branchBound
    ? Prisma.sql`SELECT b."organizationId", b."id" AS "branchId",
                        pharmacy_retention_days(b."organizationId", ${recordClass}::"PharmacyRecordClass", b."id") AS days
                   FROM "pharmacy_branches" b`
    : Prisma.sql`SELECT o."id" AS "organizationId", NULL::text AS "branchId",
                        pharmacy_retention_days(o."id", ${recordClass}::"PharmacyRecordClass", NULL) AS days
                   FROM "organizations" o
                  WHERE o."vertical" = 'PHARMACY'`;
  const branchJoin = source.branchBound
    ? Prisma.sql`AND r."branchId" = s."branchId"`
    : Prisma.empty;
  const cursor = after
    ? Prisma.sql`AND (${anchor}, r."id") > (${after.anchor}::timestamp, ${after.id})`
    : Prisma.empty;
  return Prisma.sql`
    WITH s AS (${scope})
    SELECT r."id", r."organizationId", ${anchor} AS "anchor", s.days AS "retentionDays"
      FROM s
      JOIN ${Prisma.raw(`"${source.table}"`)} r ON r."organizationId" = s."organizationId" ${branchJoin}
     WHERE s.days IS NOT NULL
       AND ${anchor} <= timezone('UTC', now()) - make_interval(days => s.days)
       ${cursor}
     ORDER BY 3 ASC, 1 ASC
     LIMIT ${limit}`;
}

export type RetentionPurgeResult = {
  purged: Record<PurgeableRecordClass, number>;
  retained: Array<{
    recordClass: PurgeableRecordClass;
    organizationId: string;
    id: string;
    reason: string;
  }>;
};

/**
 * DEV-96 — delete pharmacy records whose retention window has elapsed. Runs in
 * a platform-scoped transaction. Each record is deleted inside its own
 * savepoint with app.retention_purge_record naming it, which is the only way
 * the append-only prescription and register guards admit a DELETE; the
 * database re-checks the window and legal holds itself. A record the database
 * still refuses (a legal hold, or a retained row that references it) is rolled
 * back to its savepoint and reported, never forced; each purged record gets an
 * audit row in the same savepoint, so a refused one leaves none. At most
 * `maxPurgesPerClass` records of each class are removed per run.
 */
export async function purgeExpiredPharmacyRecords(
  db: RetentionPurgeDb,
  options: { maxPurgesPerClass?: number; maxScanned?: number } = {}
): Promise<RetentionPurgeResult> {
  // Each class has its own budget, so a backlog in one class never starves the
  // others.
  const maxPurges = options.maxPurgesPerClass ?? 50;
  const maxScanned = options.maxScanned ?? 1_000;
  const result: RetentionPurgeResult = {
    purged: { CONTROLLED_REGISTER: 0, PRESCRIPTION: 0, FISCAL: 0 },
    retained: [],
  };
  for (const recordClass of PURGE_ORDER) {
    let purgedTotal = 0;
    const source = SOURCES[recordClass];
    let scanned = 0;
    let cursor: { anchor: Date; id: string } | null = null;
    while (purgedTotal < maxPurges && scanned < maxScanned) {
      const batch = (await db.$queryRaw(
        expiredRecordsSql(recordClass, cursor, Math.min(SCAN_BATCH, maxScanned - scanned))
      )) as Candidate[];
      for (const record of batch) {
        if (purgedTotal >= maxPurges) break;
        scanned += 1;
        cursor = { anchor: record.anchor, id: record.id };
        await db.$executeRawUnsafe(`SAVEPOINT ${SAVEPOINT}`);
        try {
          await db.$queryRaw(
            Prisma.sql`SELECT set_config('app.retention_purge_record', ${`${record.organizationId}:${recordClass}:${record.id}`}, true)`
          );
          let removed = 0;
          for (const statement of source.deletes) {
            removed = await db.$executeRawUnsafe(statement, record.organizationId, record.id);
          }
          if (removed === 1) {
            await db.$executeRawUnsafe(
              PURGE_AUDIT_SQL,
              randomUUID(),
              record.organizationId,
              recordClass,
              record.id,
              JSON.stringify({
                recordClass,
                recordId: record.id,
                recordDate: new Date(record.anchor).toISOString(),
                retentionDays: Number(record.retentionDays),
              })
            );
          }
          await db.$queryRaw(Prisma.sql`SELECT set_config('app.retention_purge_record', '', true)`);
          await db.$executeRawUnsafe(`RELEASE SAVEPOINT ${SAVEPOINT}`);
          if (removed === 1) {
            result.purged[recordClass] += 1;
            purgedTotal += 1;
          }
        } catch (error) {
          await db.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
          await db.$executeRawUnsafe(`RELEASE SAVEPOINT ${SAVEPOINT}`);
          result.retained.push({
            recordClass,
            organizationId: record.organizationId,
            id: record.id,
            reason: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          });
        }
      }
      if (batch.length < SCAN_BATCH) break;
    }
  }
  return result;
}
