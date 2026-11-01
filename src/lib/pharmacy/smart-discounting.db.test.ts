/** @vitest-environment node */
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { addSaleLine, createSale } from './sales';
import { receiveLot } from './stock-ledger';
import { setSmartDiscountOwnerPin, verifySmartDiscountOwner } from './smart-discount-approval';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
vi.mock('@/lib/db', () => ({
  db: new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }), log: [] }),
}));
const org = `discount_${randomUUID().replaceAll('-', '')}`;
const foreignOrg = `${org}_other`;
const branch = `${org}_a`,
  sibling = `${org}_b`;
const scope = { organizationId: org, branchId: branch, actorId: `${org}_owner` };
const policy = { minimumMarginBps: 2000, minimumObservations: 3, targetDemandLiftBps: 1000 };
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let item: { medicineId: string; presentationId: string; packLevelId: string; lotId: string };
let otherPack: string, foreignPack: string, staffProfileId: string;
const tenant = <T>(work: (db: ScopedDb) => Promise<T>) => withTenantDb(org, work);
const scoped = <T>(work: (db: ScopedDb) => Promise<T>) =>
  tenant(async (db) => {
    await db.$queryRaw`SELECT set_config('app.current_branch_id', ${branch}, true)`;
    return work(db);
  });
const evidence = () => ({
  id: randomUUID(),
  organizationId: org,
  branchId: branch,
  medicineId: item.medicineId,
  packLevelId: item.packLevelId,
  competitor: 'Nearby store',
  competitorPriceMinor: 900,
  observedDemandUnits: 12,
  observedAt: new Date(),
  actorId: scope.actorId,
});

describe.skipIf(!TEST_DATABASE_URL)('smart discounts under forced RLS', () => {
  beforeAll(async () => {
    ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(withPlatformDb);
    await withPlatformDb(async (db) => {
      for (const id of [org, foreignOrg])
        await db.$executeRaw`
        INSERT INTO organizations(id,slug,"legalName","displayName",vertical,status,"updatedAt")
        VALUES(${id},${id},${id},${id},'PHARMACY','ACTIVE',now())`;
    });
    item = await tenant(async (db) => {
      for (const id of [branch, sibling]) {
        await db.pharmacyBranch.create({
          data: {
            id,
            organizationId: org,
            code: id,
            name: id,
            addressLine: 'Test',
            city: 'Test',
            provinceCode: 'PB',
          },
        });
        await db.pharmacySmartDiscountPolicy.create({
          data: { ...policy, organizationId: org, branchId: id, updatedById: scope.actorId },
        });
      }
      await db.organizationDepartment.create({
        data: { organizationId: org, key: 'PHARMACY', name: 'Pharmacy' },
      });
      await db.user.create({
        data: {
          id: scope.actorId,
          organizationId: org,
          name: 'Owner',
          email: `${org}@example.test`,
          role: 'ADMIN',
          department: 'PHARMACY',
          title: 'Owner',
        },
      });
      const enrolled = await setSmartDiscountOwnerPin(db, scope, '1234');
      if ('blocked' in enrolled) throw new Error(enrolled.blocked);
      staffProfileId = enrolled.staffProfileId;
      const medicine = await db.medicine.create({
        data: {
          organizationId: org,
          productName: 'Margin regression',
          productFamily: 'PHARMACEUTICAL',
          saleable: true,
          presentations: { create: { organizationId: org, presentation: 'Unit' } },
        },
        include: { presentations: true },
      });
      const presentationId = medicine.presentations[0]!.id;
      const pack = await db.packLevel.create({
        data: {
          organizationId: org,
          presentationId,
          versionGroupId: randomUUID(),
          version: 1,
          level: 'UNIT',
          unitsPerParent: 1,
          effectiveFrom: new Date('2026-01-01'),
        },
      });
      const location = await db.pharmacyStockLocation.create({
        data: { organizationId: org, branchId: branch, code: 'MAIN', name: 'Stock', kind: 'STORE' },
      });
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: org,
          medicineId: medicine.id,
          batchNumber: randomUUID(),
          expiresAt: new Date('2031-01-01'),
          expiryPrecision: 'DAY',
        },
      });
      const { lot } = await receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: location.id,
        unitsPerPack: 1,
        supplierName: 'Test',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: 760,
        printedMrpMinor: 1000,
        receivedExpiresAt: new Date('2031-01-01'),
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 10,
        idempotencyKey: randomUUID(),
        receivedAt: new Date('2026-01-01'),
      });
      return { medicineId: medicine.id, presentationId, packLevelId: pack.id, lotId: lot.id };
    });
    const makeOtherPack = (organizationId: string) =>
      withTenantDb(organizationId, async (db) => {
        const medicine = await db.medicine.create({
          data: {
            organizationId,
            productName: 'Other medicine',
            productFamily: 'PHARMACEUTICAL',
            presentations: { create: { organizationId, presentation: 'Unit' } },
          },
          include: { presentations: true },
        });
        return (
          await db.packLevel.create({
            data: {
              organizationId,
              presentationId: medicine.presentations[0]!.id,
              versionGroupId: randomUUID(),
              version: 1,
              level: 'UNIT',
              unitsPerParent: 1,
              effectiveFrom: new Date('2026-01-01'),
            },
          })
        ).id;
      });
    otherPack = await makeOtherPack(org);
    foreignPack = await makeOtherPack(foreignOrg);
    await tenant(async (db) => {
      await db.pharmacyCompetitorDiscountObservation.create({ data: evidence() });
      await db.pharmacyCompetitorDiscountObservation.create({
        data: { ...evidence(), branchId: sibling },
      });
    });
  }, 30_000);
  afterAll(async () => {
    if (TEST_DATABASE_URL) {
      const { db } = await import('@/lib/db');
      await db.$disconnect();
    }
  });

  it('limits reads and updates to the scoped branch and organization', async () => {
    await scoped(async (db) => {
      expect(await db.pharmacyCompetitorDiscountObservation.findMany()).toHaveLength(1);
      expect(await db.pharmacySmartDiscountPolicy.findMany()).toHaveLength(1);
      expect(
        await db.pharmacySmartDiscountPolicy.updateMany({
          where: { branchId: sibling },
          data: { minimumMarginBps: 0 },
        })
      ).toMatchObject({ count: 0 });
    });
    await withTenantDb(foreignOrg, async (db) => {
      expect(await db.pharmacyCompetitorDiscountObservation.findMany()).toHaveLength(0);
      expect(await db.pharmacySmartDiscountPolicy.findMany()).toHaveLength(0);
    });
  });
  it('rejects sibling writes and moving visible rows into a sibling branch', async () => {
    await expect(
      scoped((db) =>
        db.pharmacyCompetitorDiscountObservation.create({
          data: { ...evidence(), branchId: sibling },
        })
      )
    ).rejects.toThrow();
    await expect(
      scoped((db) =>
        db.pharmacySmartDiscountPolicy.updateMany({
          where: { branchId: branch },
          data: { branchId: sibling },
        })
      )
    ).rejects.toThrow();
    await expect(
      scoped((db) =>
        db.pharmacyCompetitorDiscountObservation.updateMany({
          where: { branchId: branch },
          data: { branchId: sibling },
        })
      )
    ).rejects.toThrow();
  });
  it.each(['missing', 'foreign', 'mismatch'])(
    'rejects %s packs on insert and update',
    async (kind) => {
      const packLevelId =
        kind === 'missing' ? randomUUID() : kind === 'foreign' ? foreignPack : otherPack;
      await expect(
        tenant((db) =>
          db.pharmacyCompetitorDiscountObservation.create({ data: { ...evidence(), packLevelId } })
        )
      ).rejects.toThrow();
      await expect(
        tenant((db) =>
          db.pharmacyCompetitorDiscountObservation.updateMany({
            where: { branchId: branch },
            data: { packLevelId },
          })
        )
      ).rejects.toThrow();
    }
  );
  it('preserves medicine/pack identity when parents change, including hidden sibling evidence', async () => {
    const pack = await tenant((db) =>
      db.packLevel.findUniqueOrThrow({ where: { id: otherPack }, include: { presentation: true } })
    );
    expect(pack.referencedAt).toBeNull();
    await tenant((db) =>
      db.pharmacyCompetitorDiscountObservation.create({
        data: {
          ...evidence(),
          branchId: sibling,
          packLevelId: otherPack,
          medicineId: pack.presentation.medicineId,
        },
      })
    );
    await expect(
      scoped((db) =>
        db.packLevel.update({
          where: { id: otherPack },
          data: { presentationId: item.presentationId },
        })
      )
    ).rejects.toThrow();
    await expect(
      scoped((db) =>
        db.presentation.update({
          where: { id: pack.presentationId },
          data: { medicineId: item.medicineId },
        })
      )
    ).rejects.toThrow();
  });
  const add = async (discountMinor: number, approve = false) =>
    tenant(async (db) => {
      const sale = await createSale(db, scope);
      const proof = approve
        ? await verifySmartDiscountOwner(scope, { staffProfileId, pin: '1234' })
        : undefined;
      if (proof && 'blocked' in proof) throw new Error(proof.blocked);
      return addSaleLine(db, scope, {
        ...item,
        saleId: sale.id,
        saleUnit: 'UNIT',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        discountMinor,
        discountKind: 'DISCOUNT',
        approvedByUserId: scope.actorId,
        approvalPolicy: 'claimed-owner',
        smartDiscountApproval: proof?.approval,
        idempotencyKey: randomUUID(),
      });
    });
  it('rejects the reported 800/760 sale and rolls back stock allocation', async () => {
    const before = await tenant((db) => db.pharmacyStockMovement.count());
    await expect(add(200)).rejects.toThrow('MARGIN_GUARDRAIL');
    expect(await tenant((db) => db.pharmacyStockMovement.count())).toBe(before);
  });
  it('requires fresh owner proof even at the permitted price', async () => {
    await expect(add(50)).rejects.toThrow('APPROVAL_REQUIRED');
  });
  it('accepts 950/760 with owner PIN and commits approval audit evidence', async () => {
    const { line } = await add(50, true);
    expect(line.approvedByUserId).toBe(scope.actorId);
    expect(line.approvalPolicy).toBe('smart-discount-owner-pin');
    const audit = await tenant((db) =>
      db.auditLog.findFirstOrThrow({
        where: { targetId: line.id, action: 'pharmacySales.smartDiscountApproved' },
      })
    );
    expect(audit.changes).toMatchObject({
      netMinor: 950,
      costMinor: 760,
      minimumMarginBps: 2000,
      ownerId: scope.actorId,
    });
    expect(JSON.stringify(audit)).not.toMatch(/"pin"|credentialHash/);
  });
  it('commits a failed PIN attempt without a stock write', async () => {
    const result = await verifySmartDiscountOwner(scope, { staffProfileId, pin: '9999' });
    expect(result).toHaveProperty('blocked');
    expect(
      await tenant((db) =>
        db.restaurantOperatorCredential.findFirstOrThrow({ where: { staffProfileId } })
      )
    ).toMatchObject({ failedAttempts: 1 });
    expect(await verifySmartDiscountOwner(scope, { staffProfileId, pin: '1234' })).toHaveProperty(
      'approval'
    );
  });
  it('keeps a failed PIN attempt counted when the surrounding request rolls back', async () => {
    // A batched sibling failure rolls back the request transaction; the guess must still count.
    await expect(
      tenant(async () => {
        expect(
          await verifySmartDiscountOwner(scope, { staffProfileId, pin: '9999' })
        ).toHaveProperty('blocked');
        throw new Error('sibling mutation failed');
      })
    ).rejects.toThrow('sibling mutation failed');
    expect(
      await tenant((db) =>
        db.restaurantOperatorCredential.findFirstOrThrow({ where: { staffProfileId } })
      )
    ).toMatchObject({ failedAttempts: 1 });
    expect(await verifySmartDiscountOwner(scope, { staffProfileId, pin: '1234' })).toHaveProperty(
      'approval'
    );
  });
  it('rotates the pharmacy owner PIN without returning a secret or changing identity', async () => {
    expect(await tenant((db) => setSmartDiscountOwnerPin(db, scope, '4567'))).toHaveProperty(
      'blocked'
    );
    expect(
      await tenant((db) => setSmartDiscountOwnerPin(db, scope, '4567', '9999'))
    ).toHaveProperty('blocked');
    const result = await tenant((db) => setSmartDiscountOwnerPin(db, scope, '4567', '1234'));
    expect(result).toEqual({ staffProfileId });
    expect(await verifySmartDiscountOwner(scope, { staffProfileId, pin: '1234' })).toHaveProperty(
      'blocked'
    );
    expect(await verifySmartDiscountOwner(scope, { staffProfileId, pin: '4567' })).toHaveProperty(
      'approval'
    );
    const audit = await tenant((db) =>
      db.auditLog.findMany({ where: { action: 'pharmacyMedicine.setSmartDiscountOwnerPin' } })
    );
    expect(audit).toHaveLength(2);
    for (const entry of audit) expect(entry.changes).toEqual({ staffProfileId, type: 'PIN' });
  });
});
