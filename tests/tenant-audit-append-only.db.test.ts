/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

vi.mock('@/lib/db', () => ({
  db: new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }),
}));

const describeIfDatabase = url ? describe : describe.skip;
const suffix = randomUUID();
const tenants = [`audit-a-${suffix}`, `audit-b-${suffix}`];

describeIfDatabase('tenant audit append-only guarantees on disposable PostgreSQL', () => {
  afterAll(async () => {
    await (await import('@/lib/db')).db.$disconnect();
  });

  it('keeps both tenants immutable while actor deletion preserves attribution', async () => {
    const { withPlatformDb, withTenantDb } = await import('@/lib/tenancy/scoped-db');

    await withPlatformDb(async (db) => {
      for (const organizationId of tenants) {
        const userId = `user-${organizationId}`;
        const staffId = `staff-${organizationId}`;
        await db.$executeRawUnsafe(
          `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
           VALUES ($1, $1, $1, $1, now())`,
          organizationId
        );
        await db.$executeRawUnsafe(
          `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
           VALUES ($1, $2, 'test', 'Test', now())`,
          `department-${organizationId}`,
          organizationId
        );
        await db.$executeRawUnsafe(
          `INSERT INTO users (id, "organizationId", name, email, department, title, "updatedAt")
           VALUES ($1, $2, 'Actor', $3, 'test', 'Tester', now())`,
          userId,
          organizationId,
          `${userId}@example.invalid`
        );
        await db.$executeRawUnsafe(
          `INSERT INTO restaurant_staff_profiles
             (id, "organizationId", "displayName", "updatedAt") VALUES ($1, $2, 'Operator', now())`,
          staffId,
          organizationId
        );
        await db.$executeRawUnsafe(
          `INSERT INTO audit_logs
             (id, "organizationId", "actorType", "actorId", source, category, action)
           VALUES ($1, $2, 'USER', $3, 'SYSTEM', 'TEST', 'test.user')`,
          `audit-user-${organizationId}`,
          organizationId,
          userId
        );
        await db.$executeRawUnsafe(
          `INSERT INTO audit_logs
             (id, "organizationId", "actorType", "actorStaffProfileId", source, category, action)
           VALUES ($1, $2, 'RESTAURANT_OPERATOR', $3, 'SYSTEM', 'TEST', 'test.staff')`,
          `audit-staff-${organizationId}`,
          organizationId,
          staffId
        );
      }
    });

    await expect(
      withTenantDb(tenants[0], (db) =>
        db.$executeRawUnsafe(
          `INSERT INTO audit_logs
             (id, "organizationId", "actorType", "actorId", source, category, action)
           VALUES ($1, $2, 'USER', $3, 'SYSTEM', 'TEST', 'test.cross-tenant')`,
          `audit-cross-${suffix}`,
          tenants[0],
          `user-${tenants[1]}`
        )
      )
    ).rejects.toThrow(/same tenant/);

    for (const organizationId of tenants) {
      for (const statement of [
        `UPDATE audit_logs SET action = 'tampered' WHERE "organizationId" = $1`,
        `DELETE FROM audit_logs WHERE "organizationId" = $1`,
      ]) {
        await expect(
          withTenantDb(organizationId, (db) => db.$executeRawUnsafe(statement, organizationId))
        ).rejects.toThrow(/append-only/);
      }

      const actorIds = await withTenantDb(organizationId, async (db) => {
        await db.$executeRawUnsafe(`DELETE FROM users WHERE id = $1`, `user-${organizationId}`);
        await db.$executeRawUnsafe(
          `DELETE FROM restaurant_staff_profiles WHERE id = $1`,
          `staff-${organizationId}`
        );
        return db.$queryRawUnsafe<{ actorId: string | null; actorStaffProfileId: string | null }[]>(
          `SELECT "actorId", "actorStaffProfileId" FROM audit_logs ORDER BY action`
        );
      });

      expect(actorIds).toEqual([
        { actorId: null, actorStaffProfileId: `staff-${organizationId}` },
        { actorId: `user-${organizationId}`, actorStaffProfileId: null },
      ]);
    }
  });
});
