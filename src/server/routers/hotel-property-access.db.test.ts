// @vitest-environment node
/**
 * PROP-04 missing G5 coverage. Four real-DB cases across three coverage groups.
 * Requires the existing Hotel migrations and generated client. Missing runtime
 * URL skips the suite; the FORCE-RLS/cascade case also requires the owner URL.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { seedDepartments } from '@/lib/test-support/departments';
import type { TRPCContext } from '@/server/trpc';

// The unrelated fire-and-forget audit sink is suppressed. Router middleware,
// annotation, ABAC, persisted scope, transactions and all SQL remain real.
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));

// `resolveTenantActor` is reached only from `createTRPCContext`; these cases build
// the request context by hand and call `createCaller`, so the seam is unused here.
// Stubbing it at the same seam the sibling router suites use keeps Auth.js out of
// the router import graph — `next@16` ships no extensionless `next/server`, which
// Node's ESM resolver cannot resolve for `next-auth`. It throws rather than
// returning a dummy actor, so a case that ever does need it fails loudly instead
// of silently bypassing authorization.
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: vi.fn(() => {
    throw new Error('resolveTenantActor must not be reached by a hand-built tRPC context.');
  }),
}));

const TEST_DATABASE_URL =
  process.env.HOTEL_PROPERTY_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.HOTEL_PROPERTY_TEST_OWNER_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG = `org_hpa_gap_${suffix}`;
const ROLE = `role_hpa_gap_${suffix}`;
const USER_A = `user_hpa_a_${suffix}`;
const USER_B = `user_hpa_b_${suffix}`;
const MANAGER = `user_hpa_manager_${suffix}`;
const TARGET = `user_hpa_target_${suffix}`;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  hotelPropertyRouter: (typeof import('./hotel-property'))['hotelPropertyRouter'];
  db: (typeof import('@/lib/db'))['db'];
};
let deps: Deps | undefined;
let observer: pg.Client | undefined;
let owner: pg.Client | undefined;
let propertyA: { branchId: string };
let propertyB: { branchId: string };

function asUser<T>(userId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps!.withTenantDb(ORG, work, { userId, maxWait: 5_000, timeout: 20_000 });
}

function asPlatform<T>(work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps!.withPlatformDb(work);
}

function caller(db: ScopedDb) {
  // Same request-context shape as hotel-property-access.test.ts, with the real
  // transaction facade. EMPLOYEE must obtain both grants from persisted rows.
  const ctx = {
    db,
    entitlements: { organizationId: ORG, enabledModules: ['hotel-core'], modules: [] },
    session: {
      expires: 'later',
      user: { id: MANAGER, organizationId: ORG, role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return deps!.hotelPropertyRouter.createCaller(ctx);
}

async function propertyFixture(label: string, userId: string) {
  return asPlatform(async (db) => {
    const property = await db.hotelProperty.create({
      data: {
        organizationId: ORG,
        name: `Property ${label}`,
        addressLine: '12 Main Boulevard',
        city: 'Lahore',
        timezone: 'Asia/Karachi',
        bookingEngineSlug: `hpa-gap-${label}-${suffix}`,
        active: true,
      },
    });
    await db.hotelPropertyAssignment.create({
      data: {
        organizationId: ORG,
        branchId: property.branchId,
        userId,
        organizationRoleId: ROLE,
        active: true,
      },
    });
    return property;
  });
}

describeIfDatabase('Hotel property access missing G5 database coverage', () => {
  beforeAll(async () => {
    // Validate both URLs before importing the DB singleton or opening a socket.
    // Do not echo credentials, accept remote overrides, or create/grant roles.
    for (const value of [TEST_DATABASE_URL, OWNER_DATABASE_URL]) {
      if (!value) continue;
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error('Invalid Hotel test database URL.');
      }
      if (
        !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
        !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) ||
        ['host', 'hostaddr', 'port', 'service'].some((key) => parsed.searchParams.has(key))
      ) {
        throw new Error(
          'Refusing to run Hotel property access tests against a non-local database.'
        );
      }
    }
    if (OWNER_DATABASE_URL) {
      const runtimeUrl = new URL(TEST_DATABASE_URL!);
      const ownerUrl = new URL(OWNER_DATABASE_URL);
      if (
        (runtimeUrl.port || '5432') !== (ownerUrl.port || '5432') ||
        runtimeUrl.pathname !== ownerUrl.pathname
      ) {
        throw new Error('Hotel runtime and owner URLs must address the same local database.');
      }
    }
    observer = new pg.Client({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 2_000,
      query_timeout: 2_000,
      statement_timeout: 2_000,
    });
    await observer.connect();
    const runtimeRole = await observer.query(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit
         FROM pg_roles WHERE rolname = current_user`
    );
    expect(runtimeRole.rows).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
      },
    ]);
    const ownership = await observer.query<{ owns: boolean }>(
      `SELECT relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owns
         FROM pg_class WHERE oid IN
           ('public.hotel_properties'::regclass, 'public.hotel_property_assignments'::regclass)`
    );
    expect(ownership.rows).toEqual([{ owns: false }, { owns: false }]);

    process.env.DATABASE_URL = TEST_DATABASE_URL!;
    process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    const scoped = await import('@/lib/tenancy/scoped-db');
    const { hotelPropertyRouter } = await import('./hotel-property');
    const { db } = await import('@/lib/db');
    deps = { ...scoped, hotelPropertyRouter, db };
    await asPlatform(async (db) => {
      await db.organization.create({
        data: {
          id: ORG,
          slug: `hpa-gap-${suffix}`,
          legalName: 'Hotel property access fixture',
          displayName: 'Hotel property access fixture',
          vertical: 'HOSPITALITY',
          status: 'ACTIVE',
          primaryContactName: 'Ops',
          primaryContactEmail: `ops-${suffix}@example.test`,
        },
      });
      await seedDepartments(db, [ORG], ['FRONT_OFFICE']);
      await db.organizationRole.create({
        data: {
          id: ROLE,
          organizationId: ORG,
          key: 'general-manager',
          name: 'General Manager',
          isSystem: true,
          permissions: {
            create: ['admin:access', 'hotel:property-admin'].map((capability) => ({
              organizationId: ORG,
              capability,
              effect: 'ALLOW' as const,
            })),
          },
        },
      });
      for (const id of [USER_A, USER_B, MANAGER, TARGET]) {
        await db.user.create({
          data: {
            id,
            organizationId: ORG,
            organizationRoleId: ROLE,
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
    propertyA = await propertyFixture('isolation-a', USER_A);
    propertyB = await propertyFixture('isolation-b', USER_B);
  }, 60_000);

  afterAll(async () => {
    try {
      if (deps) {
        await asPlatform(async (db) => {
          // Parent cascade removes assignments before role RESTRICT is reached.
          await db.hotelProperty.deleteMany({ where: { organizationId: ORG } });
          await db.user.deleteMany({ where: { organizationId: ORG } });
          await db.organizationRole.deleteMany({ where: { organizationId: ORG } });
          await db.organizationDepartment.deleteMany({ where: { organizationId: ORG } });
          await db.organization.deleteMany({ where: { id: ORG } });
        });
      }
    } finally {
      await Promise.all([observer?.end(), owner?.end(), deps?.db.$disconnect()]);
    }
  }, 60_000);

  it('isolates two active properties in one organization with positive owner visibility', async () => {
    for (const [userId, own, sibling] of [
      [USER_A, propertyA, propertyB],
      [USER_B, propertyB, propertyA],
    ] as const) {
      await asUser(userId, async (db) => {
        // No application WHERE clause: PostgreSQL must isolate the properties.
        const visible = await db.hotelProperty.findMany({});
        expect(visible.map((property) => property.branchId)).toEqual([own.branchId]);
        expect(visible[0]).toMatchObject({ organizationId: ORG, active: true });
        expect(
          await db.hotelProperty.findUnique({ where: { branchId: sibling.branchId } })
        ).toBeNull();
        expect(
          await db.hotelProperty.findUnique({ where: { branchId: own.branchId } })
        ).toMatchObject({ branchId: own.branchId, active: true });
      });
    }
  });

  it.each(['assign', 'revoke'] as const)(
    'serializes tenant %s then the opposite procedure with a witnessed property lock',
    async (firstOperation) => {
      const property = await propertyFixture(`concurrent-${firstOperation}`, MANAGER);
      const initiallyActive = firstOperation === 'revoke';
      const secondOperation = initiallyActive ? 'assign' : 'revoke';
      // An independent manager remains active throughout. Target is never self,
      // foreign, inactive, unprivileged, or the property's last eligible manager.
      await asPlatform((db) =>
        db.hotelPropertyAssignment.create({
          data: {
            organizationId: ORG,
            branchId: property.branchId,
            userId: TARGET,
            organizationRoleId: ROLE,
            active: initiallyActive,
          },
        })
      );
      const input = { branchId: property.branchId, userId: TARGET };
      const invoke = (db: ScopedDb, operation: 'assign' | 'revoke') =>
        operation === 'assign'
          ? caller(db).access.assign({ ...input, organizationRoleId: ROLE })
          : caller(db).access.revoke(input);
      const releaseA = Promise.withResolvers<void>();
      const readyA = Promise.withResolvers<number>();
      const startedB = Promise.withResolvers<number>();
      const committed: string[] = [];
      const first = asUser(MANAGER, async (db) => {
        await db.$executeRawUnsafe(`SET LOCAL statement_timeout = '12s'`);
        const [backend] = await db.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        const result = await invoke(db, firstOperation);
        readyA.resolve(backend!.pid);
        // The actual router procedure finished, but its reused outer transaction
        // still holds the property lock until the independent observer proves B waits.
        await releaseA.promise;
        return result;
      }).then((result) => {
        committed.push('A');
        return result;
      });
      // Attach rejection handlers immediately, including failures before signaling.
      void first.catch(readyA.reject);
      let second: typeof first | undefined;
      try {
        const pidA = await readyA.promise;
        second = asUser(MANAGER, async (db) => {
          await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`);
          await db.$executeRawUnsafe(`SET LOCAL statement_timeout = '12s'`);
          const [backend] = await db.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          startedB.resolve(backend!.pid);
          return invoke(db, secondOperation);
        }).then((result) => {
          committed.push('B');
          return result;
        });
        void second.catch(startedB.reject);
        const pidB = await startedB.promise;
        expect(pidB).not.toBe(pidA);

        const deadline = Date.now() + 5_000;
        let witnessed = false;
        for (let queries = 0; queries < 200 && Date.now() < deadline; queries += 1) {
          // Ordinary runtime connection; no monitoring grant, sleeps or guessed
          // timing. Same-role pg_stat_activity also pins the blocked statement.
          const observation = await observer!.query<{
            observer_pid: number;
            blockers: number[];
            query: string;
          }>(
            `SELECT pg_backend_pid() AS observer_pid, pg_blocking_pids($1) AS blockers, query
               FROM pg_stat_activity WHERE pid = $1`,
            [pidB]
          );
          const row = observation.rows[0];
          if (!row?.blockers.includes(pidA)) continue;
          expect([pidA, pidB]).not.toContain(row.observer_pid);
          expect(row.query).toMatch(/SELECT\s+"branchId"\s+FROM\s+"hotel_properties"/i);
          expect(row.query).toMatch(/FOR UPDATE/i);
          witnessed = true;
          break;
        }
        expect(witnessed, 'B must be blocked by A before releaseA').toBe(true);
        expect(committed).toEqual([]);
        releaseA.resolve();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(committed).toEqual(['A', 'B']);
        expect(firstResult).toMatchObject({ ...input, active: !initiallyActive });
        expect(secondResult).toMatchObject({ ...input, active: initiallyActive });
        const assignments = await asPlatform((db) =>
          db.hotelPropertyAssignment.findMany({
            where: { organizationId: ORG, branchId: property.branchId },
            select: { userId: true, organizationRoleId: true, active: true },
          })
        );
        expect(assignments).toHaveLength(2);
        expect(assignments).toEqual(
          expect.arrayContaining([
            { userId: MANAGER, organizationRoleId: ROLE, active: true },
            { userId: TARGET, organizationRoleId: ROLE, active: initiallyActive },
          ])
        );
      } finally {
        releaseA.resolve();
        // Release even on observation/assertion failure, then settle both real
        // transactions before fixture cleanup. SQL and transaction timeouts bound failures.
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    },
    60_000
  );

  it.skipIf(!OWNER_DATABASE_URL)(
    'cascades a hard-deleted property under FORCE RLS without an assignment DELETE policy',
    async () => {
      owner = new pg.Client({
        connectionString: OWNER_DATABASE_URL,
        connectionTimeoutMillis: 2_000,
        query_timeout: 2_000,
        statement_timeout: 2_000,
      });
      await owner.connect();
      const role = await owner.query(
        `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit
           FROM pg_roles WHERE rolname = current_user`
      );
      expect(role.rows).toEqual([
        {
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: true,
          rolinherit: false,
        },
      ]);
      const flags = await owner.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity,
                relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owns
           FROM pg_class WHERE oid IN
             ('public.hotel_properties'::regclass, 'public.hotel_property_assignments'::regclass)
           ORDER BY relname`
      );
      expect(flags.rows).toEqual([
        {
          relname: 'hotel_properties',
          relrowsecurity: true,
          relforcerowsecurity: true,
          owns: true,
        },
        {
          relname: 'hotel_property_assignments',
          relrowsecurity: true,
          relforcerowsecurity: true,
          owns: true,
        },
      ]);
      const deletePolicies = await owner.query(
        `SELECT policyname FROM pg_policies WHERE schemaname = 'public'
           AND tablename = 'hotel_property_assignments' AND cmd IN ('DELETE', 'ALL')`
      );
      expect(deletePolicies.rows).toEqual([]);
      const foreignKeys = await owner.query(
        `SELECT conname, confdeltype FROM pg_constraint
           WHERE conrelid = 'public.hotel_property_assignments'::regclass AND contype = 'f'
             AND conname IN ('hotel_property_assignments_property_fkey', 'hotel_property_assignments_role_fkey')
           ORDER BY conname`
      );
      expect(foreignKeys.rows).toEqual([
        { conname: 'hotel_property_assignments_property_fkey', confdeltype: 'c' },
        { conname: 'hotel_property_assignments_role_fkey', confdeltype: 'r' },
      ]);

      const disposable = await propertyFixture('cascade', USER_A);
      const unrelatedBefore = await asPlatform((db) =>
        db.hotelPropertyAssignment.findMany({
          where: { organizationId: ORG, branchId: propertyB.branchId },
        })
      );
      expect(unrelatedBefore).toHaveLength(1);
      expect(unrelatedBefore[0]).toMatchObject({ userId: USER_B, active: true });
      await asUser(USER_A, async (db) => {
        const where = { organizationId: ORG, branchId: disposable.branchId };
        expect(await db.hotelPropertyAssignment.count({ where })).toBe(1);
        expect(await db.hotelPropertyAssignment.deleteMany({ where })).toEqual({ count: 0 });
        expect(await db.hotelPropertyAssignment.count({ where })).toBe(1);
        // Same authorized parent-delete pattern as extras.db.test.ts. This is
        // referential integrity, not deactivateHotelProperty (which retains rows).
        expect(await db.hotelProperty.deleteMany({ where })).toEqual({ count: 1 });
      });
      await asPlatform(async (db) => {
        const where = { organizationId: ORG, branchId: disposable.branchId };
        expect(await db.hotelProperty.count({ where })).toBe(0);
        expect(await db.hotelPropertyAssignment.count({ where })).toBe(0);
        expect(
          await db.hotelPropertyAssignment.findMany({
            where: { organizationId: ORG, branchId: propertyB.branchId },
          })
        ).toEqual(unrelatedBefore);
      });
    },
    30_000
  );
});
