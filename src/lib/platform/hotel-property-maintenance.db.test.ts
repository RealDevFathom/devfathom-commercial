/**
 * PROP-04 G3/G5 — the completed property-access policy set under real, forced
 * row-level security.
 *
 * `hotel-property-maintenance.test.ts` proves what the application refuses. This
 * file proves what PostgreSQL refuses, which is a different claim and the only
 * one that survives a crafted connection: the mock suite cannot tell you whether
 * `hotel_properties` is genuinely unreadable without an assignment, only that the
 * resolver would have said no.
 *
 * Five things are asserted, and they fail in different places on purpose:
 *
 *  - the control plane can create a property and read it back in the same
 *    statement (`INSERT ... RETURNING`). That is the circularity the completed
 *    policy exists to break, and before `20260915010000_hotel_property_maintenance`
 *    it failed — which is why provisioning is exercised here and not only in mocks;
 *  - a tenant user with no assignment cannot see an active property, and the same
 *    user can see it the moment an assignment exists. Same connection, same query,
 *    one row difference;
 *  - an INACTIVE property stays denied to the tenant even with a live assignment,
 *    which is what makes deactivation an access decision rather than a flag;
 *  - the tenant cannot self-grant, cannot bootstrap an assignment at a branch it
 *    does not already hold, and cannot DELETE one at all; and
 *  - the control-plane escape is exactly one GUC, and `withTenantDb` pins it to
 *    'false', so no tenant path can reach it.
 *
 * Assignment rows are written with raw SQL rather than through Prisma on purpose:
 * the `HotelPropertyAssignment` delegate is not in the generated client yet (G4),
 * and this file is about what the database enforces, so it should not be blocked
 * on client generation. Properties use the Prisma delegate, which does exist.
 *
 * Skipped (never silently passed) when the database URL is absent. Authored in
 * this phase; execution against a real cluster is held for G5.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { seedDepartments } from '@/lib/test-support/departments';

const TEST_DATABASE_URL =
  process.env.HOTEL_PROPERTY_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const OWNER_DATABASE_URL = process.env.HOTEL_PROPERTY_TEST_OWNER_DATABASE_URL;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const describeIfOwner = TEST_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_hpm_a_${suffix}`;
const ORG_B = `org_hpm_b_${suffix}`;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
};
let deps: Deps;

/** As a tenant user — organization GUC set, `app.current_user_id` set. */
function asUser<T>(
  organizationId: string,
  userId: string,
  work: (db: ScopedDb) => Promise<T>
): Promise<T> {
  return deps.withTenantDb(organizationId, work, { userId });
}

/** As the control plane — `app.is_platform_admin = 'true'`, no tenant, no user. */
function asPlatform<T>(work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withPlatformDb(work);
}

/**
 * One assignment row, written as raw SQL so this file does not wait on the
 * generated delegate. `id` and `updatedAt` are supplied because the column has no
 * database default — Prisma's `@updatedAt` is client-side.
 */
function insertAssignmentSql(active = true) {
  return `INSERT INTO "hotel_property_assignments"
            ("id", "organizationId", "branchId", "userId", "organizationRoleId", "active", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, ${active ? 'true' : 'false'}, CURRENT_TIMESTAMP)`;
}

let propertyA: { branchId: string } | undefined;
let propertyB: { branchId: string } | undefined;

const USER_A = `user_hpm_a_${suffix}`;
const USER_A2 = `user_hpm_a2_${suffix}`;
const ROLE_A = `role_hpm_a_${suffix}`;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  deps = { withTenantDb: scoped.withTenantDb, withPlatformDb: scoped.withPlatformDb };

  // Everything is created through the control plane, because after PROP-04 a
  // tenant connection cannot create the first property of its own organization —
  // that is the point of the restrictive policy, not a limitation of the fixture.
  await asPlatform(async (db) => {
    for (const [organizationId, slug] of [
      [ORG_A, `hpm-a-${suffix}`],
      [ORG_B, `hpm-b-${suffix}`],
    ] as const) {
      await db.organization.create({
        data: {
          id: organizationId,
          slug,
          legalName: `Hotel ${slug}`,
          displayName: `Hotel ${slug}`,
          vertical: 'HOSPITALITY',
          status: 'ACTIVE',
          primaryContactName: 'Ops',
          primaryContactEmail: `ops@${slug}.test`,
        },
      });
    }
    // WHA-278: `User.department` is half a composite foreign key onto
    // `organization_departments(organizationId, key)`, so the two actors below
    // cannot be written until ORG_A's catalog holds the key they are filed
    // under. Provisioning seeds the whole vertical catalog; a fixture seeds only
    // the key it uses. `FRONT_OFFICE` is a real HOSPITALITY key, not an invented
    // one, so this is the same row shape production writes. Only ORG_A is seeded
    // — ORG_B is the foreign tenant here and deliberately holds no user.
    await seedDepartments(db, [ORG_A], ['FRONT_OFFICE']);
    await db.organizationRole.create({
      data: {
        id: ROLE_A,
        organizationId: ORG_A,
        key: 'general-manager',
        name: 'General Manager',
        isSystem: true,
      },
    });
    for (const id of [USER_A, USER_A2]) {
      await db.user.create({
        data: {
          id,
          organizationId: ORG_A,
          organizationRoleId: ROLE_A,
          name: id,
          email: `${id}@example.test`,
          password: 'x',
          department: 'FRONT_OFFICE',
          title: 'General Manager',
          role: 'EMPLOYEE',
          status: 'ACTIVE',
        },
      });
    }
  });
});

describeIfDatabase('control-plane property creation', () => {
  it('creates a property and reads it back in the same statement', async () => {
    // The circularity: the restrictive policy requires an assignment before a
    // property is readable, and the first assignment cannot exist before the
    // property does. `INSERT ... RETURNING` is filtered by the same expression it
    // is checked against, so this one call proves both halves of the escape.
    propertyA = await asPlatform((db) =>
      db.hotelProperty.create({
        data: {
          organizationId: ORG_A,
          name: 'Property A',
          addressLine: '12 Main Boulevard',
          city: 'Lahore',
          timezone: 'Asia/Karachi',
          bookingEngineSlug: `hpm-a-${suffix}`,
        },
      })
    );
    expect(propertyA!.branchId).toBeTruthy();

    propertyB = await asPlatform((db) =>
      db.hotelProperty.create({
        data: {
          organizationId: ORG_B,
          name: 'Property B',
          addressLine: '9 Sea View',
          city: 'Karachi',
          timezone: 'Asia/Karachi',
          bookingEngineSlug: `hpm-b-${suffix}`,
        },
      })
    );
  });

  it('writes the first assignment of a property’s life', async () => {
    await asPlatform((db) =>
      db.$executeRawUnsafe(
        insertAssignmentSql(),
        `hpa_${suffix}`,
        ORG_A,
        propertyA!.branchId,
        USER_A,
        ROLE_A
      )
    );
    const rows = await asPlatform((db) =>
      db.$queryRawUnsafe<Array<{ userId: string }>>(
        `SELECT "userId" FROM "hotel_property_assignments" WHERE "organizationId" = $1`,
        ORG_A
      )
    );
    expect(rows.map((row) => row.userId)).toEqual([USER_A]);
  });
});

describeIfDatabase('tenant access is assignment-scoped', () => {
  it('denies an active property to a user with no assignment', async () => {
    const seen = await asUser(ORG_A, USER_A2, (db) => db.hotelProperty.findMany({}));
    expect(seen).toEqual([]);

    // Addressed by primary key — the id is correct and belongs to this very
    // organization, so only the assignment predicate can be what withholds it.
    const direct = await asUser(ORG_A, USER_A2, (db) =>
      db.hotelProperty.findUnique({ where: { branchId: propertyA!.branchId } })
    );
    expect(direct).toBeNull();
  });

  it('grants the same query to the assigned user', async () => {
    const seen = await asUser(ORG_A, USER_A, (db) => db.hotelProperty.findMany({}));
    expect(seen.map((row) => row.branchId)).toEqual([propertyA!.branchId]);
  });

  it('denies a revoked assignment', async () => {
    await asPlatform((db) =>
      db.$executeRawUnsafe(
        `UPDATE "hotel_property_assignments" SET "active" = false WHERE "organizationId" = $1 AND "userId" = $2`,
        ORG_A,
        USER_A
      )
    );
    const seen = await asUser(ORG_A, USER_A, (db) => db.hotelProperty.findMany({}));
    expect(seen).toEqual([]);

    await asPlatform((db) =>
      db.$executeRawUnsafe(
        `UPDATE "hotel_property_assignments" SET "active" = true WHERE "organizationId" = $1 AND "userId" = $2`,
        ORG_A,
        USER_A
      )
    );
  });

  it('denies a departed user even while the assignment stands', async () => {
    await asPlatform((db) =>
      db.user.update({ where: { id: USER_A }, data: { status: 'INACTIVE' } })
    );
    const seen = await asUser(ORG_A, USER_A, (db) => db.hotelProperty.findMany({}));
    expect(seen).toEqual([]);

    await asPlatform((db) => db.user.update({ where: { id: USER_A }, data: { status: 'ACTIVE' } }));
  });

  it('denies another tenant’s property to an assigned user', async () => {
    const stolen = await asUser(ORG_A, USER_A, (db) =>
      db.hotelProperty.findUnique({ where: { branchId: propertyB!.branchId } })
    );
    expect(stolen).toBeNull();
  });

  it('denies an INACTIVE property to its own assigned user', async () => {
    // Deactivation is an access decision, not a display flag: the restrictive
    // policy's own `"active"` predicate is what closes the property, and it is
    // also why nothing inside the tenant can reopen it.
    await asPlatform((db) =>
      db.hotelProperty.update({ where: { branchId: propertyA!.branchId }, data: { active: false } })
    );
    const seen = await asUser(ORG_A, USER_A, (db) => db.hotelProperty.findMany({}));
    expect(seen).toEqual([]);

    const raised = await asUser(ORG_A, USER_A, (db) =>
      db.hotelProperty.updateMany({
        where: { branchId: propertyA!.branchId },
        data: { active: true },
      })
    );
    expect(raised.count).toBe(0);

    // Only the control plane can bring it back.
    await asPlatform((db) =>
      db.hotelProperty.update({ where: { branchId: propertyA!.branchId }, data: { active: true } })
    );
    const restored = await asUser(ORG_A, USER_A, (db) => db.hotelProperty.findMany({}));
    expect(restored.map((row) => row.branchId)).toEqual([propertyA!.branchId]);
  });
});

describeIfDatabase('tenant assignment writes stay narrow', () => {
  it('refuses a self-grant', async () => {
    await expect(
      asUser(ORG_A, USER_A2, (db) =>
        db.$executeRawUnsafe(
          insertAssignmentSql(),
          `hpa_self_${suffix}`,
          ORG_A,
          propertyA!.branchId,
          USER_A2,
          ROLE_A
        )
      )
    ).rejects.toThrow();
  });

  it('refuses a grant from someone who holds no assignment at that branch', async () => {
    await expect(
      asUser(ORG_A, USER_A2, (db) =>
        db.$executeRawUnsafe(
          insertAssignmentSql(),
          `hpa_boot_${suffix}`,
          ORG_A,
          propertyA!.branchId,
          USER_A,
          ROLE_A
        )
      )
    ).rejects.toThrow();
  });

  it('allows an assigned user to delegate to a colleague', async () => {
    await asUser(ORG_A, USER_A, (db) =>
      db.$executeRawUnsafe(
        insertAssignmentSql(),
        `hpa_deleg_${suffix}`,
        ORG_A,
        propertyA!.branchId,
        USER_A2,
        ROLE_A
      )
    );
    const seen = await asUser(ORG_A, USER_A2, (db) => db.hotelProperty.findMany({}));
    expect(seen.map((row) => row.branchId)).toEqual([propertyA!.branchId]);
  });

  it('has no DELETE policy for anyone, so access is revoked and never erased', async () => {
    const tenantDeleted = await asUser(ORG_A, USER_A, (db) =>
      db.$executeRawUnsafe(
        `DELETE FROM "hotel_property_assignments" WHERE "organizationId" = $1 AND "userId" = $2`,
        ORG_A,
        USER_A2
      )
    );
    expect(tenantDeleted).toBe(0);

    const platformDeleted = await asPlatform((db) =>
      db.$executeRawUnsafe(
        `DELETE FROM "hotel_property_assignments" WHERE "organizationId" = $1 AND "userId" = $2`,
        ORG_A,
        USER_A2
      )
    );
    expect(platformDeleted).toBe(0);
  });
});

describeIfOwner('the control-plane escape is exactly one GUC', () => {
  const owner = new pg.Client({ connectionString: OWNER_DATABASE_URL });

  beforeAll(async () => {
    const parsed = new URL(OWNER_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run hotel RLS probes against a non-local database.');
    }
    await owner.connect();
  }, 60_000);

  afterAll(async () => {
    await owner.end();
  });

  it('filters the owning role with no flag, which is what FORCE means', async () => {
    await owner.query(`SELECT set_config('app.is_platform_admin', 'false', false)`);
    await owner.query(`SELECT set_config('app.current_organization_id', $1, false)`, [ORG_A]);
    const denied = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "hotel_properties"`
    );
    // The organization is correct and the row exists; no user, no assignment, no
    // flag, so the restrictive policy withholds it from the table owner too.
    expect(denied.rows[0]!.count).toBe('0');

    await owner.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    const admitted = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "hotel_properties" WHERE "organizationId" = $1`,
      [ORG_A]
    );
    expect(admitted.rows[0]!.count).toBe('1');
    await owner.query(`SELECT set_config('app.is_platform_admin', 'false', false)`);
  });

  it('keeps the restrictive policy restrictive and the platform policies permissive', async () => {
    const policies = await owner.query<{ policyname: string; permissive: string; cmd: string }>(
      `SELECT policyname, permissive, cmd
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename IN ('hotel_properties', 'hotel_property_assignments')
        ORDER BY policyname`
    );
    const byName = new Map(policies.rows.map((row) => [row.policyname, row]));
    // A permissive policy here would be ORed with the tenant-isolation one and
    // would grant, not restrict — the whole guarantee depends on this word.
    expect(byName.get('hotel_properties_assigned_user')?.permissive).toBe('RESTRICTIVE');
    for (const name of [
      'hotel_property_assignments_platform_read',
      'hotel_property_assignments_platform_insert',
      'hotel_property_assignments_platform_update',
    ]) {
      expect(byName.get(name)?.permissive, name).toBe('PERMISSIVE');
    }
    expect([...byName.keys()]).not.toContain('hotel_property_assignments_platform_delete');
  });

  it('leaves no property without an ELIGIBLE assignment, which is what the cutover guard pins', async () => {
    await owner.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    // Byte-for-byte the predicate `20260915010000_hotel_property_maintenance`'s
    // guard runs. "Eligible" is the restrictive policy's own tenant branch — an
    // ACTIVE assignment held by an ACTIVE/ON_LEAVE user — not the mere presence
    // of a row: an assignment held by someone who has left grants nothing, so
    // counting it would let the guard pass on a database it is about to strand.
    const stranded = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM "hotel_properties" property
        WHERE NOT EXISTS (
          SELECT 1
            FROM "hotel_property_assignments" assignment
            JOIN "users" actor ON actor."organizationId" = assignment."organizationId"
             AND actor."id" = assignment."userId"
           WHERE assignment."organizationId" = property."organizationId"
             AND assignment."branchId" = property."branchId"
             AND assignment."active"
             AND actor."status" IN ('ACTIVE', 'ON_LEAVE')
        )`
    );
    await owner.query(`SELECT set_config('app.is_platform_admin', 'false', false)`);
    // ORG_B's property is deliberately unassigned, so this asserts the guard's
    // own query finds it. A database in this state is what the migration refuses
    // to roll the restrictive policy onto.
    expect(Number(stranded.rows[0]!.count)).toBeGreaterThan(0);
  });

  it('sees the platform assignment policies the additive migration installs', async () => {
    // These three moved into `20260915003000_hotel_property_access` in the F-A
    // re-split: the table is FORCE RLS, so without them nothing could write a
    // mapping between the additive migration and the cutover, and the documented
    // pre-cutover operator step would be unexecutable. Asserted as reachable, not
    // merely present — a policy that exists but does not admit the control plane
    // would leave the same gap.
    await owner.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    const readable = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "hotel_property_assignments" WHERE "organizationId" = $1`,
      [ORG_A]
    );
    expect(Number(readable.rows[0]!.count)).toBeGreaterThan(0);

    await owner.query(`SELECT set_config('app.is_platform_admin', 'false', false)`);
    await owner.query(`SELECT set_config('app.current_organization_id', '', false)`);
    const denied = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "hotel_property_assignments"`
    );
    // No flag, no tenant, no user: FORCE RLS filters the owning role here too.
    expect(denied.rows[0]!.count).toBe('0');
  });
});
