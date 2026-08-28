/**
 * WHA-290 — directory provisioning against a REAL PostgreSQL with the composite
 * foreign key in place.
 *
 * This defect class is invisible to a mocked client. `users.department` is a
 * FOREIGN KEY onto `organization_departments (organizationId, key)`, so what has
 * to be proved is not that the code calls Prisma but that the row the identity
 * paths write is ADMISSIBLE:
 *
 *   (a) the pre-fix literal really does raise
 *       `users_organizationId_department_fkey` (23503) in a restaurant tenant —
 *       the bug is real, not theoretical;
 *   (b) the resolved key inserts cleanly in BOTH verticals;
 *   (c) a tenant that removed the vertical default still provisions, on a
 *       department it does have;
 *   (d) a tenant that deactivated every department is refused by name instead of
 *       reaching the constraint.
 *
 * Requires TEST_DATABASE_URL (a migrated throwaway database, never
 * DATABASE_URL) and OWNER_DATABASE_URL to seed the organizations that RLS then
 * hides from each other. Reports itself skipped rather than passing vacuously.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.OWNER_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const agencyOrg = `org_wha290_agency_${suffix}`;
const restaurantOrg = `org_wha290_restaurant_${suffix}`;
/** An agency that deleted ENGINEERING and LEADERSHIP but still has DESIGN. */
const trimmedOrg = `org_wha290_trimmed_${suffix}`;
/** An organization whose every department is inactive. */
const emptyOrg = `org_wha290_empty_${suffix}`;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  resolveProvisionedDepartmentKey: (typeof import('./department-provisioning'))['resolveProvisionedDepartmentKey'];
  EmptyDepartmentCatalogError: (typeof import('./department-provisioning'))['EmptyDepartmentCatalogError'];
  defaultDepartmentRowsForVertical: (typeof import('./vertical-catalog'))['defaultDepartmentRowsForVertical'];
  assertRlsEnforcingRole: (typeof import('./testing/rls-role-guard'))['assertRlsEnforcingRole'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
};

let deps: Deps;
let owner: Client;

/** Create `user` in `organizationId` the way an identity path does. */
async function provision(organizationId: string, role: 'ADMIN' | 'EMPLOYEE', email: string) {
  return deps.withTenantDb(organizationId, async (db: ScopedDb) => {
    const department = await deps.resolveProvisionedDepartmentKey(db, organizationId, role);
    const user = await db.user.create({
      data: {
        organizationId,
        name: email.split('@')[0]!,
        email,
        password: null,
        role,
        department,
        title: role === 'ADMIN' ? 'Organization administrator' : 'Team member',
        status: 'ACTIVE',
      },
      select: { id: true, department: true },
    });
    return user;
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL || !OWNER_DATABASE_URL) return;
  // A runtime role equal to the owner would make the FK proof valid but the
  // tenant scoping vacuous.
  expect(OWNER_DATABASE_URL).not.toBe(TEST_DATABASE_URL);

  deps = {
    withTenantDb: (await import('@/lib/tenancy/scoped-db')).withTenantDb,
    withPlatformDb: (await import('@/lib/tenancy/scoped-db')).withPlatformDb,
    resolveProvisionedDepartmentKey: (await import('./department-provisioning'))
      .resolveProvisionedDepartmentKey,
    EmptyDepartmentCatalogError: (await import('./department-provisioning'))
      .EmptyDepartmentCatalogError,
    defaultDepartmentRowsForVertical: (await import('./vertical-catalog'))
      .defaultDepartmentRowsForVertical,
    assertRlsEnforcingRole: (await import('./testing/rls-role-guard')).assertRlsEnforcingRole,
  };
  // #39 — everything below is decided by RLS-scoped clients, so the runtime role
  // must be neither SUPERUSER nor BYPASSRLS.
  await deps.assertRlsEnforcingRole(deps.withPlatformDb);

  owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  await owner.query('BEGIN');
  await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
  for (const [id, vertical] of [
    [agencyOrg, 'AGENCY'],
    [restaurantOrg, 'RESTAURANT'],
    [trimmedOrg, 'AGENCY'],
    [emptyOrg, 'AGENCY'],
  ] as const) {
    await owner.query(
      `INSERT INTO "organizations"
        ("id", "slug", "legalName", "displayName", "vertical", "status", "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'WHA290', 'WHA290', $3, 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [id, `wha290-${id.slice(-16)}`, vertical]
    );
    // Provisioning seeds this catalog for real organizations; here it stands in
    // for whatever bootstrapOrganization/the seeds would have written.
    for (const department of deps.defaultDepartmentRowsForVertical(vertical)) {
      await owner.query(
        `INSERT INTO "organization_departments"
          ("id", "organizationId", "key", "name", "sortOrder", "active", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, true, CURRENT_TIMESTAMP)`,
        [`dept_${id}_${department.key}`, id, department.key, department.name, department.sortOrder]
      );
    }
  }
  // The trimmed agency keeps only DESIGN; the empty one keeps nothing active.
  await owner.query(
    `DELETE FROM "organization_departments" WHERE "organizationId" = $1 AND "key" <> 'DESIGN'`,
    [trimmedOrg]
  );
  await owner.query(
    `UPDATE "organization_departments" SET "active" = false WHERE "organizationId" = $1`,
    [emptyOrg]
  );
  await owner.query('COMMIT');
}, 60_000);

afterAll(async () => {
  if (!owner) return;
  await owner.query('BEGIN');
  await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
  await owner.query(`DELETE FROM "users" WHERE "organizationId" = ANY($1)`, [
    [agencyOrg, restaurantOrg, trimmedOrg, emptyOrg],
  ]);
  await owner.query(`DELETE FROM "organizations" WHERE "id" = ANY($1)`, [
    [agencyOrg, restaurantOrg, trimmedOrg, emptyOrg],
  ]);
  await owner.query('COMMIT');
  await owner.end();
});

describeIfDatabase('WHA-290 directory provisioning against the composite foreign key', () => {
  it('confirms the pre-fix literal is rejected by the constraint in a restaurant tenant', async () => {
    // This is the defect verbatim: `role === 'ADMIN' ? 'LEADERSHIP' : ...`.
    // A restaurant has KITCHEN and FRONT_OF_HOUSE only.
    await expect(
      deps.withTenantDb(restaurantOrg, (db: ScopedDb) =>
        db.user.create({
          data: {
            organizationId: restaurantOrg,
            name: 'Legacy',
            email: `legacy-${suffix}@restaurant.test`,
            password: null,
            role: 'ADMIN',
            department: 'LEADERSHIP',
            title: 'Organization administrator',
            status: 'ACTIVE',
          },
        })
      )
    ).rejects.toThrow(/users_organizationId_department_fkey|foreign key/i);
  });

  it('provisions a restaurant tenant on a department that tenant has', async () => {
    const admin = await provision(restaurantOrg, 'ADMIN', `admin-${suffix}@restaurant.test`);
    const member = await provision(restaurantOrg, 'EMPLOYEE', `cook-${suffix}@restaurant.test`);

    expect(admin.department).toBe('FRONT_OF_HOUSE');
    expect(member.department).toBe('FRONT_OF_HOUSE');
    // The rows are really there — the FK admitted them.
    const stored = await deps.withTenantDb(restaurantOrg, (db: ScopedDb) =>
      db.user.findMany({ where: { id: { in: [admin.id, member.id] } }, select: { id: true } })
    );
    expect(stored).toHaveLength(2);
  });

  it('keeps the agency defaults an agency tenant still has', async () => {
    const admin = await provision(agencyOrg, 'ADMIN', `admin-${suffix}@agency.test`);
    const member = await provision(agencyOrg, 'EMPLOYEE', `dev-${suffix}@agency.test`);

    expect(admin.department).toBe('LEADERSHIP');
    expect(member.department).toBe('ENGINEERING');
  });

  it('provisions on a surviving department when the tenant removed the defaults', async () => {
    const admin = await provision(trimmedOrg, 'ADMIN', `admin-${suffix}@trimmed.test`);
    const member = await provision(trimmedOrg, 'EMPLOYEE', `dev-${suffix}@trimmed.test`);

    expect(admin.department).toBe('DESIGN');
    expect(member.department).toBe('DESIGN');
  });

  it('refuses by name, not by constraint, when every department is inactive', async () => {
    await expect(
      provision(emptyOrg, 'EMPLOYEE', `nobody-${suffix}@empty.test`)
    ).rejects.toBeInstanceOf(deps.EmptyDepartmentCatalogError);
    await expect(provision(emptyOrg, 'EMPLOYEE', `nobody-${suffix}@empty.test`)).rejects.toThrow(
      'no active department'
    );
  });

  it('never resolves another organization catalog', async () => {
    // The restaurant tenant's scope cannot see the agency's LEADERSHIP row, so
    // resolution stays inside the tenant even though both catalogs exist.
    const key = await deps.withTenantDb(restaurantOrg, (db: ScopedDb) =>
      deps.resolveProvisionedDepartmentKey(db, restaurantOrg, 'ADMIN')
    );
    expect(['KITCHEN', 'FRONT_OF_HOUSE']).toContain(key);
  });
});
