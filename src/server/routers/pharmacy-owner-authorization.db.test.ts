// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { assertDisposableRlsDatabase } from '../../../tests/disposable-rls-database';
import { runMigrationSql } from '../../../tests/split-sql-statements';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '../trpc';

const url = process.env.TEST_DATABASE_URL;
if (url) {
  assertDisposableRlsDatabase(url);
  process.env.DATABASE_URL = url;
}
vi.mock('@/server/audit', async () => ({
  ...(await vi.importActual('@/server/audit')),
  recordTrpcAudit: vi.fn(),
}));
const suite = url ? describe : describe.skip;
const suffix = randomUUID();
const org = `owner-auth-${suffix}`;
const owner = `owner-${suffix}`;
const second = `second-${suffix}`;
let tenant: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let platform: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let prescriptions: typeof import('./pharmacy-prescriptions').pharmacyPrescriptionsRouter;
let dispensing: typeof import('./pharmacy-dispensing').pharmacyDispensingRouter;
let can: typeof import('@/lib/abac').can;
let patientId: string, branchId: string, reviewId: string, credentialId: string;
const pin = '582961';
function context(db: ScopedDb, actorId = owner, role = 'ADMIN'): TRPCContext {
  return {
    db,
    session: { user: { id: actorId, role, status: 'ACTIVE', organizationId: org } },
    entitlements: { organizationId: org, enabledModules: ['pharmacy-dispensing', 'pharmacy-core'] },
    organization: { id: org, vertical: 'PHARMACY' },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
    support: null,
  } as unknown as TRPCContext;
}
beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  tenant = scoped.withTenantDb;
  platform = scoped.withPlatformDb;
  prescriptions = (await import('./pharmacy-prescriptions')).pharmacyPrescriptionsRouter;
  dispensing = (await import('./pharmacy-dispensing')).pharmacyDispensingRouter;
  can = (await import('@/lib/abac')).can;
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
  const hash = await hashOperatorCredential('PIN', pin);
  await platform(async (db) => {
    const [role] = await db.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    await db.organization.create({
      data: {
        id: org,
        pharmacyOperatingMode: 'SOLO',
        slug: org,
        legalName: 'Owner security test',
        displayName: 'Owner security test',
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        deploymentMode: 'SHARED',
      },
    });
  });
  await tenant(
    org,
    async (db) => {
      await seedDepartments(db, [org], ['LEADERSHIP']);
      const branch = await db.pharmacyBranch.create({
        data: { code: 'A', name: 'A', addressLine: 'Test', city: 'Test', provinceCode: 'PB' },
      });
      branchId = branch.id;
      // Model an existing owner with old incomplete grants, then apply the backfill.
      const role = await db.organizationRole.create({
        data: {
          key: 'owner',
          name: 'Owner',
          isSystem: true,
          permissions: { create: { capability: 'pharmacy:*', effect: 'ALLOW' } },
        },
      });
      await db.user.create({
        data: {
          id: owner,
          name: 'Owner',
          email: `${owner}@example.test`,
          title: 'Owner',
          department: 'LEADERSHIP',
          role: 'ADMIN',
          organizationRoleId: role.id,
        },
      });
      const backfill = readFileSync(
        'prisma/migrations/20261029105000_pharmacy_owner_authorization/migration.sql',
        'utf8'
      ).split('-- All lifecycle entry points:')[0];
      await runMigrationSql(db, backfill.replace(/^BEGIN;|COMMIT;/gm, ''));
      const profile = await db.restaurantStaffProfile.create({
        data: { userId: owner, displayName: 'Owner', status: 'ACTIVE' },
      });
      const credential = await db.restaurantOperatorCredential.create({
        data: { staffProfileId: profile.id, type: 'PIN', credentialHash: hash },
      });
      credentialId = credential.id;
      const patient = await db.pharmacyPatient.create({
        data: { displayName: 'Security patient' },
      });
      patientId = patient.id;
      const prescriber = await db.pharmacyPrescriber.create({
        data: { name: 'Prescriber', registrationNumber: `test-${suffix}` },
      });
      const medicine = await db.medicine.create({
        data: {
          productName: `Security medicine ${suffix}`,
          productFamily: 'PHARMACEUTICAL',
          rx: true,
          presentations: { create: { presentation: 'Tablet' } },
        },
        include: { presentations: true },
      });
      const presentationId = medicine.presentations[0].id;
      const pack = await db.packLevel.create({
        data: {
          presentationId,
          versionGroupId: `pack-${suffix}`,
          version: 1,
          level: 'STRIP',
          unitsPerParent: 10,
          effectiveFrom: new Date('2026-01-01'),
        },
      });
      const rx = await db.prescription.create({
        data: {
          patientId,
          prescriberId: prescriber.id,
          sourceKind: 'PAPER_IMAGE',
          sourceFileRef: 'test:owner-security',
          capturedByUserId: owner,
          validFrom: new Date('2026-01-01'),
          validUntil: new Date('2029-01-01'),
          lines: {
            create: {
              medicineId: medicine.id,
              presentationId,
              lineNumber: 1,
              directions: 'Once daily',
              authorizedCanonicalUnits: 10,
            },
          },
        },
        include: { lines: true },
      });
      const sale = await db.pharmacySale.create({
        data: { branchId, createdByUserId: owner, businessDate: new Date() },
      });
      const line = await db.pharmacySaleLine.create({
        data: {
          branchId,
          saleId: sale.id,
          medicineId: medicine.id,
          presentationId,
          packLevelId: pack.id,
          saleUnit: 'PACK',
          quantity: 1,
          canonicalUnitsPerSaleUnit: 10,
          canonicalUnits: 10,
          unitPriceMinor: 100,
          proRataCeilingMinor: 100,
          unitCostMinor: 50,
          idempotencyKey: `line-${suffix}`,
          prescriptionLineId: rx.lines[0].id,
          prescriptionPatientId: patientId,
        },
      });
      const review = await db.pharmacyPharmacistReviewItem.create({
        data: { prescriptionLineId: rx.lines[0].id, saleLineId: line.id, requestedByUserId: owner },
      });
      reviewId = review.id;
    },
    { timeout: 60_000 }
  );
}, 60_000);

suite('owner provisioning, branch access and PIN maker/checker in Postgres', () => {
  it('backfills every capability and autoassigns existing and newly created branches', async () => {
    await tenant(org, async (db) => {
      const { ALL_ACTIONS } = await import('@/lib/abac/policies');
      for (const action of ALL_ACTIONS)
        expect(
          await can(
            { id: owner, role: 'ADMIN', status: 'ACTIVE', department: null },
            action,
            { type: 'Resignation', userId: 'other', status: 'PENDING' },
            { db }
          )
        ).toBe(true);
      expect(
        await db.pharmacyBranchAssignment.count({
          where: { userId: owner, branchId, active: true },
        })
      ).toBe(1);
      const branch = await db.pharmacyBranch.create({
        data: { code: 'B', name: 'B', addressLine: 'Test', city: 'Test', provinceCode: 'PB' },
      });
      expect(
        await db.pharmacyBranchAssignment.count({
          where: { userId: owner, branchId: branch.id, active: true },
        })
      ).toBe(1);
      await expect(
        prescriptions.createCaller(context(db)).workspace({ branchId: branch.id })
      ).resolves.toMatchObject({ selectedBranchId: branch.id });
    });
  });
  it('keeps exact and wildcard DENYs stronger than owner grants', async () => {
    await tenant(org, async (db) => {
      const deny = await db.userPermissionOverride.create({
        data: {
          userId: owner,
          capability: 'pharmacy:*',
          effect: 'DENY',
          reason: 'Regression test',
        },
      });
      expect(
        await can(
          { id: owner, role: 'ADMIN', status: 'ACTIVE', department: null },
          'pharmacy:dispense',
          undefined,
          { db }
        )
      ).toBe(false);
      await expect(
        prescriptions.createCaller(context(db)).readPatient({ branchId, patientId })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await db.userPermissionOverride.delete({ where: { id: deny.id } });
    });
  });
  it('denies missing/wrong PIN, persists failure count, and records no decision or success audit', async () => {
    for (const entered of [undefined, '0000'])
      await tenant(org, async (db) => {
        await expect(
          dispensing
            .createCaller(context(db))
            .decideReview({ reviewItemId: reviewId, kind: 'SIGN', pin: entered })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(
          await db.pharmacyPharmacistReviewDecision.count({ where: { reviewItemId: reviewId } })
        ).toBe(0);
        expect(
          await db.auditLog.count({
            where: { action: 'PHARMACY:SOLO_OWNER_PIN', targetId: reviewId },
          })
        ).toBe(0);
      });
    await tenant(org, async (db) =>
      expect(
        (await db.restaurantOperatorCredential.findUniqueOrThrow({ where: { id: credentialId } }))
          .failedAttempts
      ).toBe(1)
    );
  });
  it('allows solo owner PIN signing with a durable audit and refuses direct SQL self approval', async () => {
    await expect(
      tenant(org, (db) =>
        db.pharmacyPharmacistReviewDecision.create({
          data: { reviewItemId: reviewId, kind: 'VERIFY', actorUserId: owner },
        })
      )
    ).rejects.toThrow();
    await tenant(org, async (db) => {
      await expect(
        dispensing
          .createCaller(context(db))
          .decideReview({ reviewItemId: reviewId, kind: 'SIGN', pin })
      ).resolves.toMatchObject({ actorUserId: owner, kind: 'SIGN' });
      const audit = await db.auditLog.findFirstOrThrow({
        where: { action: 'PHARMACY:SOLO_OWNER_PIN', targetId: reviewId },
      });
      expect(audit.metadata).toMatchObject({
        policy: 'PHARMACY:SOLO_OWNER_PIN',
        reauthentication: 'PIN',
      });
      expect(JSON.stringify(audit)).not.toContain(pin);
    });
    // Yesterday's (or the previous transaction's) proof cannot authorize another decision.
    await expect(
      tenant(org, (db) =>
        db.pharmacyPharmacistReviewDecision.create({
          data: { reviewItemId: reviewId, kind: 'VERIFY', actorUserId: owner },
        })
      )
    ).rejects.toThrow();
  });
  it('applies PIN maker/checker to purchase orders while preserving database constraints', async () => {
    const purchasing = (await import('./pharmacy-purchasing')).pharmacyPurchasingRouter;
    let orderId = '';
    await tenant(org, async (db) => {
      const supplier = await db.pharmacySupplier.create({
        data: {
          name: 'Security supplier',
          authorized: true,
          licences: {
            create: {
              licenceType: 'SALE',
              licenceNumber: 'test',
              verifiedAt: new Date(),
              verifiedByUserId: owner,
              issuingAuthority: 'Test',
              issuedAt: new Date('2026-01-01'),
              expiresAt: new Date('2029-01-01'),
            },
          },
        },
      });
      const order = await db.pharmacyPurchaseOrder.create({
        data: {
          branchId,
          reference: 'PIN-TEST',
          supplierId: supplier.id,
          createdByUserId: owner,
          status: 'SUBMITTED',
        },
      });
      orderId = order.id;
      await expect(
        purchasing
          .createCaller(context(db))
          .approvePurchaseOrder({ purchaseOrderId: order.id, decision: 'APPROVED' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'SELF_APPROVAL' });
      await expect(
        purchasing
          .createCaller(context(db))
          .approvePurchaseOrder({ purchaseOrderId: order.id, decision: 'APPROVED', pin })
      ).resolves.toMatchObject({ status: 'APPROVED', approvedByUserId: owner });
      expect(
        await db.auditLog.count({
          where: { targetId: order.id, action: 'PHARMACY:SOLO_OWNER_PIN' },
        })
      ).toBe(1);
    });
    await expect(
      tenant(org, (db) =>
        db.pharmacyPurchaseOrder.update({
          where: { id: orderId },
          data: { approvedAt: new Date() },
        })
      )
    ).rejects.toThrow();
  });
  it('offers the solo owner as a controlled witness and reauthenticates restoration with audit', async () => {
    const { listControlledPinWitnesses } = await import('@/lib/pharmacy/controlled-register');
    const { authorizeControlledRestoration } =
      await import('@/lib/pharmacy/controlled-restoration-authorization');
    await tenant(org, async (db) => {
      const profile = await db.restaurantStaffProfile.findFirstOrThrow({
        where: { userId: owner },
      });
      expect(await listControlledPinWitnesses(db, org, owner, branchId)).toContainEqual({
        id: profile.id,
        name: 'Owner',
      });
      const result = await authorizeControlledRestoration(
        db,
        { organizationId: org, branchId, actorId: owner },
        { staffProfileId: profile.id, pin }
      );
      expect(result.witnessedByUserId).toBe(owner);
      const audit = await db.auditLog.findFirstOrThrow({
        where: {
          targetId: result.signatureRef.slice('solo-restoration:'.length),
          action: 'PHARMACY:SOLO_OWNER_PIN',
        },
      });
      expect(audit.metadata).toMatchObject({ policy: 'PHARMACY:SOLO_OWNER_PIN', branchId });
      const [proof] = await db.$queryRaw<
        { allowed: boolean }[]
      >`SELECT pharmacy_has_solo_audit(${org}, ${branchId}, ${owner}, 'ControlledRestoration', (SELECT "targetId" FROM audit_logs WHERE id=current_setting('app.pharmacy_solo_audit_id', true))) AS allowed`;
      expect(proof.allowed).toBe(true);
    });
    await tenant(org, async (db) => {
      const [proof] = await db.$queryRaw<
        { allowed: boolean }[]
      >`SELECT pharmacy_has_solo_audit(${org}, ${branchId}, ${owner}, 'ControlledRestoration', (SELECT "targetId" FROM audit_logs WHERE id=current_setting('app.pharmacy_solo_audit_id', true))) AS allowed`;
      expect(proof.allowed).toBe(false);
    });
  });
  it('requires another approver when a second active staff member exists', async () => {
    await tenant(org, async (db) => {
      await db.organization.update({
        where: { id: org },
        data: { pharmacyOperatingMode: 'STAFFED' },
      });
      const pharmacist = await db.organizationRole.create({
        data: {
          key: 'pharmacist',
          name: 'Pharmacist',
          permissions: { create: { capability: 'pharmacy:dispense' } },
        },
      });
      await db.user.create({
        data: {
          id: second,
          name: 'Second',
          email: `${second}@example.test`,
          title: 'Pharmacist',
          department: 'LEADERSHIP',
          organizationRoleId: pharmacist.id,
        },
      });
      await db.pharmacyBranchAssignment.create({ data: { userId: second, branchId } });
      const branchB = await db.pharmacyBranch.findFirstOrThrow({ where: { code: 'B' } });
      await expect(
        prescriptions
          .createCaller(context(db, second, 'EMPLOYEE'))
          .readPatient({ branchId: branchB.id, patientId })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        prescriptions.createCaller(context(db, second, 'EMPLOYEE')).workspace()
      ).resolves.toMatchObject({ branches: [{ id: branchId, name: 'A' }] });
      await expect(
        dispensing
          .createCaller(context(db))
          .decideReview({ reviewItemId: reviewId, kind: 'SIGN', pin })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        dispensing
          .createCaller(context(db, second, 'EMPLOYEE'))
          .decideReview({ reviewItemId: reviewId, kind: 'SIGN' })
      ).resolves.toMatchObject({ actorUserId: second });
    });
  });
  it('allows a solo branch while counting unassigned staff and all owners conservatively', async () => {
    const { soloOwnerEligible } = await import('@/lib/pharmacy/solo-approval');
    const isSoloPharmacyOwner = (
      db: ScopedDb,
      organizationId: string,
      actorId: string,
      branchId?: string
    ) => soloOwnerEligible(db, { organizationId, actorId, branchId });
    await tenant(org, async (db) => {
      const branchB = await db.pharmacyBranch.findFirstOrThrow({ where: { code: 'B' } });
      await db.pharmacyBranchAssignment.deleteMany({ where: { userId: second } });
      expect(await isSoloPharmacyOwner(db, org, owner, branchId)).toBe(false);
      await db.pharmacyBranchAssignment.create({ data: { userId: second, branchId: branchB.id } });
      expect(await isSoloPharmacyOwner(db, org, owner)).toBe(false);
      expect(await isSoloPharmacyOwner(db, org, owner, branchId)).toBe(false);
      expect(await isSoloPharmacyOwner(db, org, owner, branchB.id)).toBe(false);
      await expect(
        dispensing
          .createCaller(context(db))
          .decideReview({ reviewItemId: reviewId, kind: 'VERIFY', pin })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const queue = await dispensing.createCaller(context(db)).reviewQueue();
      expect(queue.soloReviewItemIds).not.toContain(reviewId);
      const ownerRole = await db.organizationRole.findFirstOrThrow({
        where: { key: 'owner', isSystem: true },
      });
      await db.user.update({
        where: { id: second },
        data: { role: 'ADMIN', organizationRoleId: ownerRole.id },
      });
      expect(await isSoloPharmacyOwner(db, org, owner, branchId)).toBe(false);
      // Becoming an owner also autoassigns every branch and cannot create a solo exception.
      expect(
        await db.pharmacyBranchAssignment.count({
          where: { userId: second, branchId, active: true },
        })
      ).toBe(1);
    });
  });
});
