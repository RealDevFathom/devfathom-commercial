import { PrismaPg } from '@prisma/adapter-pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import { receiveLot } from '../../src/lib/pharmacy/stock-ledger';
import type { ScopedDb } from '../../src/lib/tenancy/scoped-db';
import { EXPIRY_FIXTURE } from './pharmacy-inventory-expiry-fixture';
import { FIXTURE } from './pharmacy-purchasing-fixture';

/**
 * WHA-1602 (PH-A5) — the stock the expiry-board acceptance acts on.
 *
 * Runs AFTER `pharmacy-purchasing-seed.ts`, whose organization, branch, shelf,
 * medicine, pack and licensed supplier it reuses. It receives two run-unique
 * lots through the real INV-01 ledger function — one expiring in 45 days, one
 * already expired but still AVAILABLE on the shelf — so the board has exactly
 * the two situations it exists for. Run-unique batch numbers keep a re-run from
 * acting on a lot an earlier run already quarantined or returned.
 */

export const EXPIRY_HANDLE_PATH = path.join(
  'playwright-artifacts',
  'pharmacy-purchasing-fixture',
  'expiry-handle.json'
);

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
  const stamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  const nearBatch = `${EXPIRY_FIXTURE.nearBatchPrefix}-${stamp}`;
  const expiredBatch = `${EXPIRY_FIXTURE.expiredBatchPrefix}-${stamp}`;

  try {
    const organization = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      return tx.organization.findUnique({
        where: { slug: FIXTURE.organizationSlug },
        select: { id: true },
      });
    });
    if (!organization) {
      throw new Error('Run tests/e2e/pharmacy-purchasing-seed.ts before this seed.');
    }
    const organizationId = organization.id;

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_organization_id', '${organizationId}', true)`
      );
      const [receiver, branch, medicine] = await Promise.all([
        tx.user.findFirstOrThrow({
          where: { organizationId, email: FIXTURE.receiver.email },
          select: { id: true },
        }),
        tx.pharmacyBranch.findFirstOrThrow({
          where: { organizationId, code: FIXTURE.branch.code },
          select: { id: true },
        }),
        tx.medicine.findFirstOrThrow({
          where: { organizationId, productName: FIXTURE.medicine.productName },
          select: { id: true, presentations: { select: { id: true }, take: 1 } },
        }),
      ]);
      const [shelf, packLevel] = await Promise.all([
        tx.pharmacyStockLocation.findFirstOrThrow({
          where: { organizationId, branchId: branch.id, code: FIXTURE.shelf.code },
          select: { id: true },
        }),
        tx.packLevel.findFirstOrThrow({
          where: { organizationId, presentationId: medicine.presentations[0]!.id },
          select: { id: true },
        }),
      ]);
      const scope = { organizationId, branchId: branch.id, actorId: receiver.id };

      // Purchasing → Returns reads supplier credit, so it is gated on
      // `reports:financial`, which is org-role driven and denied by default. The
      // spec proves the return draft is visible THERE, so the signed-in receiver
      // is given that one capability explicitly — and with a reason — rather
      // than by widening a role.
      await tx.userPermissionOverride.upsert({
        where: { userId_capability: { userId: receiver.id, capability: 'reports:financial' } },
        update: { effect: 'ALLOW', expiresAt: null },
        create: {
          organizationId,
          userId: receiver.id,
          capability: 'reports:financial',
          effect: 'ALLOW',
          reason: 'PH-A5 acceptance: the receiver reviews expiry claims in Purchasing → Returns.',
        },
      });

      for (const lot of [
        { batchNumber: nearBatch, expiresAt: day(45), units: EXPIRY_FIXTURE.nearUnits },
        { batchNumber: expiredBatch, expiresAt: day(-3), units: EXPIRY_FIXTURE.expiredUnits },
      ]) {
        const batch = await tx.pharmacyManufacturingBatch.create({
          data: {
            organizationId,
            medicineId: medicine.id,
            batchNumber: lot.batchNumber,
            expiresAt: lot.expiresAt,
            expiryPrecision: 'DAY',
          },
          select: { id: true },
        });
        await receiveLot(tx as unknown as ScopedDb, scope, {
          manufacturingBatchId: batch.id,
          packLevelId: packLevel.id,
          stockLocationId: shelf.id,
          unitsPerPack: FIXTURE.purchaseOrder.unitsPerPack,
          supplierName: FIXTURE.supplier.name,
          supplierInvoiceRef: `INV-${lot.batchNumber}`,
          unitCostMinor: EXPIRY_FIXTURE.unitCostMinor,
          printedMrpMinor: EXPIRY_FIXTURE.printedMrpMinor,
          receivedExpiresAt: lot.expiresAt,
          receivedExpiryPrecision: 'DAY',
          quantityUnits: lot.units,
          idempotencyKey: `ph-a5-e2e:${lot.batchNumber}`,
          // Received before the expired batch lapsed, as it would have been.
          receivedAt: day(-30),
        });
      }
    });

    mkdirSync(path.dirname(EXPIRY_HANDLE_PATH), { recursive: true });
    writeFileSync(
      EXPIRY_HANDLE_PATH,
      `${JSON.stringify({ organizationId, nearBatch, expiredBatch }, null, 2)}\n`
    );
    process.stdout.write(`PH-A5 expiry fixture ready: ${nearBatch}, ${expiredBatch}\n`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
