/**
 * Runs the branch-assignment backfill as the migrator: LOGIN, NOSUPERUSER,
 * NOBYPASSRLS. The transaction starts with the platform-admin flag off, so the
 * migration's own set_config is what lets the INSERT see every organization.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrationSql, splitSqlStatements } from './split-sql-statements';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261021133000_pharmacy_branch_assignment_backfill/migration.sql'
  ),
  'utf8'
);

const orgA = `org_pba_a_${suffix}`;
const orgB = `org_pba_b_${suffix}`;
const orgIdle = `org_pba_idle_${suffix}`;
const orgGap = `org_pba_gap_${suffix}`;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let db: typeof import('@/lib/db').db;
let disconnect: (() => Promise<void>) | null = null;

async function seedOrg(input: {
  id: string;
  status: 'ACTIVE' | 'ONBOARDING';
  userStatus: 'ACTIVE' | 'INACTIVE';
  withBranch: boolean;
}) {
  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', $2::"OrganizationStatus", 'SHARED', now(), now())`,
      input.id,
      input.status
    )
  );
  await withTenantDb(input.id, async (tx) => {
    const { seedDepartments } = await import('@/lib/test-support/departments');
    await seedDepartments(tx, [input.id], ['LEADERSHIP']);
    const roleId = `role_${input.id}`;
    await tx.organizationRole.create({
      data: {
        id: roleId,
        key: `cashier-${input.id}`,
        name: 'Cashier',
        permissions: { create: [{ capability: 'pharmacy.counter', effect: 'ALLOW' }] },
      },
    });
    await tx.user.create({
      data: {
        id: `user_${input.id}`,
        name: 'Cashier',
        email: `user_${input.id}@example.test`,
        department: 'LEADERSHIP',
        title: 'Cashier',
        status: input.userStatus,
        organizationRoleId: roleId,
      },
    });
    if (input.withBranch) {
      await tx.pharmacyBranch.create({
        data: {
          id: `br_${input.id}`,
          code: 'A',
          name: 'Counter',
          addressLine: '1 Road',
          city: 'Lahore',
          provinceCode: 'PB',
        },
      });
    }
  });
}

async function assignmentCount(organizationId: string, userId: string) {
  return withTenantDb(organizationId, (tx) =>
    tx.pharmacyBranchAssignment.count({ where: { organizationId, userId } })
  );
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const client = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  db = client.db;
  disconnect = () => db.$disconnect();
});

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('pharmacy branch assignment backfill as the migrator', () => {
  it('assigns eligible members when the runtime cannot bypass row level security', async () => {
    const [role] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    expect(splitSqlStatements(sql)).toHaveLength(3);

    await seedOrg({ id: orgA, status: 'ACTIVE', userStatus: 'ACTIVE', withBranch: true });
    await seedOrg({ id: orgB, status: 'ACTIVE', userStatus: 'ACTIVE', withBranch: true });
    await seedOrg({ id: orgIdle, status: 'ACTIVE', userStatus: 'INACTIVE', withBranch: true });

    const apply = () =>
      db.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT set_config('app.is_platform_admin', 'false', true),
                    set_config('app.current_organization_id', '', true)`
          );
          await runMigrationSql(tx, sql);
        },
        { timeout: 60_000 }
      );

    await apply();
    await apply();

    expect(await assignmentCount(orgA, `user_${orgA}`)).toBe(1);
    expect(await assignmentCount(orgB, `user_${orgB}`)).toBe(1);
    expect(await assignmentCount(orgIdle, `user_${orgIdle}`)).toBe(0);
  });

  it('raises when an active pharmacy organization with eligible members has no assignments', async () => {
    await seedOrg({ id: orgGap, status: 'ACTIVE', userStatus: 'ACTIVE', withBranch: true });
    const guard = splitSqlStatements(sql).at(-1);
    expect(guard).toContain('RAISE EXCEPTION');
    await expect(
      db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT set_config('app.is_platform_admin', 'false', true),
                  set_config('app.current_organization_id', '', true)`
        );
        await tx.$queryRawUnsafe("SELECT set_config('app.is_platform_admin', 'true', true)");
        await tx.$executeRawUnsafe(guard!);
      })
    ).rejects.toThrow(/eligible members and no assignments/);
    expect(await assignmentCount(orgGap, `user_${orgGap}`)).toBe(0);
  });
});
