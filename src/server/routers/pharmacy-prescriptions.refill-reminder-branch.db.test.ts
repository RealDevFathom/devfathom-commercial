/**
 * DEV-938 — recording a refill reminder honours the branch assignment, against migrated
 * PostgreSQL with FORCE row level security, as the NOSUPERUSER/NOBYPASSRLS runtime role.
 *
 * `pharmacy:dispense` says *what* a pharmacist may do; the reminder's branch still needs an
 * active assignment, or the session ADMIN (owner) exception. A refused request writes no
 * reminder. A branch of another organization gets the same refusal as a missing one. Real
 * router, real ABAC; only the tRPC audit-log writer is stubbed.
 *
 * Skipped unless TEST_DATABASE_URL names the runtime role on a migrated disposable database.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
if (databaseUrl) {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!/(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i.test(databaseName)) {
    throw new Error(
      'TEST_DATABASE_URL must name a dedicated disposable database (test, e2e, tmp, or disposable).'
    );
  }
  process.env.DATABASE_URL = databaseUrl;
}
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type PrescriptionsApi = {
  captureRefillReminder: (input: {
    branchId: string;
    fillId: string;
    channel: 'PHONE' | 'SMS' | 'WHATSAPP' | 'EMAIL';
    directionsUrdu: string;
    idempotencyKey: string;
  }) => Promise<{ id: string; branchId: string; capturedByUserId: string }>;
};
type Caller = { createCaller: (ctx: never) => { pharmacyPrescriptions: PrescriptionsApi } };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let appRouter: Caller;
let disconnect: (() => Promise<void>) | null = null;

const suffix = randomBytes(5).toString('hex');
const OUTSIDE_SCOPE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };
const BRANCH_NOT_FOUND = { code: 'NOT_FOUND', message: 'BRANCH_NOT_FOUND' };

const X = {
  org: `org_dev938_${suffix}`,
  north: `br938_north_${suffix}`,
  south: `br938_south_${suffix}`,
  /** Never created. */
  missing: `br938_missing_${suffix}`,
  owner: `u938_owner_${suffix}`,
  pharmacist: `u938_pharm_${suffix}`,
};
/** Another tenant, with its own active branch. */
const Y = { org: `org_dev938_other_${suffix}`, branch: `br938_other_${suffix}` };
const fills: string[] = [];

type Actor = { userId: string; tenantRole: 'ADMIN' | 'EMPLOYEE' };
const OWNER: Actor = { userId: X.owner, tenantRole: 'ADMIN' };
const PHARMACIST: Actor = { userId: X.pharmacist, tenantRole: 'EMPLOYEE' };

function context(db: ScopedDb, actor: Actor) {
  return {
    db,
    entitlements: {
      organizationId: X.org,
      enabledModules: ['pharmacy-dispensing'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 2,
    },
    session: {
      expires: 'later',
      user: {
        id: actor.userId,
        role: actor.tenantRole,
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: X.org,
      },
    },
    organization: { id: X.org, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
}

/** One request, in its own tenant transaction, the way the tRPC route runs it. */
function as<T>(actor: Actor, run: (api: PrescriptionsApi) => Promise<T>) {
  return withTenantDb(
    X.org,
    (db) => run(appRouter.createCaller(context(db, actor) as never).pharmacyPrescriptions),
    { userId: actor.userId, timeout: 60_000 }
  );
}

function remindersFor(fillId: string) {
  return withTenantDb(
    X.org,
    (db) => db.pharmacyRefillReminderCapture.count({ where: { prescriptionFillId: fillId } }),
    { userId: X.owner, timeout: 60_000 }
  );
}

const reminder = (branchId: string, fillId: string) => ({
  branchId,
  fillId,
  channel: 'SMS' as const,
  directionsUrdu: 'Synthetic Urdu directions',
  idempotencyKey: `reminder-${fillId}`,
});

const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message })
  );

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { router } = await import('../trpc');
  const { pharmacyPrescriptionsRouter } = await import('./pharmacy-prescriptions');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  // Keep the production procedure path so the module-licence guard runs.
  appRouter = router({ pharmacyPrescriptions: pharmacyPrescriptionsRouter }) as unknown as Caller;
  disconnect = () => db.$disconnect();
  // With SUPERUSER or BYPASSRLS this suite would pass for the wrong reason.
  await assertRlsEnforcingRole(withPlatformDb);

  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations
         (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now()),
              ($2, $2, $2, $2, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      X.org,
      Y.org
    )
  );
  const address = { addressLine: '1 Mall Road', city: 'Lahore', provinceCode: 'PB' };
  await withTenantDb(Y.org, (tx) =>
    tx.pharmacyBranch.create({
      data: { id: Y.branch, code: `OTH-${suffix}`, name: 'Another tenant', ...address },
    })
  );
  await withTenantDb(
    X.org,
    async (tx) => {
      await seedDepartments(tx, [X.org], ['LEADERSHIP']);
      for (const [userId, tenantRole] of [
        [X.owner, 'ADMIN'],
        [X.pharmacist, 'EMPLOYEE'],
      ] as const) {
        await tx.organizationRole.create({
          data: {
            id: `role_${userId}`,
            key: `role_${userId}`,
            name: userId,
            permissions: {
              create: ['pharmacy:dispense', 'pharmacy:prescriptions'].map((capability) => ({
                capability,
                effect: 'ALLOW' as const,
              })),
            },
          },
        });
        await tx.user.create({
          data: {
            id: userId,
            name: userId,
            email: `${userId}@example.test`,
            department: 'LEADERSHIP',
            title: 'Pharmacy staff',
            role: tenantRole,
            status: 'ACTIVE',
            organizationRoleId: `role_${userId}`,
          },
        });
      }
      for (const [id, code] of [
        [X.north, 'NOR'],
        [X.south, 'SOU'],
      ] as const) {
        await tx.pharmacyBranch.create({
          data: { id, code: `${code}-${suffix}`, name: `DEV-938 ${code}`, ...address },
        });
      }
      // The pharmacist works at north only; the owner holds no assignment at all.
      await tx.pharmacyBranchAssignment.create({
        data: { userId: X.pharmacist, branchId: X.north },
      });
      const medicine = await tx.medicine.create({
        data: {
          productName: `Paracetamol ${suffix}`,
          productFamily: 'PHARMACEUTICAL',
          saleable: true,
          controlled: false,
          rx: false,
          presentations: { create: { presentation: 'Tablet, 10 per strip' } },
        },
        include: { presentations: true },
      });
      const patient = await tx.pharmacyPatient.create({
        data: { displayName: 'Synthetic Patient' },
      });
      await tx.patientConsent.create({
        data: {
          patientId: patient.id,
          purpose: 'REMINDERS',
          channel: 'SMS',
          version: 1,
          granted: true,
          recordedByUserId: X.pharmacist,
        },
      });
      const prescriber = await tx.pharmacyPrescriber.create({
        data: { name: 'Dr Synthetic', registrationNumber: `PMDC-938-${suffix}` },
      });
      const prescription = await tx.prescription.create({
        data: {
          patientId: patient.id,
          prescriberId: prescriber.id,
          sourceKind: 'PAPER_IMAGE',
          sourceFileRef: `paper:${suffix}`,
          validFrom: new Date('2026-01-01T00:00:00.000Z'),
          validUntil: new Date('2099-01-01T00:00:00.000Z'),
          authorizedRepeats: 5,
          capturedByUserId: X.pharmacist,
          lines: {
            create: {
              lineNumber: 1,
              medicineId: medicine.id,
              presentationId: medicine.presentations[0]!.id,
              authorizedCanonicalUnits: 200,
              directions: 'Take one tablet twice a day',
            },
          },
        },
        include: { lines: true },
      });
      for (let sequence = 1; sequence <= 4; sequence += 1) {
        const fill = await tx.prescriptionFill.create({
          data: {
            prescriptionLineId: prescription.lines[0]!.id,
            fillSequence: sequence,
            quantityCanonicalUnits: 20,
            dispensedByUserId: X.pharmacist,
            idempotencyKey: `fill-938-${sequence}-${suffix}`,
          },
        });
        fills.push(fill.id);
      }
    },
    { userId: X.owner, timeout: 60_000 }
  );
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('DEV-938 refill reminder branch assignment (runtime role, RLS on)', () => {
  it('refuses a pharmacist at a branch they are not assigned to and writes nothing', async () => {
    const fillId = fills[0]!;
    await expect(
      settle(as(PHARMACIST, (api) => api.captureRefillReminder(reminder(X.south, fillId))))
    ).resolves.toEqual(OUTSIDE_SCOPE);
    expect(await remindersFor(fillId)).toBe(0);
  });

  it('gives another organization’s branch the same refusal as a missing branch', async () => {
    const fillId = fills[1]!;
    for (const actor of [PHARMACIST, OWNER]) {
      const foreign = await settle(
        as(actor, (api) => api.captureRefillReminder(reminder(Y.branch, fillId)))
      );
      const missing = await settle(
        as(actor, (api) => api.captureRefillReminder(reminder(X.missing, fillId)))
      );
      expect(foreign).toEqual(BRANCH_NOT_FOUND);
      expect(missing).toEqual(foreign);
    }
    expect(await remindersFor(fillId)).toBe(0);
  });

  it('records the reminder for the pharmacist at the branch they work at', async () => {
    const fillId = fills[2]!;
    await expect(
      as(PHARMACIST, (api) => api.captureRefillReminder(reminder(X.north, fillId)))
    ).resolves.toMatchObject({ branchId: X.north, capturedByUserId: X.pharmacist });
    expect(await remindersFor(fillId)).toBe(1);
  });

  it('leaves the owner able to record at a branch they hold no assignment to', async () => {
    const fillId = fills[3]!;
    await expect(
      as(OWNER, (api) => api.captureRefillReminder(reminder(X.south, fillId)))
    ).resolves.toMatchObject({ branchId: X.south, capturedByUserId: X.owner });
    expect(await remindersFor(fillId)).toBe(1);
  });
});
