// @vitest-environment node
/**
 * MODE-01 mode persistence — real-database coverage.
 *
 * The accepted `hotel-property-modes.test.ts` battery proves the caller contract
 * against a hand-written fake `$transaction`. A fake cannot prove what this file
 * is for: that the JSONB column actually holds what the router wrote, that a
 * rollback is a rollback rather than a reverted JavaScript object, that the
 * property lock really serializes two sessions, and that the audit row survives
 * — or fails to survive — independently of the mutation it describes.
 *
 * Everything below runs against the deployed Hotel migrations and the generated
 * client, through `withTenantDb`/`withPlatformDb`. Router middleware, the ABAC
 * engine, `requireHotelPropertyScope`, forced row-level security and every SQL
 * statement are real.
 *
 * DELIBERATELY NOT MOCKED — and this is the difference from the sibling
 * `hotel-property-access.db.test.ts`, which stubs `recordTrpcAudit` because
 * audit durability is not what it measures. Here the audit sink is real, so the
 * ordering question ("is a SUCCESS row still written when the surrounding
 * transaction later fails?") can be observed rather than assumed. Audit writes
 * are flushed after every case so a failed write fails a test instead of
 * surfacing later as an unhandled rejection.
 *
 * LIMITS, stated rather than papered over:
 *   - `createCaller` on this sub-router means procedure paths are `modes.get` /
 *     `modes.set`, so `requireLicensedModule` resolves no module key and does
 *     not gate. The `hotel-core` entitlement check inside
 *     `requireHotelPropertyScope` is real and is exercised by the sibling
 *     caller suite; nothing here should be read as proving the module gate.
 *   - The `fetchRequestHandler` case proves that the HTTP-shaped request path
 *     uses the outer transaction handed to `createContext`. It does NOT prove
 *     the exported `POST` handler, Auth.js session resolution, host/tenant
 *     resolution or `createTRPCContext` — those are supplied here by hand.
 *   - Availability enforcement is not modelled by MODE-01 and is not asserted.
 *
 * Missing the runtime URL skips the suite. The COMMIT-failure case additionally
 * requires the owner URL, because a deferred constraint cannot exist without
 * DDL; that DDL creates and drops one test-local table and touches no
 * production model, migration or global object.
 */
import { randomBytes } from 'node:crypto';

import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import pg from 'pg';
import superjson from 'superjson';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { seedDepartments } from '@/lib/test-support/departments';
import type { TRPCContext } from '@/server/trpc';

// `resolveTenantActor` is reached only from `createTRPCContext`; these cases
// build the request context by hand, so the seam is unused here. Stubbing it at
// the same seam the sibling router suites use keeps Auth.js out of the router
// import graph — `next@16` ships no extensionless `next/server`, which Node's
// ESM resolver cannot resolve for `next-auth`. It throws rather than returning a
// dummy actor, so a case that ever does need it fails loudly instead of
// silently bypassing authorization.
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
const ORG = `org_hpm_${suffix}`;
const FOREIGN_ORG = `org_hpm_foreign_${suffix}`;
const ROLE = `role_hpm_${suffix}`;
const MANAGER = `user_hpm_manager_${suffix}`;
const TARGET = `user_hpm_target_${suffix}`;
const COMMIT_FIXTURE = `hotel_mode_commit_${suffix}`;

/** Enough of the hospitality catalogue that a feature reduction is a decision. */
const ENABLED_MODULES = [
  'hotel-core',
  'hotel-reservations',
  'hotel-front-desk',
  'hotel-banquets',
] as const;

/**
 * The resolved configurations are written out rather than computed from
 * `applyHotelModeDefaults`, so a defaults regression cannot pass by agreeing
 * with itself.
 */
const HOTEL_CONFIGURATION = {
  inventoryKinds: ['ROOM'],
  billingCycles: ['NIGHTLY', 'SLOT'],
  dayUse: true,
  functionSpaces: false,
  dormPolicies: false,
  recurringExtras: false,
  tenancyDocuments: false,
  bookingEngineLayout: 'ROOMS',
  reportKeys: ['occupancy-revenue', 'arrivals-departures', 'day-use'],
};

const VENUE_CONFIGURATION = {
  inventoryKinds: [],
  billingCycles: ['SLOT'],
  dayUse: false,
  functionSpaces: true,
  dormPolicies: false,
  recurringExtras: false,
  tenancyDocuments: false,
  bookingEngineLayout: 'FUNCTIONS',
  reportKeys: ['function-utilisation', 'banquet-pnl'],
};

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  hotelPropertyRouter: (typeof import('./hotel-property'))['hotelPropertyRouter'];
  flushAuditWrites: (typeof import('@/server/audit'))['flushAuditWritesForTest'];
  db: (typeof import('@/lib/db'))['db'];
};

type StoredMode = {
  mode: string;
  isSqlNull: boolean;
  jsonType: string | null;
  overrides: unknown;
};

type TrpcResponseBody = {
  result?: { data?: { json?: unknown } };
  error?: { json?: { message?: string; data?: { code?: string } } };
};

let deps: Deps | undefined;
let observer: pg.Client | undefined;
let owner: pg.Client | undefined;
let legacyProperty: { branchId: string };
let siblingProperty: { branchId: string };
let foreignProperty: { branchId: string };

function asUser<T>(userId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps!.withTenantDb(ORG, work, { userId, maxWait: 5_000, timeout: 20_000 });
}

function asPlatform<T>(work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps!.withPlatformDb(work);
}

/**
 * The same request-context shape as `hotel-property-access.db.test.ts`, with the
 * real transaction facade and a caller-chosen identity. EMPLOYEE must obtain
 * both the global and the property-role grant from persisted rows.
 */
function requestContext(db: ScopedDb, userId: string): TRPCContext {
  return {
    db,
    entitlements: {
      organizationId: ORG,
      enabledModules: [...ENABLED_MODULES],
      modules: [],
      limits: { 'hotel.rooms.max': 25 },
    },
    session: {
      expires: 'later',
      user: {
        id: userId,
        organizationId: ORG,
        name: userId,
        email: `${userId}@example.test`,
        role: 'EMPLOYEE',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

function caller(db: ScopedDb, userId: string) {
  return deps!.hotelPropertyRouter.createCaller(requestContext(db, userId));
}

type ModeSetInput = Parameters<ReturnType<typeof caller>['modes']['set']>[0];

/**
 * One tRPC request through the fetch adapter, on a transaction the caller owns.
 * This is the reusable shape from `hotel-property.test.ts:410`; the point of
 * reusing it here is that `createContext` hands the procedure the SAME outer
 * transaction, so the caller can still decide whether that transaction commits.
 */
async function postThroughFetch(
  db: ScopedDb,
  userId: string,
  path: string,
  input: unknown
): Promise<{ status: number; body: TrpcResponseBody }> {
  const response = await fetchRequestHandler({
    endpoint: '/api/trpc',
    req: new Request(`http://localhost/api/trpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(superjson.serialize(input)),
    }),
    router: deps!.hotelPropertyRouter,
    createContext: () => requestContext(db, userId),
  });
  return { status: response.status, body: (await response.json()) as TrpcResponseBody };
}

function readModes(userId: string, branchId?: string) {
  return asUser(userId, (db) =>
    caller(db, userId).modes.get(branchId === undefined ? undefined : { branchId })
  );
}

function saveModes(userId: string, input: ModeSetInput) {
  return asUser(userId, (db) => caller(db, userId).modes.set(input));
}

/**
 * What the column actually holds, read from outside the caller's transaction.
 * Prisma reports SQL NULL and JSON null identically, so both are asked for in
 * SQL: a reset must be observable as stored `{}` rather than as an erased column.
 */
async function storedMode(branchId: string): Promise<StoredMode> {
  return asPlatform(async (db) => {
    const rows = await db.$queryRaw<StoredMode[]>`
      SELECT "mode"::text AS "mode",
             "modeOverrides" IS NULL AS "isSqlNull",
             jsonb_typeof("modeOverrides") AS "jsonType",
             "modeOverrides" AS "overrides"
        FROM "hotel_properties"
       WHERE "organizationId" = ${ORG} AND "branchId" = ${branchId}`;
    expect(rows).toHaveLength(1);
    return rows[0]!;
  });
}

async function auditRows(branchId: string, path: string) {
  return asPlatform((db) =>
    db.auditLog.findMany({
      where: { organizationId: ORG, path, targetType: 'HotelProperty', targetId: branchId },
      orderBy: { createdAt: 'asc' },
      select: {
        actorId: true,
        action: true,
        path: true,
        outcome: true,
        description: true,
        targetType: true,
        targetId: true,
        metadata: true,
      },
    })
  );
}

async function propertyFixture(
  label: string,
  userIds: readonly string[],
  organizationId: string = ORG
) {
  return asPlatform(async (db) => {
    const property = await db.hotelProperty.create({
      data: {
        organizationId,
        name: `Property ${label}`,
        addressLine: '12 Main Boulevard',
        city: 'Lahore',
        timezone: 'Asia/Karachi',
        bookingEngineSlug: `hpm-${label}-${suffix}`,
        active: true,
      },
    });
    for (const userId of userIds) {
      await db.hotelPropertyAssignment.create({
        data: {
          organizationId,
          branchId: property.branchId,
          userId,
          organizationRoleId: ROLE,
          active: true,
        },
      });
    }
    return property;
  });
}

/** A property both fixture managers hold, so each case starts from clean storage. */
function subject(label: string) {
  return propertyFixture(label, [MANAGER, TARGET]);
}

describeIfDatabase('Hotel property mode persistence against the database', () => {
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
        throw new Error('Refusing to run Hotel property mode tests against a non-local database.');
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
    // The column this whole file is about must exist as JSONB and be nullable.
    const column = await observer.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'hotel_properties'
           AND column_name = 'modeOverrides'`
    );
    expect(column.rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }]);

    process.env.DATABASE_URL = TEST_DATABASE_URL!;
    process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    const scoped = await import('@/lib/tenancy/scoped-db');
    const { hotelPropertyRouter } = await import('./hotel-property');
    const { flushAuditWritesForTest } = await import('@/server/audit');
    const { db } = await import('@/lib/db');
    deps = {
      withTenantDb: scoped.withTenantDb,
      withPlatformDb: scoped.withPlatformDb,
      hotelPropertyRouter,
      flushAuditWrites: flushAuditWritesForTest,
      db,
    };

    await asPlatform(async (db) => {
      for (const [id, slug] of [
        [ORG, `hpm-${suffix}`],
        [FOREIGN_ORG, `hpm-foreign-${suffix}`],
      ] as const) {
        await db.organization.create({
          data: {
            id,
            slug,
            legalName: 'Hotel mode fixture',
            displayName: 'Hotel mode fixture',
            vertical: 'HOSPITALITY',
            status: 'ACTIVE',
            primaryContactName: 'Ops',
            primaryContactEmail: `ops-${slug}@example.test`,
          },
        });
      }
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
      for (const id of [MANAGER, TARGET]) {
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

    legacyProperty = await propertyFixture('legacy', [MANAGER, TARGET]);
    // Held by MANAGER alone: TARGET's denial on it is a real missing assignment
    // in the same organization, not an invented branch id.
    siblingProperty = await propertyFixture('sibling', [MANAGER]);
    foreignProperty = await propertyFixture('foreign', [], FOREIGN_ORG);
  }, 60_000);

  afterEach(async () => {
    // The audit sink is real in this file. Flushing here turns a broken audit
    // write into a failure of the case that caused it.
    await deps?.flushAuditWrites();
  });

  afterAll(async () => {
    try {
      // Idempotent: the COMMIT case drops its own table, this covers a crash
      // between CREATE and DROP. Not swallowed — a failure here is a real one.
      if (owner) await owner.query(`DROP TABLE IF EXISTS "${COMMIT_FIXTURE}"`);
      if (deps) {
        await asPlatform(async (db) => {
          // Audit rows first: `actorId` is SetNull, but the organization row
          // below is the parent of every audit row written by these cases.
          await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG, FOREIGN_ORG] } } });
          // Parent cascade removes assignments before role RESTRICT is reached.
          await db.hotelProperty.deleteMany({
            where: { organizationId: { in: [ORG, FOREIGN_ORG] } },
          });
          await db.user.deleteMany({ where: { organizationId: ORG } });
          await db.organizationRole.deleteMany({ where: { organizationId: ORG } });
          await db.organizationDepartment.deleteMany({ where: { organizationId: ORG } });
          await db.organization.deleteMany({ where: { id: { in: [ORG, FOREIGN_ORG] } } });
        });
      }
    } finally {
      await Promise.all([observer?.end(), owner?.end(), deps?.db.$disconnect()]);
    }
  }, 60_000);

  describe('stored JSONB', () => {
    it('reads SQL NULL storage as no overrides and backfills nothing', async () => {
      const before = await storedMode(legacyProperty.branchId);
      expect(before).toMatchObject({ mode: 'HOTEL', isSqlNull: true, jsonType: null });

      const result = await readModes(TARGET, legacyProperty.branchId);
      expect(result.mode).toBe('HOTEL');
      expect(result.overrides).toEqual({});
      expect(result.configuration).toEqual(HOTEL_CONFIGURATION);
      expect(result.features).toMatchObject({
        rooms: true,
        reservations: true,
        dayUse: true,
        functionSpaces: false,
      });

      // Resolving defaults for a read must never write them into the column:
      // a later defaults change has to keep moving this property.
      expect(await storedMode(legacyProperty.branchId)).toEqual(before);
    });

    it('persists explicit false and empty arrays, and a fresh transaction reads them back', async () => {
      const { branchId } = await subject('explicit');
      const overrides = { dayUse: false, inventoryKinds: [], reportKeys: [], functionSpaces: true };
      await saveModes(TARGET, { branchId, mode: 'RESORT', overrides });

      const stored = await storedMode(branchId);
      expect(stored).toMatchObject({ mode: 'RESORT', isSqlNull: false, jsonType: 'object' });
      // The decisions, and only the decisions. The resolved configuration —
      // billingCycles, bookingEngineLayout, the rest — is never stored.
      expect(stored.overrides).toEqual(overrides);
      expect(Object.keys(stored.overrides as Record<string, unknown>).sort()).toEqual([
        'dayUse',
        'functionSpaces',
        'inventoryKinds',
        'reportKeys',
      ]);

      const fresh = await readModes(TARGET, branchId);
      expect(fresh.mode).toBe('RESORT');
      expect(fresh.overrides).toEqual(overrides);
      expect(fresh.configuration).toEqual({
        ...HOTEL_CONFIGURATION,
        ...overrides,
        bookingEngineLayout: 'ROOMS_AND_SLOTS',
      });
      // An empty inventory is a real decision, so the room features close.
      expect(fresh.features).toMatchObject({
        rooms: false,
        reservations: false,
        dayUse: false,
        functionSpaces: true,
      });
    });

    it('preserves stored JSONB across a mode change that omits the overrides object', async () => {
      const { branchId } = await subject('preserve');
      const overrides = { dayUse: false, inventoryKinds: [], reportKeys: [] };
      await saveModes(TARGET, { branchId, mode: 'RESORT', overrides });
      const stored = await storedMode(branchId);

      await saveModes(TARGET, { branchId, mode: 'HOSTEL' });
      const after = await storedMode(branchId);
      expect(after).toMatchObject({ mode: 'HOSTEL', isSqlNull: false, jsonType: 'object' });
      expect(after.overrides).toEqual(stored.overrides);

      const fresh = await readModes(TARGET, branchId);
      expect(fresh.overrides).toEqual(overrides);
      // The stored decisions survive; everything else follows the new mode.
      expect(fresh.configuration).toEqual({
        ...HOTEL_CONFIGURATION,
        ...overrides,
        billingCycles: ['NIGHTLY'],
        dormPolicies: true,
        bookingEngineLayout: 'BEDS',
      });
    });

    it('replaces the whole stored object rather than merging, and stores {} as a reset', async () => {
      const { branchId } = await subject('replace');
      await saveModes(TARGET, {
        branchId,
        mode: 'HOTEL',
        overrides: { dayUse: false, inventoryKinds: [], reportKeys: [] },
      });
      await saveModes(TARGET, { branchId, mode: 'HOTEL', overrides: { functionSpaces: true } });
      expect((await storedMode(branchId)).overrides).toEqual({ functionSpaces: true });

      await saveModes(TARGET, { branchId, mode: 'VENUE', overrides: {} });
      const reset = await storedMode(branchId);
      // A reset is stored as an empty JSON object, not as an erased column: the
      // operator's "use the mode defaults" is itself a recorded decision.
      expect(reset).toMatchObject({ mode: 'VENUE', isSqlNull: false, jsonType: 'object' });
      expect(reset.overrides).toEqual({});

      const fresh = await readModes(TARGET, branchId);
      expect(fresh.overrides).toEqual({});
      expect(fresh.configuration).toEqual(VENUE_CONFIGURATION);
      expect(fresh.features).toMatchObject({
        rooms: false,
        availabilityDays: false,
        reservations: false,
        functionSpaces: true,
      });
    });
  });

  describe('selection and authorization', () => {
    it('serves the authorized selection and shows only assigned properties in SQL', async () => {
      const { branchId } = await subject('authorized');
      await expect(saveModes(TARGET, { branchId, mode: 'HOSTEL' })).resolves.toEqual({
        mode: 'HOSTEL',
      });
      expect((await readModes(TARGET, branchId)).mode).toBe('HOSTEL');

      await asUser(TARGET, async (db) => {
        // No application WHERE clause: row-level security alone decides.
        const visible = await db.hotelProperty.findMany({ select: { branchId: true } });
        const ids = visible.map((property) => property.branchId);
        expect(ids).toContain(branchId);
        expect(ids).toContain(legacyProperty.branchId);
        expect(ids).not.toContain(siblingProperty.branchId);
        expect(ids).not.toContain(foreignProperty.branchId);
        for (const hidden of [siblingProperty.branchId, foreignProperty.branchId]) {
          expect(await db.hotelProperty.findUnique({ where: { branchId: hidden } })).toBeNull();
        }
      });
    });

    it.each(['get', 'set'] as const)('requires an explicit selection for %s', async (operation) => {
      await expect(
        operation === 'get' ? readModes(TARGET) : saveModes(TARGET, { mode: 'HOTEL' })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    });

    it.each(['same-organization sibling', 'foreign tenant', 'unknown property'] as const)(
      'denies %s on read and write with stored mode and overrides unchanged',
      async (scenario) => {
        const branchId =
          scenario === 'same-organization sibling'
            ? siblingProperty.branchId
            : scenario === 'foreign tenant'
              ? foreignProperty.branchId
              : `absent_${suffix}`;
        const before =
          scenario === 'same-organization sibling' ? await storedMode(branchId) : undefined;

        await expect(readModes(TARGET, branchId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          saveModes(TARGET, { branchId, mode: 'VENUE', overrides: { functionSpaces: true } })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });

        if (before) {
          // Denied is denied at rest too, not merely in the response.
          expect(await storedMode(branchId)).toEqual(before);
          expect(before).toMatchObject({ mode: 'HOTEL', isSqlNull: true });
        }
        await asUser(TARGET, async (db) => {
          expect(await db.hotelProperty.findUnique({ where: { branchId } })).toBeNull();
        });
      }
    );
  });

  describe('concurrent revocation and mode save', () => {
    it.each(['revoke', 'save'] as const)(
      'serializes a %s holding the property lock against the opposite procedure',
      async (firstOperation) => {
        const property = await subject(`concurrent-${firstOperation}`);
        const branchId = property.branchId;
        const overrides = { functionSpaces: true };
        const releaseA = Promise.withResolvers<void>();
        const readyA = Promise.withResolvers<number>();
        const startedB = Promise.withResolvers<number>();
        const committed: string[] = [];

        // MANAGER revokes TARGET; TARGET saves the mode. Neither revokes
        // itself, and MANAGER keeps its own assignment throughout, so the
        // property never loses its last eligible manager.
        const revoke = (db: ScopedDb) =>
          caller(db, MANAGER).access.revoke({ branchId, userId: TARGET });
        const save = (db: ScopedDb) =>
          caller(db, TARGET).modes.set({ branchId, mode: 'VENUE', overrides });
        const invoke = (db: ScopedDb, operation: 'revoke' | 'save') =>
          operation === 'revoke' ? revoke(db) : save(db);
        const secondOperation = firstOperation === 'revoke' ? 'save' : 'revoke';
        const firstActor = firstOperation === 'revoke' ? MANAGER : TARGET;
        const secondActor = firstActor === MANAGER ? TARGET : MANAGER;

        const first = asUser(firstActor, async (db) => {
          await db.$executeRawUnsafe(`SET LOCAL statement_timeout = '12s'`);
          const [backend] = await db.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          const result = await invoke(db, firstOperation);
          readyA.resolve(backend!.pid);
          // The procedure finished, but its reused outer transaction still
          // holds the property lock until the observer proves B waits on it.
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
          second = asUser(secondActor, async (db) => {
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
            // Ordinary runtime connection; no monitoring grant, sleeps or
            // guessed timing. Same-role pg_stat_activity pins the statement.
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
          expect(await storedMode(branchId)).toMatchObject({ mode: 'HOTEL', isSqlNull: true });

          releaseA.resolve();
          await expect(first).resolves.toBeDefined();
          expect(committed).toEqual(['A']);

          if (firstOperation === 'revoke') {
            // B re-reads its assignment after taking the lock, so it sees the
            // revocation A just committed and writes nothing at all.
            await expect(second).rejects.toMatchObject({ code: 'FORBIDDEN' });
            expect(committed).toEqual(['A']);
            expect(await storedMode(branchId)).toMatchObject({
              mode: 'HOTEL',
              isSqlNull: true,
              jsonType: null,
            });
          } else {
            // The authorized save committed first; losing access afterwards
            // does not un-commit it.
            await expect(second).resolves.toMatchObject({
              branchId,
              userId: TARGET,
              active: false,
            });
            expect(committed).toEqual(['A', 'B']);
            const stored = await storedMode(branchId);
            expect(stored).toMatchObject({ mode: 'VENUE', isSqlNull: false });
            expect(stored.overrides).toEqual(overrides);
            await expect(readModes(TARGET, branchId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
            expect((await readModes(MANAGER, branchId)).configuration).toEqual(VENUE_CONFIGURATION);
          }

          const assignments = await asPlatform((db) =>
            db.hotelPropertyAssignment.findMany({
              where: { organizationId: ORG, branchId },
              select: { userId: true, active: true },
            })
          );
          expect(assignments).toEqual(
            expect.arrayContaining([
              { userId: MANAGER, active: true },
              { userId: TARGET, active: false },
            ])
          );
        } finally {
          releaseA.resolve();
          // Release even on observation/assertion failure, then settle both real
          // transactions before the next case. SQL and transaction timeouts
          // bound the failure path.
          await Promise.allSettled([first, ...(second ? [second] : [])]);
        }
      },
      60_000
    );
  });

  describe('outer transaction boundary and audit truth', () => {
    it('rolls the committed-looking write back with the outer transaction', async () => {
      const { branchId } = await subject('rollback-caller');
      await expect(
        asUser(TARGET, async (db) => {
          const result = await caller(db, TARGET).modes.set({
            branchId,
            mode: 'VENUE',
            overrides: { functionSpaces: true },
          });
          expect(result).toEqual({ mode: 'VENUE' });
          // The procedure returned and its inner `$transaction` resolved, so
          // the write IS visible inside this transaction. It is not durable.
          const inside = await db.hotelProperty.findFirst({
            where: { organizationId: ORG, branchId },
            select: { mode: true, modeOverrides: true },
          });
          expect(inside).toMatchObject({ mode: 'VENUE', modeOverrides: { functionSpaces: true } });
          throw new Error('outer request failed after the mode write');
        })
      ).rejects.toThrow('outer request failed after the mode write');

      expect(await storedMode(branchId)).toMatchObject({
        mode: 'HOTEL',
        isSqlNull: true,
        jsonType: null,
      });
    });

    it('rolls back the same write when the request arrives through the fetch adapter', async () => {
      const { branchId } = await subject('rollback-fetch');
      await expect(
        asUser(TARGET, async (db) => {
          const { status, body } = await postThroughFetch(db, TARGET, 'modes.set', {
            branchId,
            mode: 'HOSTEL',
            overrides: { dormPolicies: false },
          });
          // A 200 on the wire is the router's verdict, not the database's.
          expect(status).toBe(200);
          expect(body.result?.data?.json).toEqual({ mode: 'HOSTEL' });
          throw new Error('outer request failed after the fetch-shaped mode write');
        })
      ).rejects.toThrow('outer request failed after the fetch-shaped mode write');

      expect(await storedMode(branchId)).toMatchObject({
        mode: 'HOTEL',
        isSqlNull: true,
        jsonType: null,
      });
    });

    it.skipIf(!OWNER_DATABASE_URL)(
      'rolls the mode write back when COMMIT itself fails on a deferred constraint',
      async () => {
        const { branchId } = await subject('rollback-commit');
        owner = new pg.Client({
          connectionString: OWNER_DATABASE_URL,
          connectionTimeoutMillis: 2_000,
          query_timeout: 2_000,
          statement_timeout: 2_000,
        });
        await owner.connect();
        const ownerRole = await owner.query(
          `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit
             FROM pg_roles WHERE rolname = current_user`
        );
        expect(ownerRole.rows).toEqual([
          {
            rolsuper: false,
            rolbypassrls: false,
            rolcreatedb: false,
            rolcreaterole: true,
            rolinherit: false,
          },
        ]);
        // The grant target is the runtime role, quoted by PostgreSQL itself.
        const grantee = await observer!.query<{ role: string }>(
          `SELECT quote_ident(current_user) AS role`
        );
        const role = grantee.rows[0]!.role;

        // A test-local table with a constraint PostgreSQL can only check at
        // COMMIT. Schema-qualified so no `search_path` decides where it lands.
        // No production model, migration or global object is touched, and the
        // table is dropped below and again in afterAll.
        const table = `public."${COMMIT_FIXTURE}"`;
        await owner.query(
          `CREATE TABLE ${table} (
             "id" text NOT NULL,
             CONSTRAINT "${COMMIT_FIXTURE}_unique" UNIQUE ("id") DEFERRABLE INITIALLY DEFERRED
           )`
        );
        try {
          await owner.query(`GRANT SELECT, INSERT ON ${table} TO ${role}`);
          // Read back after the transaction, never asserted inside it: an
          // assertion that threw within the callback would roll the transaction
          // back and satisfy `rejects` for the wrong reason, proving nothing
          // about COMMIT. Leaving it `undefined` is the failure signal.
          let rowsInsertedBeforeCommit: number | undefined;
          await expect(
            asUser(TARGET, async (db) => {
              await caller(db, TARGET).modes.set({
                branchId,
                mode: 'APARTMENT',
                overrides: { tenancyDocuments: true },
              });
              await db.$executeRawUnsafe(
                `INSERT INTO ${table} ("id") VALUES ('duplicate'), ('duplicate')`
              );
              const [inserted] = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
                `SELECT count(*) AS count FROM ${table}`
              );
              rowsInsertedBeforeCommit = Number(inserted!.count);
            })
          ).rejects.toThrow();

          // Both duplicates were accepted by their own statement, so the only
          // thing left that could have failed is the deferred check at COMMIT.
          // A non-deferred constraint would have thrown at the INSERT and left
          // this undefined.
          expect(rowsInsertedBeforeCommit).toBe(2);
          expect(await storedMode(branchId)).toMatchObject({
            mode: 'HOTEL',
            isSqlNull: true,
            jsonType: null,
          });
          const survivors = await owner.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM ${table}`
          );
          expect(survivors.rows).toEqual([{ count: '0' }]);
        } finally {
          await owner.query(`DROP TABLE IF EXISTS ${table}`);
        }
      },
      60_000
    );

    it('writes a durable audit row for a save that actually committed', async () => {
      const { branchId } = await subject('audit-committed');
      await saveModes(TARGET, {
        branchId,
        mode: 'VENUE',
        overrides: { functionSpaces: true },
      });
      // Awaiting the mutation is not enough: the sink is fire-and-forget, so
      // the row is only guaranteed to exist after the flush.
      await deps!.flushAuditWrites();

      expect(await auditRows(branchId, 'modes.set')).toEqual([
        {
          actorId: TARGET,
          action: 'modes.set',
          path: 'modes.set',
          outcome: 'SUCCESS',
          description: 'Updated property mode configuration',
          targetType: 'HotelProperty',
          targetId: branchId,
          metadata: { branchId, mode: 'VENUE', overridesReplaced: true },
        },
      ]);
      expect(await storedMode(branchId)).toMatchObject({ mode: 'VENUE', isSqlNull: false });
    });

    it('records the audit row for a rolled-back save — a limitation, not a guarantee', async () => {
      const { branchId } = await subject('audit-rolled-back');
      await expect(
        asUser(TARGET, async (db) => {
          await caller(db, TARGET).modes.set({ branchId, mode: 'VENUE', overrides: {} });
          throw new Error('outer request failed after the audited mode write');
        })
      ).rejects.toThrow('outer request failed after the audited mode write');
      await deps!.flushAuditWrites();

      // THE MUTATION DID NOT HAPPEN. This is the assertion that matters.
      expect(await storedMode(branchId)).toMatchObject({
        mode: 'HOTEL',
        isSqlNull: true,
        jsonType: null,
      });

      // THE AUDIT ROW SAYS IT DID. `recordTrpcAudit` fires from tRPC middleware
      // once the resolver returns, and `recordAudit` writes it on its own
      // `withTenantDb` transaction — a different connection, committed
      // independently of the caller's. So a SUCCESS row outlives the write it
      // describes whenever the surrounding request fails after the procedure.
      //
      // This is recorded as the current infrastructure behaviour, deliberately
      // and without weakening the assertion above to hide it. It is not a
      // post-commit guarantee, and nothing here should be read as one. Fixing
      // it means deferring the audit write to after the outermost commit, which
      // is a shared-audit change well outside MODE-01.
      const rows = await auditRows(branchId, 'modes.set');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorId: TARGET,
        outcome: 'SUCCESS',
        targetId: branchId,
        metadata: { branchId, mode: 'VENUE', overridesReplaced: true },
      });
    });
  });
});
