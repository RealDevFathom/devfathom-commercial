/**
 * @vitest-environment node
 *
 * DEV-96 scheduled audit retention against a REAL migrated PostgreSQL, through
 * the application client (whose pg adapter must decode the coordinator's lock
 * query) and the database delete guards. The tenant has one confirmed 30-day
 * AUDIT policy and lengthens it to 3650 days for records from 200 days ago.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role. Without it the suite reports skipped. Expired rows
 * are deleted by the purge itself; the rest stay, as the guards require, and
 * the tenant is marked PURGED afterwards so no later worker run queues it.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const run = randomUUID().replaceAll('-', '').slice(0, 12);
const organizationId = `dev96_retention_${run}`;
const branchId = `dev96_branch_${run}`;
const ruleSetId = `dev96_rules_${run}`;
const audit = {
  expired: `dev96_expired_${run}`,
  held: `dev96_held_${run}`,
  inside: `dev96_inside_${run}`,
  young: `dev96_young_${run}`,
  first: `dev96_first_${run}`,
  second: `dev96_second_${run}`,
};

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let owners: typeof import('./retention-owners');
let retention: typeof import('./retention');

async function insertAudit(db: ScopedDb, id: string, ageDays: number) {
  await db.$executeRawUnsafe(
    `INSERT INTO audit_logs (id, "organizationId", "createdAt", source, category, action)
     VALUES ($1, $2, (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => $3::integer),
             'SYSTEM', 'SYSTEM', 'dev96.retention.fixture')`,
    id,
    organizationId,
    ageDays
  );
}

async function remainingAudit(): Promise<string[]> {
  const rows = await withPlatformDb((db) =>
    db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM audit_logs WHERE "organizationId" = $1 ORDER BY id`,
      organizationId
    )
  );
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  owners = await import('./retention-owners');
  retention = await import('./retention');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(withPlatformDb);

  await withPlatformDb(async (db) => {
    await db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now())`,
      organizationId
    );
    await db.$executeRawUnsafe(
      `INSERT INTO pharmacy_branches (id, "organizationId", code, name, "addressLine", city, "provinceCode", "createdAt", "updatedAt")
       VALUES ($1, $2, $1, 'Retention branch', '1 Test Road', 'Lahore', 'PB', '2000-01-01', now())`,
      branchId,
      organizationId
    );
    await db.$executeRawUnsafe(
      `INSERT INTO pharmacy_jurisdiction_rule_sets (
         id, code, version, "effectiveFrom", "licenceCategories", "permittedSchedules",
         "prescriptionOnlyClasses", "prescriptionRetentionDays", "controlledRegisterFlags",
         "pharmacistCoverageRule", "recordRetentionByClass"
       ) VALUES (
         $1, $1, 1, '2000-01-01', '{"values":[],"provisional":true}', '{"values":[],"provisional":true}',
         '{"values":[],"provisional":true}', '{"values":{"default":30},"provisional":false}',
         '{"values":{},"provisional":true}', '{"values":{},"provisional":true}',
         '{"values":{"PRESCRIPTION":30,"CONTROLLED_REGISTER":30,"FISCAL":30,"AUDIT":30},"provisional":false}'
       )`,
      ruleSetId
    );
    await db.$executeRawUnsafe(
      `INSERT INTO pharmacy_branch_regulatory_profiles (
         id, "organizationId", "branchId", version, "effectiveFrom", "provinceCode",
         "jurisdictionRuleSetId", premises, "licenceCategory", "licenceNumber",
         "licenceValidFrom", "licenceValidTo", "licenceEvidenceFileRef", "permittedSchedules",
         "qualifiedPersonRegistration", "qualifiedPersonValidFrom", "qualifiedPersonValidTo",
         "qualifiedPersonCoverageRosterRef", "fiscalStatus", "retentionPolicy"
       ) VALUES (
         $1, $2, $3, 1, '2000-01-01', 'PK-PB', $4, '{}'::jsonb,
         'CONFIRMED', $1, '2000-01-01', '2100-01-01', '/test/licence', ARRAY[]::text[],
         'QP-TEST', '2000-01-01', '2100-01-01', '/test/roster', 'CONFIRMED', '{}'::jsonb
       )`,
      `dev96_profile_${run}`,
      organizationId,
      branchId,
      ruleSetId
    );
    await db.$executeRawUnsafe(
      `INSERT INTO pharmacy_retention_classes (id, "organizationId", "recordClass", "retentionDays", "effectiveFrom", reason, "createdByUserId")
       VALUES ($1, $2, 'AUDIT', 3650, (clock_timestamp() AT TIME ZONE 'UTC') - interval '200 days', 'DEV-96 fixture', 'dev96-actor')`,
      `dev96_class_${run}`,
      organizationId
    );
    // The held row is the oldest: it must not head every page.
    await insertAudit(db, audit.held, 450);
    await insertAudit(db, audit.expired, 400);
    await insertAudit(db, audit.inside, 100);
    await insertAudit(db, audit.young, 1);
    await db.$executeRawUnsafe(
      `INSERT INTO pharmacy_legal_hold_events (id, "organizationId", "holdKey", "recordClass", "recordId", kind, reason, "actorUserId")
       VALUES ($1, $2, 'dev96-case', 'AUDIT', $3, 'PLACED', 'DEV-96 fixture hold', 'dev96-actor')`,
      `dev96_hold_${run}`,
      organizationId,
      audit.held
    );
  });
}, 60_000);

afterAll(async () => {
  if (!TEST_DATABASE_URL || !withPlatformDb) return;
  await withPlatformDb((db) =>
    db.$executeRawUnsafe(`UPDATE organizations SET status = 'PURGED' WHERE id = $1`, organizationId)
  );
});

describeDatabase('DEV-96 scheduled audit retention, against PostgreSQL', () => {
  it('deletes an expired unheld row and skips held, young and in-window rows', async () => {
    await expect(owners.runPharmacyRecordRetentionJob({ organizationId })).resolves.toEqual({
      examined: 2,
      deleted: 1,
      blocked: 1,
    });
    expect(await remainingAudit()).toEqual([audit.held, audit.inside, audit.young].sort());
  });

  it('rolls back the whole tenant batch when an owner fails', async () => {
    await withPlatformDb(async (db) => {
      await insertAudit(db, audit.first, 500);
      await insertAudit(db, audit.second, 499);
    });
    const failing = {
      ...owners.auditRetentionOwner,
      async deleteAggregate(tx: ScopedDb, scope: { organizationId: string }, recordId: string) {
        await owners.auditRetentionOwner.deleteAggregate(tx, scope, recordId);
        if (recordId === audit.second) throw new Error('owner refused aggregate deletion');
      },
    };
    await expect(
      withTenantDb(organizationId, (tx) =>
        retention.runPharmacyRetentionPurge(tx, { organizationId }, [failing], 100)
      )
    ).rejects.toThrow('owner refused aggregate deletion');
    expect(await remainingAudit()).toEqual(
      [audit.first, audit.second, audit.held, audit.inside, audit.young].sort()
    );

    // The next scheduled batch removes both once nothing fails.
    await expect(owners.runPharmacyRecordRetentionJob({ organizationId })).resolves.toEqual({
      examined: 3,
      deleted: 2,
      blocked: 1,
    });
    expect(await remainingAudit()).toEqual([audit.held, audit.inside, audit.young].sort());
  });
});
