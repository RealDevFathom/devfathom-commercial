/**
 * @vitest-environment node
 *
 * DEV-1056, interim: `openDrawer` and a REGISTERED counter computer, against a REAL migrated
 * PostgreSQL through the real router, each call in its own tenant transaction.
 *
 * `deviceId` comes from the client. A drawer must not open in the name of a registered
 * counter computer that was revoked, or that is enrolled at another branch of the business.
 * An id that names no registered computer (an unenrolled browser's `counter-<uuid>`) opens
 * its drawer exactly as before: whether registration should be required is not decided here.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the restricted
 * runtime role (neither SUPERUSER nor BYPASSRLS, asserted first). Without it the suite
 * reports itself skipped rather than passing vacuously. Only the web identity boundary and
 * the audit row write are stubbed.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { workspaceToday } from '@/lib/timezone';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// `@/lib/db` reads DATABASE_URL on first use; everything that reaches it is imported inside
// the suite, after this line.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG = `dev1056_drawer_${suffix}`;
/** The branch the drawers are opened at. */
const HERE = `dev1056_here_${suffix}`;
/** Another active branch of the same business. */
const ELSEWHERE = `dev1056_elsewhere_${suffix}`;
const ACTOR = `dev1056_actor_${suffix}`;
const businessDate = new Date(`${workspaceToday('America/Chicago')}T00:00:00.000Z`);
const NOT_USABLE = {
  code: 'FORBIDDEN',
  message:
    'This counter computer is not active at this branch. Ask a manager to register it again.',
};

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];

/** The pharmacy sales procedures as ORG's administrator calls them, on one request's transaction. */
async function sales(db: ScopedDb) {
  const { pharmacySalesRouter } = await import('./pharmacy-sales');
  return pharmacySalesRouter.createCaller({
    db,
    entitlements: {
      organizationId: ORG,
      enabledModules: ['pharmacy-core', 'pharmacy-counter'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: { id: ACTOR, role: 'ADMIN', status: 'ACTIVE', organizationId: ORG },
    },
    organization: { id: ORG, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

const open = (branchId: string, deviceId: string) =>
  withTenantDb(
    ORG,
    async (db) =>
      (await sales(db)).openDrawer({ branchId, deviceId, businessDate, openingFloatMinor: 0 }),
    { userId: ACTOR }
  );

/** Enrol a counter computer at a branch, the way the enrolment writes the row. */
async function registerCounter(branchId: string, name: string, revoked = false) {
  const device = await withTenantDb(ORG, (db) =>
    db.pharmacyRegisteredDevice.create({
      data: {
        branchId,
        name,
        deviceSecretHash: randomBytes(32).toString('hex'),
        enrolledByActorId: ACTOR,
        ...(revoked ? { status: 'REVOKED' as const, revokedAt: new Date() } : {}),
      },
      select: { id: true },
    })
  );
  return device.id;
}

/** Drawer sessions recorded for a device id, per branch. */
async function drawersOf(deviceId: string) {
  const rows = await withTenantDb(ORG, (db) =>
    db.$queryRawUnsafe<Array<{ branchId: string; status: string }>>(
      `SELECT "branchId", status::text AS status FROM pharmacy_drawer_sessions
        WHERE "organizationId" = $1 AND "deviceId" = $2`,
      ORG,
      deviceId
    )
  );
  return rows.map((row) => `${row.branchId}:${row.status}`);
}

describeIfDatabase('DEV-1056 openDrawer and a registered counter computer', () => {
  beforeAll(async () => {
    const scoped = await import('@/lib/tenancy/scoped-db');
    withTenantDb = scoped.withTenantDb;
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    const { seedDepartments } = await import('@/lib/test-support/departments');
    await assertRlsEnforcingRole(scoped.withPlatformDb);
    await scoped.withPlatformDb(async (db) => {
      await db.$executeRawUnsafe(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
        ORG
      );
      await db.organization.update({
        where: { id: ORG },
        data: { currency: 'USD', timezone: 'America/Chicago' },
      });
    });
    await withTenantDb(ORG, async (db) => {
      await db.pharmacyBranch.createMany({
        data: [HERE, ELSEWHERE].map((id) => ({
          id,
          organizationId: ORG,
          code: id,
          name: `Branch ${id}`,
          addressLine: '1 Synthetic Road',
          city: 'Lahore',
          provinceCode: 'PB',
        })),
      });
      await seedDepartments(db, [ORG], ['LEADERSHIP']);
      await db.user.create({
        data: {
          id: ACTOR,
          name: 'Drawer test administrator',
          email: `${ACTOR}@example.test`,
          department: 'LEADERSHIP',
          title: 'Administrator',
          role: 'ADMIN',
        },
      });
      await db.userPermissionOverride.create({
        data: {
          userId: ACTOR,
          capability: 'pharmacy:counter',
          effect: 'ALLOW',
          reason: 'DEV-1056 drawer test',
        },
      });
      await db.pharmacyBranchAssignment.createMany({
        data: [
          { userId: ACTOR, branchId: HERE },
          { userId: ACTOR, branchId: ELSEWHERE },
        ],
      });
    });
  }, 120_000);

  it('opens a drawer for a counter computer registered and active at this branch', async () => {
    const device = await registerCounter(HERE, 'Front counter');
    const drawer = await open(HERE, device);
    expect(drawer).toMatchObject({ deviceId: device, branchId: HERE, status: 'OPEN' });
    expect(await drawersOf(device)).toEqual([`${HERE}:OPEN`]);
  });

  it('refuses a revoked counter computer, and opens no drawer', async () => {
    const device = await registerCounter(HERE, 'Retired counter', true);
    await expect(open(HERE, device)).rejects.toMatchObject(NOT_USABLE);
    expect(await drawersOf(device)).toEqual([]);
  });

  it('refuses a counter computer that is revoked after it was enrolled', async () => {
    const device = await registerCounter(HERE, 'Back counter');
    await withTenantDb(ORG, (db) =>
      db.pharmacyRegisteredDevice.update({
        where: { id: device },
        data: { status: 'REVOKED', revokedAt: new Date() },
      })
    );
    await expect(open(HERE, device)).rejects.toMatchObject(NOT_USABLE);
    expect(await drawersOf(device)).toEqual([]);
  });

  it('refuses another branch’s counter computer here, and still serves it at its own branch', async () => {
    const device = await registerCounter(ELSEWHERE, 'Other branch counter');
    await expect(open(HERE, device)).rejects.toMatchObject(NOT_USABLE);
    expect(await drawersOf(device)).toEqual([]);
    await expect(open(ELSEWHERE, device)).resolves.toMatchObject({
      deviceId: device,
      branchId: ELSEWHERE,
    });
    expect(await drawersOf(device)).toEqual([`${ELSEWHERE}:OPEN`]);
  });

  it('opens a drawer for an unregistered browser id exactly as before', async () => {
    const device = `counter-${randomUUID()}`;
    const drawer = await open(HERE, device);
    expect(drawer).toMatchObject({ deviceId: device, branchId: HERE, status: 'OPEN' });
    expect(await drawersOf(device)).toEqual([`${HERE}:OPEN`]);
  });
});
