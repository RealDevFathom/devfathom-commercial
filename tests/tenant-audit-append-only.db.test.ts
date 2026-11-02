/** @vitest-environment node */
/**
 * DEV-155 (#620): the tenant audit ledger is append-only.
 *
 * Row-level security keeps one tenant out of another's audit rows; this proves
 * the tenant cannot rewrite or erase its OWN rows either, and that the three
 * schema-level exceptions still work: the ON DELETE SET NULL of a deleted
 * actor, the retention purge of exactly this tenant under the platform
 * transaction, and an orphaned row of an organization that no longer exists.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database reached through
 * the NOSUPERUSER NOBYPASSRLS application role). Skipped without it.
 */
import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';
import { seedDepartments } from '@/lib/test-support/departments';
import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

// Hand the adapter a connection string rather than `@/lib/db`'s own pool: under
// Vitest the two resolve to different copies of `pg` (see jobs.purge.db.test.ts).
vi.mock('@/lib/db', () => ({
  db: new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }),
    log: ['error'],
  }),
}));

const suffix = randomBytes(6).toString('hex');
const ORG = `tenant_audit_${suffix}`;
const OTHER_ORG = `tenant_audit_other_${suffix}`;
const ACTOR = `tenant_audit_actor_${suffix}`;
const DEPARTED = `tenant_audit_departed_${suffix}`;
const ROW = `tenant_audit_row_${suffix}`;
const DEPARTED_ROW = `tenant_audit_departed_row_${suffix}`;
const PURGED_ROW = `tenant_audit_purged_row_${suffix}`;

type Scoped = typeof import('@/lib/tenancy/scoped-db');
let withTenantDb: Scoped['withTenantDb'];
let withPlatformDb: Scoped['withPlatformDb'];

const user = (id: string, organizationId: string) => ({
  id,
  organizationId,
  email: `${id}@example.test`,
  name: id,
  title: 'Pharmacist',
  department: 'ENGINEERING' as const,
  role: 'ADMIN' as const,
  status: 'ACTIVE' as const,
});

const auditRow = (id: string, organizationId: string, actorId: string | null) => ({
  id,
  organizationId,
  actorId,
  source: 'SYSTEM' as const,
  category: 'SYSTEM',
  action: 'test.append-only',
  targetType: 'Test',
  targetId: id,
});

const describeIfDatabase = url ? describe : describe.skip;

describeIfDatabase('tenant audit ledger is append-only, against PostgreSQL', () => {
  beforeAll(async () => {
    ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
    await assertRlsEnforcingRole(withPlatformDb);
    await withPlatformDb(async (db) => {
      for (const id of [ORG, OTHER_ORG]) {
        await db.organization.create({
          data: { id, slug: id.replaceAll('_', '-'), legalName: id, displayName: id },
        });
      }
      await seedDepartments(db, [ORG, OTHER_ORG], ['ENGINEERING']);
      await db.user.create({ data: user(ACTOR, ORG) });
      await db.user.create({ data: user(DEPARTED, ORG) });
    });
    await withTenantDb(ORG, async (db) => {
      await db.auditLog.create({ data: auditRow(ROW, ORG, ACTOR) });
      await db.auditLog.create({ data: auditRow(DEPARTED_ROW, ORG, DEPARTED) });
    });
    await withTenantDb(OTHER_ORG, async (db) => {
      await db.auditLog.create({ data: auditRow(PURGED_ROW, OTHER_ORG, null) });
    });
  }, 60_000);

  afterAll(async () => {
    // The organization row goes first: once it is gone its remaining history is
    // orphaned and the guard admits the delete.
    if (withPlatformDb) {
      await withPlatformDb(async (db) => {
        await db.user.deleteMany({ where: { organizationId: ORG } });
        await db.organizationDepartment.deleteMany({
          where: { organizationId: { in: [ORG, OTHER_ORG] } },
        });
        await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
        await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG, OTHER_ORG] } } });
      });
    }
    await (await import('@/lib/db')).db.$disconnect();
  }, 60_000);

  const stored = () =>
    withPlatformDb((db) =>
      db.auditLog.findUnique({
        where: { id: ROW },
        select: { action: true, actorId: true },
      })
    );

  it('refuses a tenant rewriting its own audit row', async () => {
    await expect(
      withTenantDb(
        ORG,
        (db) => db.$executeRaw`UPDATE audit_logs SET action = 'tampered' WHERE id = ${ROW}`
      )
    ).rejects.toThrow(/append-only/);
    await expect(stored()).resolves.toEqual({ action: 'test.append-only', actorId: ACTOR });
  });

  it('refuses a tenant deleting its own audit row', async () => {
    await expect(
      withTenantDb(ORG, (db) => db.$executeRaw`DELETE FROM audit_logs WHERE id = ${ROW}`)
    ).rejects.toThrow(/append-only/);
    await expect(stored()).resolves.not.toBeNull();
  });

  it('refuses the purge name alone in a tenant-runtime transaction', async () => {
    await expect(
      withTenantDb(ORG, async (db) => {
        await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${ORG}, true)`;
        await db.$executeRaw`DELETE FROM audit_logs WHERE id = ${ROW}`;
      })
    ).rejects.toThrow(/append-only/);
    await expect(stored()).resolves.not.toBeNull();
  });

  it('refuses the platform transaction without the purge name, or naming another tenant', async () => {
    for (const purging of [null, OTHER_ORG]) {
      await expect(
        withPlatformDb(async (db) => {
          if (purging) {
            await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${purging}, true)`;
          }
          await db.$executeRaw`UPDATE audit_logs SET action = 'tampered' WHERE id = ${ROW}`;
        })
      ).rejects.toThrow(/append-only/);
    }
    await expect(stored()).resolves.toEqual({ action: 'test.append-only', actorId: ACTOR });
  });

  it('refuses clearing the actor of a row whose actor still exists', async () => {
    await expect(
      withTenantDb(
        ORG,
        (db) => db.$executeRaw`UPDATE audit_logs SET "actorId" = NULL WHERE id = ${ROW}`
      )
    ).rejects.toThrow(/append-only/);
    await expect(stored()).resolves.toEqual({ action: 'test.append-only', actorId: ACTOR });
  });

  it('keeps the row when its actor is deleted, through the declared ON DELETE SET NULL', async () => {
    await withPlatformDb((db) => db.user.delete({ where: { id: DEPARTED } }));
    await expect(
      withPlatformDb((db) =>
        db.auditLog.findUnique({
          where: { id: DEPARTED_ROW },
          select: { action: true, actorId: true },
        })
      )
    ).resolves.toEqual({ action: 'test.append-only', actorId: null });
  });

  it('admits the retention purge of exactly the named tenant', async () => {
    const deleted = await withPlatformDb(async (db) => {
      await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${OTHER_ORG}, true)`;
      return db.$executeRaw`DELETE FROM audit_logs WHERE "organizationId" = ${OTHER_ORG}`;
    });
    expect(deleted).toBe(1);
    await expect(stored()).resolves.not.toBeNull();
  });

  it('still accepts new audit rows', async () => {
    const id = `${ROW}_new`;
    await withTenantDb(ORG, (db) => db.auditLog.create({ data: auditRow(id, ORG, ACTOR) }));
    await expect(withPlatformDb((db) => db.auditLog.count({ where: { id } }))).resolves.toBe(1);
  });
});
