// @vitest-environment node
/**
 * DEV-73 — the scheduled job that opens due refill-subscription cycles, against a
 * migrated PostgreSQL as the restricted runtime role (NOSUPERUSER, NOBYPASSRLS), with
 * the real `withPlatformDb` scan, the real `withTenantDb` transactions and the real
 * cycle rules. A mocked client would only show that the code calls Prisma.
 *
 * Pins:
 *   - two runs, one after the other and two at once, open exactly one cycle and one
 *     stock hold, and advance the schedule once;
 *   - the prescription-only cycle the job opens is held for the pharmacist: checkout is
 *     refused on the server, a sign-off naming no covering prescription is refused, and
 *     the database CHECK refuses a release that skips the approval;
 *   - another tenant cannot see the cycle;
 *   - the reminder for the cycle carries no medicine name.
 *
 * Requires M8_TEST_RUNTIME_DATABASE_URL or TEST_DATABASE_URL (restricted runtime role)
 * against a disposable migrated database; skipped otherwise.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG = `org_dev73_job_${suffix}`;
const OTHER_ORG = `org_dev73_other_${suffix}`;
const BRANCH = `branch_dev73_${suffix}`;
const OWNER = `user_dev73_owner_${suffix}`;
const PRODUCT = `Glucophage ${suffix}`;
const DAY = 86_400_000;
const PIN = '730194';
const ROLE = `role_dev73_pharmacist_${suffix}`;
let staffProfileId = '';

type Deps = {
  scoped: typeof import('@/lib/tenancy/scoped-db');
  job: typeof import('@/lib/pharmacy/refill-cycle-job');
  refills: typeof import('@/lib/pharmacy/refill-subscriptions');
  ledger: typeof import('@/lib/pharmacy/stock-ledger');
  credentials: typeof import('@/lib/restaurant/operator-credentials');
};
let deps: Deps;
let subscriptionId = '';
const scope = { organizationId: ORG, branchId: BRANCH, actorId: OWNER };

const inOrg = <T>(organizationId: string, work: (db: ScopedDb) => Promise<T>) =>
  deps.scoped.withTenantDb(organizationId, work, { userId: OWNER });

async function bindBranch(db: ScopedDb) {
  await db.$queryRaw`SELECT set_config('app.current_branch_id', ${BRANCH}, true)`;
}

async function cyclesOf(id: string) {
  return inOrg(ORG, async (db) => {
    await bindBranch(db);
    return db.pharmacyRefillSubscriptionCycle.findMany({
      where: { organizationId: ORG, subscriptionId: id },
    });
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scoped, job, refills, ledger, roleGuard, fixtures, credentials] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/pharmacy/refill-cycle-job'),
    import('@/lib/pharmacy/refill-subscriptions'),
    import('@/lib/pharmacy/stock-ledger'),
    import('@/lib/testing/rls-role-guard'),
    import('@/lib/test-support/departments'),
    import('@/lib/restaurant/operator-credentials'),
  ]);
  deps = { scoped, job, refills, ledger, credentials };
  await roleGuard.assertRlsEnforcingRole(scoped.withPlatformDb);

  await scoped.withPlatformDb(async (db) => {
    await db.organization.createMany({
      data: [ORG, OTHER_ORG].map((id) => ({
        id,
        slug: id,
        legalName: `Refill job ${id}`,
        displayName: `Refill job ${id}`,
        status: 'ACTIVE' as const,
        vertical: 'PHARMACY' as const,
        timezone: 'Asia/Karachi',
      })),
      skipDuplicates: true,
    });
    const counter = await fixtures.ensurePlatformModule(db as never, 'pharmacy-counter', {
      name: 'Pharmacy counter',
      category: 'Pharmacy',
    });
    await db.organizationModule.createMany({
      data: [{ organizationId: ORG, moduleId: counter.id }],
      skipDuplicates: true,
    });
  });

  subscriptionId = await inOrg(ORG, async (db) => {
    await fixtures.seedDepartments(db as never, [ORG], ['PHARMACY']);
    await db.organizationRole.create({
      data: {
        id: ROLE,
        key: `pharmacist_${suffix}`,
        name: 'Pharmacist',
        permissions: {
          create: [
            { capability: 'pharmacy:dispense', effect: 'ALLOW' },
            { capability: 'pharmacy:orders', effect: 'ALLOW' },
          ],
        },
      },
    });
    await db.user.create({
      data: {
        id: OWNER,
        organizationId: ORG,
        name: 'Sole owner-pharmacist',
        email: `${OWNER}@example.invalid`,
        department: 'PHARMACY',
        title: 'Owner',
        status: 'ACTIVE',
        organizationRoleId: ROLE,
      },
    });
    const profile = await db.restaurantStaffProfile.create({
      data: { organizationId: ORG, userId: OWNER, displayName: 'Sole owner-pharmacist' },
    });
    staffProfileId = profile.id;
    await db.restaurantOperatorCredential.create({
      data: {
        organizationId: ORG,
        staffProfileId: profile.id,
        type: 'PIN',
        credentialHash: await deps.credentials.hashOperatorCredential('PIN', PIN),
      },
    });
    await db.pharmacyBranch.create({
      data: {
        id: BRANCH,
        organizationId: ORG,
        code: BRANCH,
        name: 'Main branch',
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    // DEV-941: the sole owner-pharmacist works at this branch, so their PIN may approve its refills.
    await db.pharmacyBranchAssignment.create({
      data: { organizationId: ORG, userId: OWNER, branchId: BRANCH, active: true },
    });
    const patient = await db.pharmacyPatient.create({
      data: { organizationId: ORG, displayName: 'Chronic patient' },
    });
    const customer = await db.pharmacyCustomer.create({
      data: { organizationId: ORG, patientId: patient.id, displayName: 'Chronic patient' },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId: ORG,
        productName: PRODUCT,
        productFamily: 'PHARMACEUTICAL',
        rx: true,
        saleable: true,
        presentations: { create: { organizationId: ORG, presentation: 'Tablet 500 mg' } },
      },
      include: { presentations: true },
    });
    const presentationId = medicine.presentations[0]!.id;
    const pack = await db.packLevel.create({
      data: {
        organizationId: ORG,
        presentationId,
        versionGroupId: `strip-${suffix}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId: ORG,
        branchId: BRANCH,
        code: `MAIN-${suffix}`,
        name: 'Main store',
        kind: 'STORE',
      },
    });
    const expiresAt = new Date('2029-12-31T00:00:00.000Z');
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId: ORG,
        medicineId: medicine.id,
        batchNumber: `B-${suffix}`,
        expiresAt,
        expiryPrecision: 'DAY',
      },
    });
    await deps.ledger.receiveLot(db, scope, {
      manufacturingBatchId: batch.id,
      packLevelId: pack.id,
      stockLocationId: location.id,
      unitsPerPack: 10,
      supplierName: 'Distributor Ltd',
      supplierInvoiceRef: `INV-${suffix}`,
      unitCostMinor: 1200,
      printedMrpMinor: 2000,
      receivedExpiresAt: expiresAt,
      receivedExpiryPrecision: 'DAY',
      quantityUnits: 100,
      idempotencyKey: `receipt-${suffix}`,
      receivedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    const subscription = await deps.refills.createRefillSubscription(db, scope, {
      customerId: customer.id,
      medicineId: medicine.id,
      presentationId,
      packLevelId: pack.id,
      packsPerCycle: 3,
      cycleDays: 30,
      reminderLeadDays: 3,
      fulfillment: 'COLLECT',
      paymentMode: 'PREPAY',
      // Inside the three-day opening window.
      firstDueAt: new Date(Date.now() + 2 * DAY),
    });
    return subscription.id;
  });
}, 120_000);

afterAll(async () => {
  if (!TEST_DATABASE_URL || !subscriptionId) return;
  // Leave nothing for a later run of the job to open in a shared test database.
  await inOrg(ORG, (db) => deps.refills.cancelRefillSubscription(db, scope, subscriptionId));
});

describeIfDatabase('DEV-73 refill cycle job — PostgreSQL, runtime role', () => {
  it('opens one cycle however often, and however concurrently, the job runs', async () => {
    const before = await inOrg(ORG, async (db) => {
      await bindBranch(db);
      return db.pharmacyRefillSubscription.findFirstOrThrow({ where: { id: subscriptionId } });
    });

    await deps.job.processDueRefillSubscriptionCycles(new Date(), 500);
    await deps.job.processDueRefillSubscriptionCycles(new Date(), 500);
    await Promise.all([
      deps.job.processDueRefillSubscriptionCycles(new Date(), 500),
      deps.job.processDueRefillSubscriptionCycles(new Date(), 500),
    ]);

    const cycles = await cyclesOf(subscriptionId);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({
      dueAt: before.nextDueAt,
      status: 'AWAITING_PHARMACIST',
      requiresPharmacist: true,
      canonicalUnits: 30,
      openedByUserId: OWNER,
      approvedAt: null,
      prescriptionLineId: null,
    });
    const { after, holds, audits } = await inOrg(ORG, async (db) => {
      await bindBranch(db);
      return {
        after: await db.pharmacyRefillSubscription.findFirstOrThrow({
          where: { id: subscriptionId },
        }),
        holds: await db.pharmacyRestockReservation.findMany({
          where: {
            organizationId: ORG,
            branchId: BRANCH,
            status: 'RESERVED',
            interest: { campaignKey: `refill-cycle:${cycles[0]!.id}` },
          },
        }),
        audits: await db.auditLog.findMany({
          where: { organizationId: ORG, action: 'pharmacy.refillCycle.scheduledOpen' },
        }),
      };
    });
    expect(after.nextDueAt.getTime()).toBe(before.nextDueAt.getTime() + 30 * DAY);
    expect(holds.reduce((sum, row) => sum + row.reservedUnits, 0)).toBe(30);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'SYSTEM', targetId: cycles[0]!.id });
  });

  it('holds the prescription-only cycle until a covering prescription and a pharmacist signature', async () => {
    const [cycle] = await cyclesOf(subscriptionId);
    await expect(
      inOrg(ORG, (db) => deps.refills.startRefillCycleCheckout(db, scope, cycle!.id))
    ).rejects.toMatchObject({ reason: 'PHARMACIST_APPROVAL_REQUIRED' });

    // The sole owner-pharmacist re-enters their PIN: the approval is live, but it still
    // needs the prescription that covers this cycle. There is no emergency exception.
    const approval = await inOrg(ORG, (db) =>
      deps.refills.verifyRefillCyclePharmacistPin(db, scope, { staffProfileId, pin: PIN })
    );
    expect(approval).toMatchObject({ approvedByUserId: OWNER });
    await expect(
      inOrg(ORG, (db) =>
        deps.refills.approveRefillCycle(db, scope, cycle!.id, approval!, {
          prescriptionLineId: 'no-such-prescription-line',
        })
      )
    ).rejects.toMatchObject({ reason: 'PRESCRIPTION_NOT_FOUND' });
    // A wrong PIN is no approval at all.
    await expect(
      inOrg(ORG, (db) =>
        deps.refills.verifyRefillCyclePharmacistPin(db, scope, { staffProfileId, pin: '000000' })
      )
    ).resolves.toBeNull();

    // The database refuses a release that skips the pharmacist, whatever the code path.
    await expect(
      inOrg(ORG, async (db) => {
        await bindBranch(db);
        await db.pharmacyRefillSubscriptionCycle.update({
          where: { organizationId_id: { organizationId: ORG, id: cycle!.id } },
          data: { status: 'RESERVED' },
        });
      })
    ).rejects.toThrow(/pharmacy_refill_cycles_rx/);

    const [still] = await cyclesOf(subscriptionId);
    expect(still).toMatchObject({ status: 'AWAITING_PHARMACIST', counterSaleId: null });
  });

  it("keeps the cycle out of another tenant's reach", async () => {
    const seen = await inOrg(OTHER_ORG, async (db) => {
      await bindBranch(db);
      return db.pharmacyRefillSubscriptionCycle.findMany({
        where: { subscriptionId },
      });
    });
    expect(seen).toEqual([]);
  });

  it('lists the program, the solo pharmacist and no covering prescription for the screen', async () => {
    const [cycle] = await cyclesOf(subscriptionId);
    const { program, pharmacists, prescriptions } = await inOrg(ORG, async (db) => ({
      program: await deps.refills.listRefillProgram(db, scope),
      pharmacists: await deps.refills.listRefillCyclePharmacists(db, scope),
      prescriptions: await deps.refills.listRefillCyclePrescriptionCandidates(db, scope, cycle!.id),
    }));
    expect(program.find((row) => row.id === subscriptionId)).toMatchObject({
      item: { productName: PRODUCT, presentation: 'Tablet 500 mg', prescriptionOnly: true },
      cycles: [expect.objectContaining({ id: cycle!.id, status: 'AWAITING_PHARMACIST' })],
    });
    expect(pharmacists).toEqual([
      { id: staffProfileId, name: 'Sole owner-pharmacist', self: true },
    ]);
    expect(prescriptions).toEqual([]);
  });

  it('reminds with the due date only, never the medicine', async () => {
    const [cycle] = await cyclesOf(subscriptionId);
    const reminder = deps.refills.refillSubscriptionReminder(cycle!);
    const text = JSON.stringify(reminder);
    expect(text).not.toContain(PRODUCT);
    expect(text.toLowerCase()).not.toMatch(/glucophage|tablet|500 mg/);
    expect(reminder.parameters).toEqual([cycle!.dueAt.toISOString().slice(0, 10)]);
  });
});
