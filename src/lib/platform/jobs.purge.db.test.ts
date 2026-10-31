/**
 * @vitest-environment node
 *
 * WHA-1209 — the PURGING → PURGED retention path, against a REAL PostgreSQL.
 *
 * Two facts from the PLAT-03/04 migration stopped a pharmacy tenant from ever
 * being destroyed, and neither of them survives a mock — one is a trigger, the
 * other is the shape of the foreign-key graph the purge reads out of the
 * catalog at run time:
 *
 *   (a) `pharmacy_onboarding_events` was append-only under an unconditional
 *       BEFORE UPDATE OR DELETE trigger, so the purge's DELETE was refused for
 *       every role once an operator had confirmed a single onboarding step.
 *
 *   (b) `pharmacy_branches` names a default stock location while every stock
 *       location belongs to a branch. Both sides are ON DELETE RESTRICT, so the
 *       two tables form a cycle and the purge's topological sort threw
 *       "cyclic delete dependency" — for EVERY organization, pharmacy or not,
 *       because that graph is read from the whole schema rather than per tenant.
 *
 * So this suite drives `processPlatformJobs` end to end against a real cluster.
 * The purge has to finish, and the tenant's pharmacy rows — branches included —
 * have to be gone afterwards.
 *
 * The second test is the other half: the history must still be append-only for a
 * tenant that exists. A fix that merely dropped the trigger would pass the first
 * test and fail this one.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database, never
 * DATABASE_URL). Without it the suite reports itself skipped rather than passing
 * vacuously.
 *
 * DELIBERATELY DOES NOT CALL `assertRlsEnforcingRole` (#39): nothing asserted
 * here is DECIDED BY row-level security. The purge worker runs through
 * `withPlatformDb`, which sets `app.is_platform_admin` on purpose, every
 * organization id is unique per run, and every assertion filters by
 * organizationId — so a wider-visibility role cannot reach the asserted rows and
 * the suite is valid on a superuser TEST_DATABASE_URL too.
 */
import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// `@/lib/db` reads DATABASE_URL when its module is evaluated, so this must
// happen before the dynamic imports in `beforeAll`.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

/**
 * `@/lib/db` hands `PrismaPg` a `pg.Pool` it constructed itself, and the adapter
 * separates a pool from a config with `poolOrConfig instanceof pg.Pool`. Under
 * Vitest the application module and the adapter's own bundle resolve to two
 * different copies of `pg`, so that check is false, the adapter treats the pool
 * object as a `PoolConfig`, and the connection dies in the startup packet with
 * "The string argument must be of type string ... Received an instance of
 * Object". It is an artefact of module duplication under the test runner, not of
 * anything this suite or the production path does, and it takes down every
 * database suite that reaches for the shared client.
 *
 * Handing the adapter a connection string instead — its other documented input,
 * and the one that needs no cross-realm `instanceof` — gets the same client
 * without that hazard. Everything under test still runs against the real schema
 * through the real `withPlatformDb`.
 */
vi.mock('@/lib/db', () => ({
  db: new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 10 }),
    log: ['error'],
  }),
}));
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.BLOB_READ_WRITE_TOKEN ??= 'vercel_blob_rw_wha1209_test_token';

const suffix = randomBytes(6).toString('hex');

const PURGED_ORG = `wha1209_purge_${suffix}`;
const LIVE_ORG = `wha1209_live_${suffix}`;
const BRANCH_ID = `wha1209_branch_${suffix}`;
const LIVE_BRANCH_ID = `wha1209_live_branch_${suffix}`;
const LOCATION_ID = `wha1209_loc_${suffix}`;
const JOB_ID = `wha1209_job_${suffix}`;
const PURGED_PROFILE_ID = `wha1220_profile_${suffix}`;
const LIVE_PROFILE_ID = `wha1220_live_profile_${suffix}`;
const HOTEL_PURGED_ORG = `hotel_purge_${suffix}`;
const HOTEL_LIVE_ORG = `hotel_live_${suffix}`;
const HOTEL_JOB_ID = `hotel_purge_job_${suffix}`;
// Tenants whose own runtime tries the purge name without the control plane.
const TENANT_ORG = `purge_name_tenant_${suffix}`;
const TENANT_BRANCH_ID = `purge_name_branch_${suffix}`;
const TENANT_PROFILE_ID = `purge_name_profile_${suffix}`;
const HOTEL_TENANT_ORG = `hotel_purge_name_${suffix}`;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let processPlatformJobs: typeof import('./jobs').processPlatformJobs;

/** An organization plus the onboarding history that made it undeletable. */
async function seedTenant(db: ScopedDb, organizationId: string, status: string) {
  await db.$executeRawUnsafe(
    `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "purgeScheduledAt", "createdAt", "updatedAt")
     VALUES ($1, $1, $1, $1, 'PHARMACY', $2::"OrganizationStatus", 'SHARED', now() - interval '1 day', now(), now())`,
    organizationId,
    status
  );
  await db.$executeRawUnsafe(
    `INSERT INTO pharmacy_onboarding_states (id, "organizationId", "updatedAt") VALUES ($1, $2, now())`,
    `state_${organizationId}`,
    organizationId
  );
  // The row that the append-only trigger refused to let go of.
  await db.$executeRawUnsafe(
    `INSERT INTO pharmacy_onboarding_events (id, "organizationId", gate, "fromStatus", "toStatus", "actorId", "occurredAt")
     VALUES ($1, $2, 'ORG_TYPE', 'NOT_STARTED', 'PASSED', 'wha1209-operator', now())`,
    `event_${organizationId}`,
    organizationId
  );
  await db.$executeRaw`
    INSERT INTO audit_logs (id, "organizationId", source, category, action)
    VALUES (${`audit_${organizationId}`}, ${organizationId}, 'TRPC', 'SYSTEM', 'purge.fixture')
  `;
}

async function seedRegulatoryProfile(
  db: ScopedDb,
  id: string,
  organizationId: string,
  branchId: string
) {
  await db.$executeRawUnsafe(
    `INSERT INTO pharmacy_branch_regulatory_profiles (
       id, "organizationId", "branchId", version, "effectiveFrom", "provinceCode",
       "jurisdictionRuleSetId", premises, "licenceCategory", "licenceNumber",
       "licenceValidFrom", "licenceValidTo", "licenceEvidenceFileRef", "permittedSchedules",
       "qualifiedPersonRegistration", "qualifiedPersonValidFrom", "qualifiedPersonValidTo",
       "qualifiedPersonCoverageRosterRef", "fiscalStatus", "retentionPolicy"
     ) VALUES (
       $1, $2, $3, 1, '2026-09-01', 'PK-PB', 'pk_pb_provisional_v1', '{}'::jsonb,
       'PROVISIONAL', $1, '2026-01-01', '2027-01-01', '/test/licence', ARRAY[]::text[],
       'PC-TEST', '2026-01-01', '2027-01-01', '/test/roster', 'UNCONFIRMED', '{}'::jsonb
     )`,
    id,
    organizationId,
    branchId
  );
}

/**
 * CAM-2 evidence: a counter camera on the branch and one still bound to a daily
 * close, whose capture failed. FAILED is terminal and kept as a record, and it is
 * neither pending nor due for retention, so `processPlatformJobs` queues no
 * snapshot or retention job for it — a job that would outlive the purged row and
 * fail in whichever suite next drains the queue.
 */
async function seedCameraEvidence(db: ScopedDb, organizationId: string, branchId: string) {
  const id = (label: string) => `${label}_${organizationId}`;
  await db.$executeRawUnsafe(
    `INSERT INTO camera_gateways (id, "organizationId", "branchId", name, "gatewaySecretHash", "baseUrl", "updatedAt")
     VALUES ($1, $2, $3, 'Counter gateway', $1, 'https://gateway.example.test/', now())`,
    id('gateway'),
    organizationId,
    branchId
  );
  await db.$executeRawUnsafe(
    `INSERT INTO camera_credentials (id, "organizationId", "sealedValue", "updatedAt")
     VALUES ($1, $2, 'sealed-fixture', now())`,
    id('credential'),
    organizationId
  );
  await db.$executeRawUnsafe(
    `INSERT INTO cameras (id, "organizationId", "gatewayId", "branchId", "credentialId", name, "sourceRef", "counterEvidence", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 'Counter camera', 'sim-counter-1', true, now())`,
    id('camera'),
    organizationId,
    id('gateway'),
    branchId,
    id('credential')
  );
  await db.$executeRawUnsafe(
    `INSERT INTO camera_evidence (id, "organizationId", "branchId", "subjectKind", "subjectId", "cameraId", status, "failureReason", "updatedAt")
     VALUES ($1, $2, $3, 'PHARMACY_DAILY_CLOSE', $4, $5, 'FAILED', 'GATEWAY_UNREACHABLE', now())`,
    id('evidence'),
    organizationId,
    branchId,
    id('close'),
    id('camera')
  );
}

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('tenant purge, against PostgreSQL', () => {
  beforeAll(async () => {
    ({ withPlatformDb, withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    ({ processPlatformJobs } = await import('./jobs'));

    await withPlatformDb(async (db) => {
      await seedTenant(db, PURGED_ORG, 'PURGING');
      await seedTenant(db, LIVE_ORG, 'ACTIVE');

      // The mutually-referencing pair: a branch that names a default stock
      // location which in turn belongs to that branch.
      await db.$executeRawUnsafe(
        `INSERT INTO pharmacy_branches (id, "organizationId", code, name, "addressLine", city, "provinceCode", "updatedAt")
         VALUES ($1, $2, $1, 'Gulberg', '12 Mall Road', 'Lahore', 'PB', now())`,
        BRANCH_ID,
        PURGED_ORG
      );
      await db.$executeRawUnsafe(
        `INSERT INTO pharmacy_branches (id, "organizationId", code, name, "addressLine", city, "provinceCode", "updatedAt")
         VALUES ($1, $2, $1, 'Live branch', '14 Mall Road', 'Lahore', 'PB', now())`,
        LIVE_BRANCH_ID,
        LIVE_ORG
      );
      await seedRegulatoryProfile(db, PURGED_PROFILE_ID, PURGED_ORG, BRANCH_ID);
      await seedRegulatoryProfile(db, LIVE_PROFILE_ID, LIVE_ORG, LIVE_BRANCH_ID);
      // Camera evidence is retained the same way: deleted only with its tenant.
      await seedCameraEvidence(db, PURGED_ORG, BRANCH_ID);
      await db.$executeRawUnsafe(
        `INSERT INTO pharmacy_stock_locations (id, "organizationId", "branchId", code, name, kind, "updatedAt")
         VALUES ($1, $2, $3, $1, 'Main store', 'STORE', now())`,
        LOCATION_ID,
        PURGED_ORG,
        BRANCH_ID
      );
      await db.$executeRawUnsafe(
        `UPDATE pharmacy_branches SET "defaultStockLocationId" = $1 WHERE id = $2`,
        LOCATION_ID,
        BRANCH_ID
      );

      await db.$executeRawUnsafe(
        // maxAttempts 1: a failure is terminal, so it lands in `error` for the
        // assertion to report instead of being rescheduled silently.
        `INSERT INTO platform_jobs (id, "organizationId", type, status, payload, "maxAttempts", "updatedAt")
         VALUES ($1, $2, 'PURGE_DATA', 'QUEUED', '{}'::jsonb, 1, now())`,
        JOB_ID,
        PURGED_ORG
      );
      await db.$executeRawUnsafe(
        `UPDATE platform_jobs SET "scheduledAt" = '1900-01-01', "createdAt" = '1900-01-01'
         WHERE id = $1`,
        JOB_ID
      );
    });
  }, 60_000);

  it('purges a pharmacy tenant that has confirmed an onboarding step', async () => {
    const result = await processPlatformJobs(1);

    const job = await withPlatformDb((db) =>
      db.platformJob.findUniqueOrThrow({
        where: { id: JOB_ID },
        select: { status: true, error: true },
      })
    );
    // One assertion over the job row and the worker's tally together, so a
    // failure reports the database's own message rather than an opaque
    // "expected 'QUEUED' to be 'SUCCEEDED'".
    expect({
      status: job.status,
      error: job.error,
      claimed: result.claimed,
      succeeded: result.succeeded,
      retried: result.retried,
      failed: result.failed,
    }).toEqual({
      status: 'SUCCEEDED',
      error: null,
      claimed: 1,
      succeeded: 1,
      retried: 0,
      failed: 0,
    });

    const [remaining] = await withPlatformDb((db) =>
      db.$queryRawUnsafe<Array<Record<string, bigint>>>(
        `SELECT (SELECT count(*) FROM pharmacy_branch_regulatory_profiles WHERE "organizationId" = $1) AS profiles,
                (SELECT count(*) FROM pharmacy_branches WHERE "organizationId" = $1) AS branches,
                (SELECT count(*) FROM pharmacy_stock_locations WHERE "organizationId" = $1) AS locations,
                (SELECT count(*) FROM pharmacy_onboarding_events WHERE "organizationId" = $1) AS events,
                (SELECT count(*) FROM pharmacy_onboarding_states WHERE "organizationId" = $1) AS states,
                (SELECT count(*) FROM camera_evidence WHERE "organizationId" = $1) AS evidence,
                (SELECT count(*) FROM cameras WHERE "organizationId" = $1) AS cameras,
                (SELECT count(*) FROM audit_logs WHERE "organizationId" = $1) AS audits`,
        PURGED_ORG
      )
    );
    // The branch aggregate is the row the issue reports as outliving its tenant.
    // `count(*)` arrives as a bigint; the tsconfig target predates bigint
    // literals, so compare against BigInt(0) rather than 0n.
    const none = BigInt(0);
    expect(remaining).toEqual({
      profiles: none,
      branches: none,
      locations: none,
      events: none,
      states: none,
      evidence: none,
      cameras: none,
      audits: none,
    });

    const [live] = await withPlatformDb((db) =>
      db.$queryRawUnsafe<Array<Record<string, bigint>>>(
        `SELECT (SELECT count(*) FROM pharmacy_branch_regulatory_profiles WHERE "organizationId" = $1) AS profiles,
                (SELECT count(*) FROM pharmacy_branches WHERE "organizationId" = $1) AS branches,
                (SELECT count(*) FROM audit_logs WHERE "organizationId" = $1) AS audits`,
        LIVE_ORG
      )
    );
    expect(live).toEqual({ profiles: BigInt(1), branches: BigInt(1), audits: BigInt(1) });

    const organization = await withPlatformDb((db) =>
      db.organization.findUniqueOrThrow({
        where: { id: PURGED_ORG },
        select: { status: true },
      })
    );
    expect(organization.status).toBe('PURGED');
  });

  it('keeps regulatory profiles append-only outside the exact purge context', async () => {
    const role = await withPlatformDb(
      (db) =>
        db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `
    );
    expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false });

    await expect(
      withPlatformDb((db) =>
        db.$executeRawUnsafe(
          `DELETE FROM pharmacy_branch_regulatory_profiles WHERE id = $1`,
          LIVE_PROFILE_ID
        )
      )
    ).rejects.toThrow(/append-only/);

    await expect(
      withPlatformDb((db) =>
        db.$executeRawUnsafe(
          `UPDATE pharmacy_branch_regulatory_profiles SET "licenceNumber" = 'rewritten' WHERE id = $1`,
          LIVE_PROFILE_ID
        )
      )
    ).rejects.toThrow(/append-only/);

    await expect(
      withPlatformDb(async (db) => {
        await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${PURGED_ORG}, true)`;
        return db.$executeRawUnsafe(
          `DELETE FROM pharmacy_branch_regulatory_profiles WHERE id = $1`,
          LIVE_PROFILE_ID
        );
      })
    ).rejects.toThrow(/append-only/);

    await withPlatformDb((db) =>
      db.$executeRawUnsafe(
        `UPDATE pharmacy_branch_regulatory_profiles SET "effectiveTo" = '2026-10-01' WHERE id = $1`,
        LIVE_PROFILE_ID
      )
    );

    const deletedRules = await withPlatformDb((db) =>
      db.$executeRawUnsafe(
        `DELETE FROM pharmacy_jurisdiction_rule_sets WHERE id = 'pk_pb_provisional_v1'`
      )
    );
    expect(deletedRules).toBe(0);
    const [rules] = await withPlatformDb(
      (db) =>
        db.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM pharmacy_jurisdiction_rule_sets
        WHERE id = 'pk_pb_provisional_v1'
      `
    );
    expect(rules.count).toBe(BigInt(1));
  });

  /**
   * H1-03 — a hospitality tenant with inventory. Two facts would have stopped
   * it from ever being destroyed, and neither survives a mock: the status
   * ledger and the block table refuse DELETE by trigger for every role, and
   * `hotel_rooms` references itself (connecting rooms) while every other
   * inventory table references it. The purge has to finish, every hotel row
   * has to be gone, and the live tenant's ledger has to stay append-only.
   */
  async function seedHotelInventory(organizationId: string, status: 'PURGING' | 'ACTIVE') {
    const { seedHotelTenant } = await import('@/lib/testing/hotel-tenant-fixture');
    const inventory = await import('@/lib/hotel/inventory');
    const tenant = await seedHotelTenant(withPlatformDb, {
      organizationId,
      status,
      properties: [{ name: `${status} property` }],
    });
    const scope = { organizationId, branchId: tenant.branchIds[0]!, actorId: tenant.userId };
    const run = <T>(
      reason: string,
      work: (tx: Parameters<typeof inventory.createInventoryRoom>[0]) => Promise<T>
    ) =>
      withTenantDb(organizationId, (tx) => inventory.withHotelInventory(tx, scope, reason, work), {
        userId: tenant.userId,
      });
    const dorm = await run('Seed', (tx) =>
      tx.hotelRoomType.create({
        data: {
          organizationId,
          branchId: scope.branchId,
          code: 'DORM',
          name: 'Dormitory',
          inventoryKind: 'BED',
          bedsPerRoom: 2,
        },
      })
    );
    const first = await run('Commissioned', (tx) =>
      inventory.createInventoryRoom(
        tx,
        scope,
        inventory.hotelRoomCreateInput.parse({
          roomTypeId: dorm.id,
          number: '101',
          reason: 'Commissioned',
        })
      )
    );
    const second = await run('Commissioned', (tx) =>
      inventory.createInventoryRoom(
        tx,
        scope,
        inventory.hotelRoomCreateInput.parse({
          roomTypeId: dorm.id,
          number: '102',
          reason: 'Commissioned',
          connectingRoomId: first.id,
        })
      )
    );
    await run('Cleaned', (tx) =>
      inventory.setInventoryStatus(tx, scope, 'bed', {
        id: first.beds[0]!.id,
        expectedStatus: 'VACANT_DIRTY',
        status: 'VACANT_CLEAN',
        reason: 'Cleaned',
      })
    );
    await run('Leak', (tx) =>
      inventory.createInventoryBlock(tx, scope, {
        roomId: second.id,
        kind: 'OUT_OF_ORDER',
        startDate: '2030-03-01',
        endDate: '2030-03-04',
        reason: 'Leak',
      })
    );
    await withPlatformDb((db) =>
      db.hotelExtra.create({
        data: {
          organizationId,
          branchId: scope.branchId,
          code: 'LAUNDRY',
          name: 'Laundry',
          priceMinor: 1000,
          taxClass: 'SERVICES',
          department: 'LAUNDRY',
        },
      })
    );
    // H1-07 — the plans provisioning seeds, as a CASCADE child of the property.
    await withPlatformDb((db) =>
      db.hotelMealPlan.create({
        data: {
          organizationId,
          branchId: scope.branchId,
          code: 'CP',
          name: 'Bed & breakfast',
          meals: [{ meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: true }],
        },
      })
    );
    // H1-05 — a function space (RESTRICT child of the property) and a claim on
    // its time (RESTRICT child of the space, written in SQL as every claim is).
    const space = await withPlatformDb((db) =>
      db.hotelFunctionSpace.create({
        data: {
          organizationId,
          branchId: scope.branchId,
          name: 'Crystal Hall',
          layouts: [{ layout: 'Theatre', capacity: 300 }],
          setupMinutes: 30,
          teardownMinutes: 15,
        },
        select: { id: true },
      })
    );
    await withPlatformDb((db) =>
      db.$executeRawUnsafe(
        `INSERT INTO hotel_space_bookings ("organizationId", "branchId", "spaceId", "startsAt", "endsAt", kind, "createdBy", "updatedAt")
         VALUES ($1, $2, $3, '2030-05-01T10:00:00Z', '2030-05-01T12:00:00Z', 'HOLD', $4, now())`,
        organizationId,
        scope.branchId,
        space.id,
        tenant.userId
      )
    );
    // H1-14 — a guest-message draft (RESTRICT child of the property), as
    // provisioning seeds it.
    await withPlatformDb((db) =>
      db.hotelJourneyTemplate.create({
        data: {
          organizationId,
          branchId: scope.branchId,
          moment: 'WELCOME',
          channel: 'WHATSAPP',
          language: 'EN',
          body: 'Dear {{guest_name}}, welcome to {{property_name}}.',
          createdByUserId: tenant.userId,
        },
      })
    );
    return { ...tenant, branchId: scope.branchId };
  }

  const HOTEL_TABLES = [
    'hotel_room_status_events',
    'hotel_room_blocks',
    'hotel_beds',
    'hotel_rooms',
    'hotel_room_types',
    'hotel_meal_plans',
    'hotel_space_bookings',
    'hotel_function_spaces',
    'hotel_journey_templates',
    'hotel_extras',
    'hotel_property_assignments',
    'hotel_properties',
  ] as const;
  async function hotelRowCounts(organizationId: string) {
    const [row] = await withPlatformDb((db) =>
      db.$queryRawUnsafe<Array<Record<string, bigint>>>(
        HOTEL_TABLES.map(
          (table, index) =>
            `${index === 0 ? 'SELECT' : ','} (SELECT count(*) FROM "${table}" WHERE "organizationId" = $1) AS "${table}"`
        ).join(' '),
        organizationId
      )
    );
    return Object.fromEntries(Object.entries(row!).map(([table, count]) => [table, Number(count)]));
  }

  it('purges a hospitality tenant whose inventory ledger and blocks refuse ordinary deletes', async () => {
    await seedHotelInventory(HOTEL_PURGED_ORG, 'PURGING');
    await seedHotelInventory(HOTEL_LIVE_ORG, 'ACTIVE');
    const before = await hotelRowCounts(HOTEL_PURGED_ORG);
    // Two dorm rooms with two berths each, every one with its first ledger
    // line, one bed cleaned: 2 + 4 + 1 lines.
    expect(before).toMatchObject({
      hotel_room_status_events: 7,
      hotel_room_blocks: 1,
      hotel_beds: 4,
      hotel_rooms: 2,
      hotel_room_types: 1,
      hotel_meal_plans: 1,
      hotel_space_bookings: 1,
      hotel_function_spaces: 1,
      hotel_journey_templates: 1,
      hotel_extras: 1,
      hotel_property_assignments: 1,
      hotel_properties: 1,
    });

    await withPlatformDb(async (db) => {
      await db.$executeRawUnsafe(
        `INSERT INTO platform_jobs (id, "organizationId", type, status, payload, "maxAttempts", "updatedAt")
         VALUES ($1, $2, 'PURGE_DATA', 'QUEUED', '{}'::jsonb, 1, now())`,
        HOTEL_JOB_ID,
        HOTEL_PURGED_ORG
      );
      await db.$executeRawUnsafe(
        `UPDATE platform_jobs SET "scheduledAt" = '1900-01-01', "createdAt" = '1900-01-01' WHERE id = $1`,
        HOTEL_JOB_ID
      );
    });
    const result = await processPlatformJobs(1);
    const job = await withPlatformDb((db) =>
      db.platformJob.findUniqueOrThrow({
        where: { id: HOTEL_JOB_ID },
        select: { status: true, error: true },
      })
    );
    expect({
      status: job.status,
      error: job.error,
      succeeded: result.succeeded,
      failed: result.failed,
    }).toEqual({
      status: 'SUCCEEDED',
      error: null,
      succeeded: 1,
      failed: 0,
    });
    expect(await hotelRowCounts(HOTEL_PURGED_ORG)).toEqual(
      Object.fromEntries(HOTEL_TABLES.map((table) => [table, 0]))
    );
    expect(await hotelRowCounts(HOTEL_LIVE_ORG)).toMatchObject({
      hotel_room_status_events: 7,
      hotel_room_blocks: 1,
      hotel_rooms: 2,
      hotel_meal_plans: 1,
      hotel_space_bookings: 1,
      hotel_function_spaces: 1,
      hotel_journey_templates: 1,
      hotel_properties: 1,
    });
    const organization = await withPlatformDb((db) =>
      db.organization.findUniqueOrThrow({
        where: { id: HOTEL_PURGED_ORG },
        select: { status: true },
      })
    );
    expect(organization.status).toBe('PURGED');
  });

  it('keeps the live tenant’s inventory ledger append-only and its blocks undeletable outside the exact purge context', async () => {
    await expect(
      withPlatformDb((db) =>
        db.$executeRawUnsafe(
          `DELETE FROM hotel_room_status_events WHERE "organizationId" = $1`,
          HOTEL_LIVE_ORG
        )
      )
    ).rejects.toThrow(/append-only/);
    await expect(
      withPlatformDb((db) =>
        db.$executeRawUnsafe(
          `UPDATE hotel_room_status_events SET reason = 'rewritten' WHERE "organizationId" = $1`,
          HOTEL_LIVE_ORG
        )
      )
    ).rejects.toThrow(/append-only/);
    await expect(
      withPlatformDb((db) =>
        db.$executeRawUnsafe(
          `DELETE FROM hotel_room_blocks WHERE "organizationId" = $1`,
          HOTEL_LIVE_ORG
        )
      )
    ).rejects.toThrow(/Release inventory blocks/);
    // Naming ANOTHER organization in the purge GUC unlocks nothing here.
    await expect(
      withPlatformDb(async (db) => {
        await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${HOTEL_PURGED_ORG}, true)`;
        return db.$executeRawUnsafe(
          `DELETE FROM hotel_room_status_events WHERE "organizationId" = $1`,
          HOTEL_LIVE_ORG
        );
      })
    ).rejects.toThrow(/append-only/);
    expect(await hotelRowCounts(HOTEL_LIVE_ORG)).toMatchObject({
      hotel_room_status_events: 7,
      hotel_room_blocks: 1,
    });
  });

  it('keeps the onboarding history append-only while the tenant exists', async () => {
    await expect(
      withPlatformDb((db) =>
        db.$executeRawUnsafe(
          `DELETE FROM pharmacy_onboarding_events WHERE "organizationId" = $1`,
          LIVE_ORG
        )
      )
    ).rejects.toThrow(/append-only/);

    await expect(
      withPlatformDb((db) =>
        db.$executeRawUnsafe(
          `UPDATE pharmacy_onboarding_events SET note = 'rewritten' WHERE "organizationId" = $1`,
          LIVE_ORG
        )
      )
    ).rejects.toThrow(/append-only/);

    // Still exactly one row, and the tenant is still deletable: the declared
    // ON DELETE CASCADE now reaches the history instead of being refused by it.
    const [before] = await withPlatformDb((db) =>
      db.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM pharmacy_onboarding_events WHERE "organizationId" = $1`,
        LIVE_ORG
      )
    );
    expect(before.count).toBe(BigInt(1));

    await withPlatformDb((db) =>
      db.$executeRawUnsafe(`DELETE FROM organizations WHERE id = $1`, LIVE_ORG)
    );

    // Once the parent is gone, fixture teardown may remove the effective-dated
    // profile without disabling its trigger, then remove its branch.
    await withPlatformDb(async (db) => {
      await db.$executeRawUnsafe(
        `DELETE FROM pharmacy_branch_regulatory_profiles WHERE id = $1`,
        LIVE_PROFILE_ID
      );
      await db.$executeRawUnsafe(`DELETE FROM pharmacy_branches WHERE id = $1`, LIVE_BRANCH_ID);
    });

    const [after] = await withPlatformDb((db) =>
      db.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM pharmacy_onboarding_events WHERE "organizationId" = $1`,
        LIVE_ORG
      )
    );
    expect(after.count).toBe(BigInt(0));
  });

  /**
   * The purge name is honoured only inside the control plane's transaction.
   * A tenant's own runtime (`withTenantDb`: `app.is_platform_admin` = 'false')
   * reaches every one of its guarded rows through row-level security, so if it
   * names its own organization as the one being purged, the guards are all that
   * stands between it and its own append-only history.
   */
  it('refuses the purge name alone in a tenant-runtime transaction: guarded rows are neither deleted nor rewritten', async () => {
    await withPlatformDb(async (db) => {
      await seedTenant(db, TENANT_ORG, 'ACTIVE');
      await db.$executeRawUnsafe(
        `INSERT INTO pharmacy_branches (id, "organizationId", code, name, "addressLine", city, "provinceCode", "updatedAt")
         VALUES ($1, $2, $1, 'Tenant branch', '16 Mall Road', 'Lahore', 'PB', now())`,
        TENANT_BRANCH_ID,
        TENANT_ORG
      );
      await seedRegulatoryProfile(db, TENANT_PROFILE_ID, TENANT_ORG, TENANT_BRANCH_ID);
      await seedCameraEvidence(db, TENANT_ORG, TENANT_BRANCH_ID);
    });
    const hotel = await seedHotelInventory(HOTEL_TENANT_ORG, 'ACTIVE');

    const guarded = [
      {
        organizationId: TENANT_ORG,
        userId: undefined,
        table: 'pharmacy_onboarding_events',
        refusedDelete: /append-only/,
        rewrite: `UPDATE pharmacy_onboarding_events SET note = 'rewritten' WHERE "organizationId" = $1`,
        refusedRewrite: /append-only/,
      },
      {
        organizationId: TENANT_ORG,
        userId: undefined,
        table: 'pharmacy_branch_regulatory_profiles',
        refusedDelete: /append-only/,
        rewrite: `UPDATE pharmacy_branch_regulatory_profiles SET "licenceNumber" = 'rewritten' WHERE "organizationId" = $1`,
        refusedRewrite: /append-only/,
      },
      {
        organizationId: TENANT_ORG,
        userId: undefined,
        table: 'camera_evidence',
        refusedDelete: /camera evidence is retained/,
        rewrite: `UPDATE camera_evidence SET "subjectId" = 'rewritten' WHERE "organizationId" = $1`,
        refusedRewrite: /binding is immutable/,
      },
      {
        organizationId: HOTEL_TENANT_ORG,
        userId: hotel.userId,
        table: 'hotel_room_status_events',
        refusedDelete: /append-only/,
        rewrite: `UPDATE hotel_room_status_events SET reason = 'rewritten' WHERE "organizationId" = $1`,
        refusedRewrite: /append-only/,
      },
      {
        organizationId: HOTEL_TENANT_ORG,
        userId: hotel.userId,
        table: 'hotel_room_blocks',
        refusedDelete: /Release inventory blocks/,
        rewrite: `UPDATE hotel_room_blocks SET reason = 'rewritten' WHERE "organizationId" = $1`,
        refusedRewrite: /only one attributed release/,
      },
    ];
    /** One tenant transaction that names its own organization as the one being purged. */
    const asPurgingTenant = (organizationId: string, userId: string | undefined, sql: string) =>
      withTenantDb(
        organizationId,
        async (db) => {
          await db.$queryRaw`SELECT set_config('app.purging_organization_id', ${organizationId}, true)`;
          const [context] = await db.$queryRawUnsafe<Array<{ platform: string; purging: string }>>(
            `SELECT current_setting('app.is_platform_admin', true) AS platform,
                    current_setting('app.purging_organization_id', true) AS purging`
          );
          expect(context).toEqual({ platform: 'false', purging: organizationId });
          return db.$executeRawUnsafe(sql, organizationId);
        },
        { userId }
      );
    const visibleToTenant = async (organizationId: string, table: string) => {
      const [row] = await withTenantDb(organizationId, (db) =>
        db.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT count(*) AS count FROM "${table}" WHERE "organizationId" = $1`,
          organizationId
        )
      );
      return Number(row!.count);
    };

    for (const row of guarded) {
      const before = await visibleToTenant(row.organizationId, row.table);
      // The rows are the tenant's own and visible to it, so a refusal below is
      // the guard's decision, not row-level security hiding them.
      expect(before, row.table).toBeGreaterThan(0);
      await expect(
        asPurgingTenant(
          row.organizationId,
          row.userId,
          `DELETE FROM "${row.table}" WHERE "organizationId" = $1`
        ),
        `${row.table} DELETE`
      ).rejects.toThrow(row.refusedDelete);
      await expect(
        asPurgingTenant(row.organizationId, row.userId, row.rewrite),
        `${row.table} UPDATE`
      ).rejects.toThrow(row.refusedRewrite);
      expect(await visibleToTenant(row.organizationId, row.table), row.table).toBe(before);
    }
  });
});
