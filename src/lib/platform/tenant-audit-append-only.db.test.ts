/**
 * @vitest-environment node
 *
 * DEV-155 (#620) — tenant `audit_logs` are append-only, enforced by PostgreSQL.
 *
 * Row-level security on `audit_logs` isolates tenants but let any tenant-scoped
 * path UPDATE or DELETE its own audit evidence. The product decision on #620:
 * audit rows are immutable to every tenant user and to ordinary application
 * code; only a platform purge of that tenant may remove them, and only after it
 * has written a permanent platform-level record of what it removes.
 *
 * The end-to-end purge (record written, rows removed, other tenants untouched)
 * is asserted in `jobs.purge.db.test.ts`. This suite asserts the trigger itself
 * refuses everything else, for the tenant runtime, the platform runtime and —
 * when OWNER_DATABASE_URL is set — the table owner.
 * The pharmacy retention window has a separate check on an unexpired row.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database, never
 * DATABASE_URL). Without it the suite reports itself skipped.
 */
import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.OWNER_DATABASE_URL;

if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

// Same reason as jobs.purge.db.test.ts: hand the adapter a connection string so
// a duplicated `pg` module under Vitest cannot break the shared client.
vi.mock('@/lib/db', () => ({
  db: new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 4 }),
    log: ['error'],
  }),
}));

const suffix = randomBytes(6).toString('hex');
const ORG = `dev155_org_${suffix}`;
const OTHER_ORG = `dev155_other_${suffix}`;
const USER = `dev155_user_${suffix}`;
const DOOMED_USER = `dev155_doomed_${suffix}`;
const AUDIT = `dev155_audit_${suffix}`;
const RETAINED_AUDIT = `dev155_retained_audit_${suffix}`;
const DOOMED_AUDIT = `dev155_doomed_audit_${suffix}`;
const PURGED_AUDIT = `dev155_purged_audit_${suffix}`;
const PLATFORM_ACTOR = `dev155_platform_admin_${suffix}`;
const RETENTION_DAYS = 30;
// Not `platform_audit_logs`, whose own guard words its refusal the same way.
const APPEND_ONLY = /(?<!platform_)audit_logs is append-only/;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;

async function seedOrganization(db: ScopedDb, organizationId: string) {
  await db.$executeRawUnsafe(
    `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
     VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
    organizationId
  );
  await db.$executeRawUnsafe(
    `INSERT INTO organization_departments (id, "organizationId", key, name, active, "sortOrder", "createdAt", "updatedAt")
     VALUES ($1, $2, 'LEADERSHIP', 'Leadership', true, 0, now(), now())`,
    `dept_${organizationId}`,
    organizationId
  );
}

async function seedUser(db: ScopedDb, id: string) {
  await db.$executeRawUnsafe(
    `INSERT INTO users (id, "organizationId", name, email, role, department, title, "startDate", status, "createdAt", "updatedAt")
     VALUES ($1, $2, 'Audit Actor', $3, 'ADMIN', 'LEADERSHIP', 'Owner', now(), 'ACTIVE', now(), now())`,
    id,
    ORG,
    `${id}@example.test`
  );
}

async function seedAudit(db: ScopedDb, id: string, actorId: string | null, ageInDays = 0) {
  await db.$executeRawUnsafe(
    `INSERT INTO audit_logs (id, "organizationId", "actorId", "actorName", "actorEmail", source, category, action, description, "createdAt")
     VALUES ($1, $2, $3, 'Audit Actor', 'actor@example.test', 'TRPC', 'SYSTEM', 'fixture.audit', 'original',
             timezone('UTC', now()) - make_interval(days => $4::integer))`,
    id,
    ORG,
    actorId,
    ageInDays
  );
}

/** A platform record of an audit purge, as the purge job writes it. */
async function recordPurge(
  db: ScopedDb,
  overrides: { organizationId?: string; actor?: string | null; reason?: string | null } = {}
) {
  const record = await db.platformAuditLog.create({
    data: {
      organizationId: overrides.organizationId ?? ORG,
      actorPlatformUserId: overrides.actor === undefined ? PLATFORM_ACTOR : overrides.actor,
      action: 'organization.audit_logs.purge',
      targetType: 'AuditLog',
      reason: overrides.reason === undefined ? 'Retention window elapsed.' : overrides.reason,
    },
    select: { id: true },
  });
  return record.id;
}

async function namePurge(db: ScopedDb, organizationId: string, recordId: string) {
  await db.$queryRawUnsafe(
    `SELECT set_config('app.purging_organization_id', $1, true),
            set_config('app.audit_purge_record_id', $2, true)`,
    organizationId,
    recordId
  );
}

async function auditRow(id: string) {
  return withPlatformDb((db) =>
    db.auditLog.findUnique({
      where: { id },
      select: { actorId: true, actorName: true, actorEmail: true, description: true },
    })
  );
}

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('tenant audit_logs are append-only, against PostgreSQL', () => {
  beforeAll(async () => {
    ({ withPlatformDb, withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    await withPlatformDb(async (db) => {
      await seedOrganization(db, ORG);
      await seedOrganization(db, OTHER_ORG);
      await seedUser(db, USER);
      await seedUser(db, DOOMED_USER);
      await db.$executeRawUnsafe(
        `INSERT INTO pharmacy_retention_classes (id, "organizationId", "recordClass", "retentionDays", "effectiveFrom", reason, "createdByUserId")
         VALUES ($1, $2, 'AUDIT', $3, timezone('UTC', now()), 'Audit retention test policy', $4)`,
        `retention_${ORG}`,
        ORG,
        RETENTION_DAYS,
        USER
      );
      // PostgreSQL checks the retention trigger first. Age this row past the
      // configured window so its DELETE assertions reach the append-only guard.
      await seedAudit(db, AUDIT, USER, RETENTION_DAYS + 1);
      await seedAudit(db, RETAINED_AUDIT, USER);
      await seedAudit(db, DOOMED_AUDIT, DOOMED_USER);
      await seedAudit(db, PURGED_AUDIT, null);
    });
  }, 60_000);

  it('refuses the tenant runtime an UPDATE or DELETE of its own audit rows', async () => {
    await expect(
      withTenantDb(ORG, (db) =>
        db.auditLog.update({ where: { id: AUDIT }, data: { description: 'rewritten' } })
      )
    ).rejects.toThrow(APPEND_ONLY);
    await expect(
      withTenantDb(ORG, (db) => db.auditLog.deleteMany({ where: { id: AUDIT } }))
    ).rejects.toThrow(APPEND_ONLY);
    expect(await auditRow(AUDIT)).toMatchObject({ actorId: USER, description: 'original' });
  });

  it('refuses a tenant that names its own purge and a genuine purge record', async () => {
    const recordId = await withPlatformDb((db) => recordPurge(db));
    await expect(
      withTenantDb(ORG, async (db) => {
        await namePurge(db, ORG, recordId);
        return db.auditLog.deleteMany({ where: { id: AUDIT } });
      })
    ).rejects.toThrow(APPEND_ONLY);
    expect(await auditRow(AUDIT)).not.toBeNull();
  });

  it('refuses a tenant DELETE inside the pharmacy retention window', async () => {
    await expect(
      withTenantDb(ORG, (db) => db.auditLog.deleteMany({ where: { id: RETAINED_AUDIT } }))
    ).rejects.toThrow(
      `deletion refused: AUDIT record ${RETAINED_AUDIT} is inside its ${RETENTION_DAYS} day retention window`
    );
    expect(await auditRow(RETAINED_AUDIT)).toMatchObject({
      actorId: USER,
      description: 'original',
    });
  });

  it('refuses the platform runtime an UPDATE, and a DELETE outside a recorded purge', async () => {
    await expect(
      withPlatformDb((db) =>
        db.auditLog.update({ where: { id: AUDIT }, data: { description: 'rewritten' } })
      )
    ).rejects.toThrow(APPEND_ONLY);
    // No purge context at all.
    await expect(
      withPlatformDb((db) => db.auditLog.deleteMany({ where: { id: AUDIT } }))
    ).rejects.toThrow(APPEND_ONLY);
    // The tenant is named, but no record of the purge was written.
    await expect(
      withPlatformDb(async (db) => {
        await namePurge(db, ORG, `missing_${suffix}`);
        return db.auditLog.deleteMany({ where: { id: AUDIT } });
      })
    ).rejects.toThrow(APPEND_ONLY);
    // A record of another tenant's purge, a record with no platform actor, and
    // a record with no reason are each refused.
    for (const overrides of [{ organizationId: OTHER_ORG }, { actor: null }, { reason: '  ' }]) {
      await expect(
        withPlatformDb(async (db) => {
          await namePurge(db, ORG, await recordPurge(db, overrides));
          return db.auditLog.deleteMany({ where: { id: AUDIT } });
        })
      ).rejects.toThrow(APPEND_ONLY);
    }
    // A genuine record, but for a different tenant's purge than the row's.
    await expect(
      withPlatformDb(async (db) => {
        await namePurge(db, OTHER_ORG, await recordPurge(db, { organizationId: OTHER_ORG }));
        return db.auditLog.deleteMany({ where: { id: AUDIT } });
      })
    ).rejects.toThrow(APPEND_ONLY);
    expect(await auditRow(AUDIT)).toMatchObject({ description: 'original' });
  });

  it('admits the DELETE only inside a platform purge of the tenant that recorded it first', async () => {
    const deleted = await withPlatformDb(async (db) => {
      await namePurge(db, ORG, await recordPurge(db));
      return db.auditLog.deleteMany({ where: { id: PURGED_AUDIT } });
    });
    expect(deleted.count).toBe(1);
    expect(await auditRow(PURGED_AUDIT)).toBeNull();
  });

  it('keeps the row when its actor is deleted: only the declared ON DELETE SET NULL applies', async () => {
    // Clearing the reference while the user still exists is a rewrite.
    await expect(
      withPlatformDb((db) =>
        db.$executeRawUnsafe(`UPDATE audit_logs SET "actorId" = NULL WHERE id = $1`, AUDIT)
      )
    ).rejects.toThrow(APPEND_ONLY);
    // Deleting the actor runs the declared referential action instead.
    await withPlatformDb((db) =>
      db.$executeRawUnsafe(`DELETE FROM users WHERE id = $1`, DOOMED_USER)
    );
    expect(await auditRow(DOOMED_AUDIT)).toEqual({
      actorId: null,
      actorName: 'Audit Actor',
      actorEmail: 'actor@example.test',
      description: 'original',
    });
    expect(await auditRow(AUDIT)).toMatchObject({ actorId: USER });
  });

  const describeIfOwner = OWNER_DATABASE_URL ? describe : describe.skip;
  describeIfOwner('as the table owner', () => {
    async function asOwner(statement: string) {
      const owner = new pg.Client({ connectionString: OWNER_DATABASE_URL });
      await owner.connect();
      try {
        await owner.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
        await owner.query(statement, statement.includes('$1') ? [AUDIT] : []);
      } finally {
        await owner.end();
      }
    }

    it('refuses UPDATE, DELETE and TRUNCATE', async () => {
      await expect(
        asOwner(`UPDATE audit_logs SET description = 'rewritten' WHERE id = $1`)
      ).rejects.toThrow(APPEND_ONLY);
      await expect(asOwner(`DELETE FROM audit_logs WHERE id = $1`)).rejects.toThrow(APPEND_ONLY);
      await expect(asOwner(`TRUNCATE audit_logs`)).rejects.toThrow(APPEND_ONLY);
      expect(await auditRow(AUDIT)).toMatchObject({ description: 'original' });
    });
  });
});
