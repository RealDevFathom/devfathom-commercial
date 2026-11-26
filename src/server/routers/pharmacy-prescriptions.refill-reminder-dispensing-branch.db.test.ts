/**
 * DEV-962 — a fill has one refill reminder slot, and only the branch that dispensed the fill
 * may take it (an organisation admin excepted, the counter's branch rule). Against migrated
 * PostgreSQL with FORCE row level security, as the NOSUPERUSER/NOBYPASSRLS runtime role, with
 * the real router and ABAC; only the tRPC audit-log writer is stubbed.
 *
 *   - a fill records the branch it was dispensed at;
 *   - a pharmacist of another branch is refused that fill's reminder and the slot stays free;
 *   - the dispensing branch's own pharmacist is accepted;
 *   - an organisation admin is accepted at any branch;
 *   - a fill whose dispensing branch is not recorded is left to an admin;
 *   - the migration's backfill gives an older fill of a one-branch organization its branch
 *     (needs PHARMACY_TEST_OWNER_DATABASE_URL, the role that ran the migrations).
 *
 * Skipped unless TEST_DATABASE_URL names the runtime role on a migrated disposable database.
 */
import { randomBytes } from 'node:crypto';

import { readFileSync } from 'node:fs';

import pg from 'pg';
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
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? '';
const describeIfOwner = databaseUrl && ownerUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type PrescriptionsApi = {
  fill: (input: {
    id: string;
    prescriptionLineId: string;
    fillSequence: number;
    quantityCanonicalUnits: number;
    idempotencyKey: string;
    branchId?: string;
  }) => Promise<{ id: string; branchId: string | null }>;
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
let seedDepartments: typeof import('@/lib/test-support/departments').seedDepartments;

const suffix = randomBytes(5).toString('hex');
const OUTSIDE_SCOPE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };
const DISPENSED_ELSEWHERE = { code: 'FORBIDDEN', message: 'FILL_DISPENSED_AT_ANOTHER_BRANCH' };
const BRANCH_UNKNOWN = { code: 'FORBIDDEN', message: 'FILL_BRANCH_UNKNOWN' };

const X = {
  org: `org_dev962_${suffix}`,
  north: `br962_north_${suffix}`,
  south: `br962_south_${suffix}`,
  admin: `admin_${suffix}`,
  owner: `u962_owner_${suffix}`,
  pharmacist: `u962_north_${suffix}`,
  southPharmacist: `u962_south_${suffix}`,
};
/** A one-branch tenant, for the migration's backfill. */
const Y = {
  org: `org_dev962_one_${suffix}`,
  branch: `br962_one_${suffix}`,
  user: `u962_one_${suffix}`,
};
/** Fills the north pharmacist dispensed at north, through the router. */
const fills: string[] = [];
/** A fill recorded without a branch (before DEV-962, or by a caller that sent none). */
let legacyFill = '';
let prescriptionLineId = '';
let yFill = '';

type Actor = { userId: string; tenantRole: 'ADMIN' | 'EMPLOYEE' };
const ADMIN: Actor = { userId: X.admin, tenantRole: 'ADMIN' };
const OWNER: Actor = { userId: X.owner, tenantRole: 'ADMIN' };
const PHARMACIST: Actor = { userId: X.pharmacist, tenantRole: 'EMPLOYEE' };
const SOUTH: Actor = { userId: X.southPharmacist, tenantRole: 'EMPLOYEE' };

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
    (db) =>
      db.pharmacyRefillReminderCapture.findMany({
        where: { prescriptionFillId: fillId },
        select: { branchId: true, capturedByUserId: true },
      }),
    { userId: X.owner, timeout: 60_000 }
  );
}

const reminder = (branchId: string, fillId: string) => ({
  branchId,
  fillId,
  channel: 'SMS' as const,
  directionsUrdu: 'Synthetic Urdu directions',
  idempotencyKey: `reminder-${branchId}-${fillId}`,
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
  ({ seedDepartments } = await import('@/lib/test-support/departments'));
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
      data: { id: Y.branch, code: `ONE-${suffix}`, name: 'DEV-962 one branch', ...address },
    })
  );
  await withTenantDb(
    X.org,
    async (tx) => {
      await seedDepartments(tx, [X.org], ['LEADERSHIP']);
      for (const [userId, tenantRole] of [
        [X.owner, 'ADMIN'],
        [X.admin, 'ADMIN'],
        [X.pharmacist, 'EMPLOYEE'],
        [X.southPharmacist, 'EMPLOYEE'],
      ] as const) {
        await tx.organizationRole.create({
          data: {
            id: `role_${userId}`,
            key: userId === X.owner ? 'owner' : `role_${userId}`,
            isSystem: userId === X.owner,
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
          data: { id, code: `${code}-${suffix}`, name: `DEV-962 ${code}`, ...address },
        });
      }
      // One pharmacist per branch; the owner holds no assignment at all.
      await tx.pharmacyBranchAssignment.create({ data: { userId: X.admin, branchId: X.north } });
      await tx.pharmacyBranchAssignment.create({
        data: { userId: X.pharmacist, branchId: X.north },
      });
      await tx.pharmacyBranchAssignment.create({
        data: { userId: X.southPharmacist, branchId: X.south },
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
        data: { name: 'Dr Synthetic', registrationNumber: `PMDC-962-${suffix}` },
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
      prescriptionLineId = prescription.lines[0]!.id;
      // An older fill, recorded with no branch (the column is new in DEV-962).
      legacyFill = (
        await tx.prescriptionFill.create({
          data: {
            prescriptionLineId,
            fillSequence: 1,
            quantityCanonicalUnits: 20,
            dispensedByUserId: X.pharmacist,
            idempotencyKey: `fill-962-legacy-${suffix}`,
          },
        })
      ).id;
    },
    { userId: X.owner, timeout: 60_000 }
  );
  // The north pharmacist dispenses five fills at north, through the router.
  for (let sequence = 2; sequence <= 6; sequence += 1) {
    const fill = await as(PHARMACIST, (api) =>
      api.fill({
        id: `fill962_${sequence}_${suffix}`,
        prescriptionLineId,
        fillSequence: sequence,
        quantityCanonicalUnits: 20,
        idempotencyKey: `fill-962-${sequence}-${suffix}`,
        branchId: X.north,
      })
    );
    fills.push(fill.id);
  }
  // The one-branch tenant's older fill, recorded with no branch.
  await withTenantDb(
    Y.org,
    async (tx) => {
      await seedDepartments(tx, [Y.org], ['LEADERSHIP']);
      await tx.user.create({
        data: {
          id: Y.user,
          name: Y.user,
          email: `${Y.user}@example.test`,
          department: 'LEADERSHIP',
          title: 'Pharmacy staff',
          role: 'ADMIN',
          status: 'ACTIVE',
        },
      });
      const medicine = await tx.medicine.create({
        data: {
          productName: `Cetirizine ${suffix}`,
          productFamily: 'PHARMACEUTICAL',
          saleable: true,
          controlled: false,
          rx: false,
          presentations: { create: { presentation: 'Tablet, 10 per strip' } },
        },
        include: { presentations: true },
      });
      const patient = await tx.pharmacyPatient.create({ data: { displayName: 'Synthetic' } });
      const prescriber = await tx.pharmacyPrescriber.create({
        data: { name: 'Dr Synthetic', registrationNumber: `PMDC-962-one-${suffix}` },
      });
      const prescription = await tx.prescription.create({
        data: {
          patientId: patient.id,
          prescriberId: prescriber.id,
          sourceKind: 'PAPER_IMAGE',
          sourceFileRef: `paper:one:${suffix}`,
          validFrom: new Date('2026-01-01T00:00:00.000Z'),
          validUntil: new Date('2099-01-01T00:00:00.000Z'),
          authorizedRepeats: 0,
          capturedByUserId: Y.user,
          lines: {
            create: {
              lineNumber: 1,
              medicineId: medicine.id,
              presentationId: medicine.presentations[0]!.id,
              authorizedCanonicalUnits: 20,
              directions: 'Take one tablet once a day',
            },
          },
        },
        include: { lines: true },
      });
      yFill = (
        await tx.prescriptionFill.create({
          data: {
            prescriptionLineId: prescription.lines[0]!.id,
            fillSequence: 1,
            quantityCanonicalUnits: 20,
            dispensedByUserId: Y.user,
            idempotencyKey: `fill-962-one-${suffix}`,
          },
        })
      ).id;
    },
    { userId: Y.user, timeout: 60_000 }
  );
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase(
  'DEV-962 refill reminder slot of the dispensing branch (runtime role, RLS on)',
  () => {
    it('records the branch a fill was dispensed at, and only at a branch the caller works at', async () => {
      const stored = await withTenantDb(
        X.org,
        (db) =>
          db.prescriptionFill.findMany({
            where: { id: { in: [...fills, legacyFill] } },
            select: { id: true, branchId: true },
          }),
        { userId: X.owner, timeout: 60_000 }
      );
      expect(Object.fromEntries(stored.map((fill) => [fill.id, fill.branchId]))).toEqual({
        ...Object.fromEntries(fills.map((id) => [id, X.north])),
        [legacyFill]: null,
      });
      await expect(
        settle(
          as(SOUTH, (api) =>
            api.fill({
              id: `fill962_south_${suffix}`,
              prescriptionLineId,
              fillSequence: 6,
              quantityCanonicalUnits: 20,
              idempotencyKey: `fill-962-south-${suffix}`,
              branchId: X.north,
            })
          )
        )
      ).resolves.toEqual(OUTSIDE_SCOPE);
    });

    it('refuses a pharmacist of another branch the reminder of a fill north dispensed, leaving the slot free', async () => {
      const fillId = fills[0]!;
      // At his own branch: refused, the fill belongs to north.
      await expect(
        settle(as(SOUTH, (api) => api.captureRefillReminder(reminder(X.south, fillId))))
      ).resolves.toEqual(DISPENSED_ELSEWHERE);
      // At north: refused, he does not work there.
      await expect(
        settle(as(SOUTH, (api) => api.captureRefillReminder(reminder(X.north, fillId))))
      ).resolves.toEqual(OUTSIDE_SCOPE);
      expect(await remindersFor(fillId)).toEqual([]);
      // North still records its own reminder for the fill.
      await expect(
        as(PHARMACIST, (api) => api.captureRefillReminder(reminder(X.north, fillId)))
      ).resolves.toMatchObject({ branchId: X.north, capturedByUserId: X.pharmacist });
      expect(await remindersFor(fillId)).toEqual([
        { branchId: X.north, capturedByUserId: X.pharmacist },
      ]);
    });

    it('accepts the dispensing branch’s own pharmacist', async () => {
      const fillId = fills[1]!;
      await expect(
        as(PHARMACIST, (api) => api.captureRefillReminder(reminder(X.north, fillId)))
      ).resolves.toMatchObject({ branchId: X.north, capturedByUserId: X.pharmacist });
      expect(await remindersFor(fillId)).toEqual([
        { branchId: X.north, capturedByUserId: X.pharmacist },
      ]);
    });

    it('refuses a non-admitted branch and permits the dispensing branch’s administrator or a cross-branch System Owner', async () => {
      const fillId = fills[2]!;
      await expect(
        settle(as(ADMIN, (api) => api.captureRefillReminder(reminder(X.south, fillId))))
      ).resolves.toEqual(OUTSIDE_SCOPE);
      expect(await remindersFor(fillId)).toEqual([]);
      await expect(
        as(ADMIN, (api) => api.captureRefillReminder(reminder(X.north, fills[3]!)))
      ).resolves.toMatchObject({ branchId: X.north, capturedByUserId: X.admin });
      await expect(
        as(OWNER, (api) => api.captureRefillReminder(reminder(X.south, fillId)))
      ).resolves.toMatchObject({ branchId: X.south, capturedByUserId: X.owner });
      expect(await remindersFor(fillId)).toEqual([
        { branchId: X.south, capturedByUserId: X.owner },
      ]);
    });

    it('reserves a legacy unattributed fill for the System Owner while an admitted administrator can record an attributed fill', async () => {
      await expect(
        settle(as(ADMIN, (api) => api.captureRefillReminder(reminder(X.south, legacyFill))))
      ).resolves.toEqual(OUTSIDE_SCOPE);
      await expect(
        settle(as(ADMIN, (api) => api.captureRefillReminder(reminder(X.north, legacyFill))))
      ).resolves.toEqual(BRANCH_UNKNOWN);
      expect(await remindersFor(legacyFill)).toEqual([]);
      await expect(
        as(ADMIN, (api) => api.captureRefillReminder(reminder(X.north, fills[4]!)))
      ).resolves.toMatchObject({ branchId: X.north, capturedByUserId: X.admin });
      await expect(
        settle(as(PHARMACIST, (api) => api.captureRefillReminder(reminder(X.north, legacyFill))))
      ).resolves.toEqual(BRANCH_UNKNOWN);
      expect(await remindersFor(legacyFill)).toEqual([]);
      await expect(
        as(OWNER, (api) => api.captureRefillReminder(reminder(X.north, legacyFill)))
      ).resolves.toMatchObject({ branchId: X.north, capturedByUserId: X.owner });
    });
  }
);

describeIfOwner('DEV-962 migration backfill (as the migration owner)', () => {
  it('gives an older fill of a one-branch organization that branch, and changes nothing on a re-run', async () => {
    const branchOf = (org: string, id: string) =>
      withTenantDb(
        org,
        (db) => db.prescriptionFill.findFirstOrThrow({ where: { id }, select: { branchId: true } }),
        { userId: org === X.org ? X.owner : Y.user, timeout: 60_000 }
      );
    expect(await branchOf(Y.org, yFill)).toEqual({ branchId: null });
    for (let run = 0; run < 2; run += 1) {
      const owner = new pg.Client({ connectionString: ownerUrl });
      await owner.connect();
      try {
        // The whole file, with its own transaction and settings, as the schema owner.
        await owner.query(
          readFileSync(
            'prisma/migrations/20261118125700_pharmacy_prescription_fill_dispensing_branch/migration.sql',
            'utf8'
          )
        );
      } finally {
        await owner.end();
      }
      expect(await branchOf(Y.org, yFill)).toEqual({ branchId: Y.branch });
      // Two branches and no sale line: the branch is not provable, so it stays unknown.
      expect(await branchOf(X.org, legacyFill)).toEqual({ branchId: null });
      expect(await branchOf(X.org, fills[3]!)).toEqual({ branchId: X.north });
    }
    // Still append-only once the backfill is done.
    await expect(
      withTenantDb(
        Y.org,
        (db) => db.prescriptionFill.update({ where: { id: yFill }, data: { branchId: null } }),
        { userId: Y.user, timeout: 60_000 }
      )
    ).rejects.toThrow(/append-only/);
  });
});
