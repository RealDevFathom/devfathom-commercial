import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import { syncPlatformCatalog } from '../../prisma/catalog-sync.js';
import { TRANSFERS_ARTIFACTS, TRANSFERS_FIXTURE as F } from './pharmacy-transfers-fixture';

/**
 * WHA-1603 — the fixture the INV-07 transfers acceptance walks.
 *
 * Exactly what a transfer needs before it is legal: two people (approval is
 * segregated from allocation), two active branches each with a location, one
 * medicine with a 10-unit strip, and a run-unique received lot of 100 units on
 * the source shelf. Nothing downstream of "stock on the shelf" is seeded: the
 * spec's point is to walk allocate → approve → dispatch → receive through the
 * surface.
 *
 * Idempotent: every write except the run-unique lot is an upsert on a natural
 * key, so a rerun against a warm database starts from the same shape.
 */

const MODULES = ['pharmacy-core', 'pharmacy-inventory'];

export const HANDLE_PATH = path.join(TRANSFERS_ARTIFACTS, 'fixture-handle.json');

const runStamp = () =>
  new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);

const day = (offsetDays: number) => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date;
};

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  const pool = new pg.Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const stamp = runStamp();
  const batchNumber = `XFER-${stamp}`;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      await syncPlatformCatalog(tx);
    });

    const organizationId = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      const organization = await tx.organization.upsert({
        where: { slug: F.organizationSlug },
        update: { vertical: 'PHARMACY', status: 'ACTIVE' },
        create: {
          slug: F.organizationSlug,
          legalName: `${F.organizationName} (Pvt) Ltd`,
          displayName: F.organizationName,
          vertical: 'PHARMACY',
          status: 'ACTIVE',
          timezone: 'Asia/Karachi',
          currency: 'PKR',
          seatLimit: 10,
          activatedAt: day(-30),
        },
        select: { id: true },
      });
      const modules = await tx.platformModule.findMany({
        where: { key: { in: MODULES } },
        select: { id: true, key: true },
      });
      const missing = MODULES.filter((key) => !modules.some((entry) => entry.key === key));
      if (missing.length > 0) throw new Error(`Catalog is missing ${missing.join(', ')}.`);
      for (const entry of modules) {
        await tx.organizationModule.upsert({
          where: {
            organizationId_moduleId: { organizationId: organization.id, moduleId: entry.id },
          },
          update: { status: 'ENABLED', startsAt: day(-1), expiresAt: null },
          create: {
            organizationId: organization.id,
            moduleId: entry.id,
            status: 'ENABLED',
            startsAt: day(-1),
          },
        });
      }
      return organization.id;
    });

    const handle = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_organization_id', '${organizationId}', true)`
      );
      await tx.organizationDepartment.createMany({
        data: [{ organizationId, key: 'pharmacy', name: 'Pharmacy', sortOrder: 0 }],
        skipDuplicates: true,
      });
      const passwordHash = await bcrypt.hash(F.dispatcher.password, 10);
      const [dispatcher] = await Promise.all(
        [F.dispatcher, F.approver].map((person, index) =>
          tx.user.upsert({
            where: { organizationId_email: { organizationId, email: person.email } },
            update: { status: 'ACTIVE', password: passwordHash },
            create: {
              organizationId,
              email: person.email,
              name: person.name,
              password: passwordHash,
              department: 'pharmacy',
              title: index === 0 ? 'Chain stock controller' : 'Branch manager',
              // Both reach the whole console; INV-07 only needs them to differ.
              role: 'ADMIN',
              status: 'ACTIVE',
            },
            select: { id: true },
          })
        )
      );

      const branches: Record<'source' | 'destination', { branchId: string; locationId: string }> =
        {} as never;
      for (const key of ['source', 'destination'] as const) {
        const spec = F[key];
        const branch = await tx.pharmacyBranch.upsert({
          where: { organizationId_code: { organizationId, code: spec.code } },
          update: { active: true },
          create: {
            organizationId,
            code: spec.code,
            name: spec.name,
            addressLine: key === 'source' ? '12 Zaibunnisa Street' : '4 Khayaban-e-Iqbal',
            city: spec.city,
            provinceCode: 'SD',
            active: true,
          },
          select: { id: true },
        });
        const location = await tx.pharmacyStockLocation.upsert({
          where: {
            organizationId_branchId_code: {
              organizationId,
              branchId: branch.id,
              code: spec.location.code,
            },
          },
          update: { active: true },
          create: {
            organizationId,
            branchId: branch.id,
            code: spec.location.code,
            name: spec.location.name,
            kind: 'STORE',
            active: true,
          },
          select: { id: true },
        });
        await tx.pharmacyBranch.update({
          where: { id: branch.id },
          data: { defaultStockLocationId: location.id },
        });
        branches[key] = { branchId: branch.id, locationId: location.id };
      }

      let medicine = await tx.medicine.findFirst({
        where: { organizationId, productName: F.medicine.productName },
        select: { id: true, presentations: { select: { id: true } } },
      });
      if (!medicine) {
        medicine = await tx.medicine.create({
          data: {
            organizationId,
            productName: F.medicine.productName,
            productFamily: 'PHARMACEUTICAL',
            saleable: true,
            presentations: { create: { organizationId, presentation: 'Capsule, 10 per strip' } },
          },
          select: { id: true, presentations: { select: { id: true } } },
        });
      }
      const presentationId = medicine.presentations[0]!.id;
      let packLevel = await tx.packLevel.findFirst({
        where: { organizationId, presentationId },
        select: { id: true },
      });
      if (!packLevel) {
        packLevel = await tx.packLevel.create({
          data: {
            organizationId,
            presentationId,
            versionGroupId: 'ph-xfer-e2e-strip',
            version: 1,
            level: 'STRIP',
            unitsPerParent: F.medicine.unitsPerPack,
            effectiveFrom: day(-30),
          },
          select: { id: true },
        });
      }

      // A run-unique batch and lot, received straight into the ledger. The
      // balance is the trigger's projection of this RECEIPT, never a write.
      const batch = await tx.pharmacyManufacturingBatch.create({
        data: {
          organizationId,
          medicineId: medicine.id,
          batchNumber,
          expiresAt: day(540),
          expiryPrecision: 'DAY',
        },
        select: { id: true },
      });
      const lot = await tx.pharmacyInventoryLot.create({
        data: {
          organizationId,
          branchId: branches.source.branchId,
          manufacturingBatchId: batch.id,
          packLevelId: packLevel.id,
          unitsPerPack: F.medicine.unitsPerPack,
          supplierName: 'Indus Pharma Distributors',
          supplierInvoiceRef: `INV-${stamp}`,
          unitCostMinor: 2500,
          printedMrpMinor: 3200,
          receivedExpiresAt: day(540),
          receivedExpiryPrecision: 'DAY',
          receivedAt: day(-1),
        },
        select: { id: true },
      });
      await tx.pharmacyStockMovement.create({
        data: {
          organizationId,
          branchId: branches.source.branchId,
          inventoryLotId: lot.id,
          stockLocationId: branches.source.locationId,
          kind: 'RECEIPT',
          disposition: 'AVAILABLE',
          quantityUnits: F.openingUnits,
          sealedPackDelta: F.openingUnits / F.medicine.unitsPerPack,
          looseUnitDelta: 0,
          actorId: dispatcher!.id,
          reason: 'WHA-1603 acceptance opening stock',
          idempotencyKey: `wha1603-e2e-receipt:${stamp}`,
        },
      });
      return {
        organizationId,
        batchNumber,
        sourceBranchId: branches.source.branchId,
        destinationBranchId: branches.destination.branchId,
      };
    });

    mkdirSync(path.dirname(HANDLE_PATH), { recursive: true });
    writeFileSync(HANDLE_PATH, `${JSON.stringify(handle, null, 2)}\n`);
    process.stdout.write(
      `PH-XFER fixture ready: organization ${organizationId}, batch ${batchNumber}\n`
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
