/** Fresh namespace only; coordinator executes on the admitted restricted synthetic lane. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { receiveLot, breakPack } from './stock-ledger';
import { createSale, addSaleLine, returnSaleLine } from './sales';
import { openPharmacyDrawer, applyPharmacyTender } from './settlement';
import {
  placeCustomerOrder,
  transitionCustomerOrder,
  startCustomerOrderCheckout,
} from './customer-ordering';
const url = process.env.WHA1364_RECEIPT_TEST_DATABASE_URL;
if (url && !new URL(url).pathname.startsWith('/wha1364_'))
  throw new Error('Synthetic WHA1364 lane required');
const client = url ? new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }) : null;
const suite = client ? describe : describe.skip;
const org = `mixed-org-${randomUUID()}`,
  branch = `mixed-branch-${randomUUID()}`,
  actor = `mixed-actor-${randomUUID()}`;
const scope = { organizationId: org, branchId: branch, actorId: actor };
async function tx<T>(work: (db: ScopedDb) => Promise<T>) {
  if (!client) throw new Error('Restricted DB required');
  return client.$transaction(
    async (db) => {
      await db.$queryRawUnsafe(
        "SELECT set_config('app.current_organization_id',$1,true), set_config('app.current_user_id',$2,true), set_config('app.current_branch_id',$3,true), set_config('app.is_platform_admin','false',true)",
        org,
        actor,
        branch
      );
      return work(db as ScopedDb);
    },
    { timeout: 30000 }
  );
}
beforeAll(async () => {
  if (!client) return;
  const roles = await client.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
    'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'
  );
  expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  await tx(async (db) => {
    await db.organization.create({
      data: {
        id: org,
        slug: org,
        legalName: 'Mixed stock synthetic',
        displayName: 'Mixed stock synthetic',
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        deploymentMode: 'SHARED',
      },
    });
    await db.organizationDepartment.create({
      data: { organizationId: org, key: 'test', name: 'Test' },
    });
    const role = await db.organizationRole.create({
      data: { organizationId: org, key: 'mixed-staff', name: 'Synthetic staff' },
    });
    await db.organizationRolePermission.create({
      data: {
        organizationId: org,
        organizationRoleId: role.id,
        capability: 'pharmacy:orders',
        effect: 'ALLOW',
      },
    });
    await db.user.create({
      data: {
        id: actor,
        organizationId: org,
        organizationRoleId: role.id,
        name: 'Synthetic stock actor',
        email: `${actor}@example.test`,
        role: 'EMPLOYEE',
        department: 'test',
        title: 'Test',
        startDate: new Date(),
        status: 'ACTIVE',
      },
    });
    await db.pharmacyBranch.create({
      data: {
        id: branch,
        organizationId: org,
        code: branch,
        name: 'Synthetic mixed stock',
        addressLine: 'Test',
        city: 'Test',
        provinceCode: 'PB',
      },
    });
  });
});
afterAll(() => client?.$disconnect());
suite('mixed-stock actual reserved checkout', () => {
  it('receives500 opens200 sells130 then checks out reserved100 sealed with replay and no implicit break', async () => {
    const f = await tx(async (db) => {
      const medicine = await db.medicine.create({
        data: {
          organizationId: org,
          productName: 'Synthetic mixed stock',
          productFamily: 'PHARMACEUTICAL',
          saleable: true,
          otc: true,
          presentations: { create: { organizationId: org, presentation: 'Tablet' } },
        },
        include: { presentations: true },
      });
      const presentation = medicine.presentations[0]!;
      const pack = await db.packLevel.create({
        data: {
          organizationId: org,
          presentationId: presentation.id,
          versionGroupId: randomUUID(),
          version: 1,
          level: 'BOX',
          unitsPerParent: 100,
          effectiveFrom: new Date('2026-01-01'),
        },
      });
      const location = await db.pharmacyStockLocation.create({
        data: {
          organizationId: org,
          branchId: branch,
          code: randomUUID(),
          name: 'Synthetic shelf',
          kind: 'STORE',
        },
      });
      const expiresAt = new Date('2035-01-01');
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: org,
          medicineId: medicine.id,
          batchNumber: randomUUID(),
          expiresAt,
          expiryPrecision: 'DAY',
        },
      });
      const { lot } = await receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: location.id,
        unitsPerPack: 100,
        supplierName: 'Synthetic',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: 1,
        printedMrpMinor: 10000,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 500,
        idempotencyKey: randomUUID(),
        receivedAt: new Date(),
      });
      await breakPack(db, scope, {
        inventoryLotId: lot.id,
        stockLocationId: location.id,
        requiredLooseUnits: 200,
        idempotencyKey: randomUUID(),
        at: new Date(),
      });
      const sale = await createSale(db, scope);
      await addSaleLine(db, scope, {
        saleId: sale.id,
        medicineId: medicine.id,
        presentationId: presentation.id,
        packLevelId: pack.id,
        saleUnit: 'UNIT',
        quantity: 130,
        canonicalUnitsPerSaleUnit: 1,
        idempotencyKey: randomUUID(),
      });
      const patient = await db.pharmacyPatient.create({
        data: { organizationId: org, displayName: 'Synthetic mixed-stock customer' },
      });
      const customer = await db.pharmacyCustomer.create({
        data: {
          organizationId: org,
          patientId: patient.id,
          displayName: 'Synthetic mixed-stock customer',
        },
      });
      return { medicine, presentation, pack, location, lot, customer };
    });
    const balance = () =>
      tx((db) =>
        db.pharmacyStockBalance.findFirstOrThrow({
          where: {
            inventoryLotId: f.lot.id,
            stockLocationId: f.location.id,
            disposition: 'AVAILABLE',
          },
        })
      );
    expect(await balance()).toMatchObject({ onHandUnits: 370, sealedPacks: 3, looseUnits: 70 });
    const order = await tx((db) =>
      placeCustomerOrder(db, scope, {
        customerId: f.customer.id,
        staff: true,
        fulfillment: 'COLLECT',
        intendedPaymentMethod: 'CASH',
        lines: [
          {
            medicineId: f.medicine.id,
            presentationId: f.presentation.id,
            packLevelId: f.pack.id,
            saleUnit: 'PACK',
            quantity: 1,
          },
        ],
      })
    );
    if (!order) throw new Error('Placed order must be readable');
    const reserved = await tx((db) =>
      db.pharmacyRestockReservation.findMany({
        where: { interest: { orderLine: { orderId: order.id } }, status: 'RESERVED' },
      })
    );
    expect(reserved).toEqual([
      expect.objectContaining({
        inventoryLotId: f.lot.id,
        stockLocationId: f.location.id,
        reservedUnits: 100,
      }),
    ]);
    for (const action of ['accept', 'pack', 'ready'] as const)
      await tx((db) => transitionCustomerOrder(db, scope, { orderId: order.id, action }));
    const checkout = await tx((db) => startCustomerOrderCheckout(db, scope, order.id));
    expect(checkout.replayed).toBe(false);
    expect(await balance()).toMatchObject({ onHandUnits: 270, sealedPacks: 2, looseUnits: 70 });
    const movements = () =>
      tx((db) =>
        db.pharmacyStockMovement.findMany({
          where: { inventoryLotId: f.lot.id },
          orderBy: { id: 'asc' },
        })
      );
    const beforeReplay = await movements();
    expect(beforeReplay.filter((m) => m.kind === 'SALE' && m.quantityUnits === -100)).toEqual([
      expect.objectContaining({
        sealedPackDelta: -1,
        looseUnitDelta: 0,
        stockLocationId: f.location.id,
      }),
    ]);
    expect(await tx((db) => startCustomerOrderCheckout(db, scope, order.id))).toEqual({
      saleId: checkout.saleId,
      replayed: true,
    });
    expect(await movements()).toEqual(beforeReplay);
    await expect(
      tx(async (db) => {
        const sale = await createSale(db, scope);
        return addSaleLine(db, scope, {
          saleId: sale.id,
          medicineId: f.medicine.id,
          presentationId: f.presentation.id,
          packLevelId: f.pack.id,
          saleUnit: 'UNIT',
          quantity: 80,
          canonicalUnitsPerSaleUnit: 1,
          idempotencyKey: randomUUID(),
        });
      })
    ).rejects.toThrow('INVALID_ARRANGEMENT');
    expect(await movements()).toEqual(beforeReplay);
    expect(await balance()).toMatchObject({ onHandUnits: 270, sealedPacks: 2, looseUnits: 70 });
  });

  it('normal allocation keeps quarantined returns separate from AVAILABLE arrangement, with replay and rollback', async () => {
    const f = await tx(async (db) => {
      const medicine = await db.medicine.create({
        data: {
          organizationId: org,
          productName: 'Synthetic mixed stock',
          productFamily: 'PHARMACEUTICAL',
          saleable: true,
          otc: true,
          presentations: { create: { organizationId: org, presentation: 'Tablet' } },
        },
        include: { presentations: true },
      });
      const presentation = medicine.presentations[0]!;
      const pack = await db.packLevel.create({
        data: {
          organizationId: org,
          presentationId: presentation.id,
          versionGroupId: randomUUID(),
          version: 1,
          level: 'BOX',
          unitsPerParent: 100,
          effectiveFrom: new Date('2026-01-01'),
        },
      });
      const location = await db.pharmacyStockLocation.create({
        data: {
          organizationId: org,
          branchId: branch,
          code: randomUUID(),
          name: 'Synthetic shelf',
          kind: 'QUARANTINE',
        },
      });
      const expiresAt = new Date('2035-01-01');
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: org,
          medicineId: medicine.id,
          batchNumber: randomUUID(),
          expiresAt,
          expiryPrecision: 'DAY',
        },
      });
      const { lot } = await receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: location.id,
        unitsPerPack: 100,
        supplierName: 'Synthetic',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: 1,
        printedMrpMinor: 10000,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 500,
        idempotencyKey: randomUUID(),
        receivedAt: new Date(),
      });
      await breakPack(db, scope, {
        inventoryLotId: lot.id,
        stockLocationId: location.id,
        requiredLooseUnits: 300,
        idempotencyKey: randomUUID(),
        at: new Date(),
      });
      const sale = await createSale(db, scope);
      const { line } = await addSaleLine(db, scope, {
        saleId: sale.id,
        medicineId: medicine.id,
        presentationId: presentation.id,
        packLevelId: pack.id,
        saleUnit: 'UNIT',
        quantity: 270,
        canonicalUnitsPerSaleUnit: 1,
        idempotencyKey: randomUUID(),
      });
      const deviceId = randomUUID();
      const businessDate = new Date();
      await openPharmacyDrawer(db, scope, { deviceId, businessDate, openingFloatMinor: 0 });
      await applyPharmacyTender(db, scope, {
        saleId: sale.id,
        deviceId,
        businessDate,
        type: 'CASH',
        amountMinor: 27000,
        cashReceivedMinor: 27000,
        idempotencyKey: randomUUID(),
      });
      const returned = {
        saleLineId: line.id,
        canonicalUnits: 200,
        disposition: 'QUARANTINE' as const,
        quarantineLocationId: location.id,
        reason: 'Synthetic returned goods',
        integrityDecision: 'Retain quarantined goods, not saleable',
        idempotencyKey: randomUUID(),
      };
      await returnSaleLine(db, scope, returned);
      return { medicine, presentation, pack, location, lot, returned };
    });
    const balances = () =>
      tx((db) =>
        db.pharmacyStockBalance.findMany({
          where: { inventoryLotId: f.lot.id, stockLocationId: f.location.id },
          orderBy: { disposition: 'asc' },
        })
      );
    const movements = () =>
      tx((db) =>
        db.pharmacyStockMovement.findMany({
          where: { inventoryLotId: f.lot.id },
          orderBy: { id: 'asc' },
        })
      );
    const before = await balances();
    expect(before.find((b) => b.disposition === 'AVAILABLE')).toMatchObject({
      onHandUnits: 230,
      sealedPacks: 2,
      looseUnits: 30,
    });
    const quarantined = before.find((b) => b.disposition === 'QUARANTINE');
    expect(quarantined).toMatchObject({ onHandUnits: 200, sealedPacks: 0, looseUnits: 200 });
    const initialMovements = await movements();
    expect(await tx((db) => returnSaleLine(db, scope, f.returned))).toMatchObject({
      replayed: true,
    });
    expect(await movements()).toEqual(initialMovements);
    const sale = await tx((db) => createSale(db, scope));
    const input = {
      saleId: sale.id,
      medicineId: f.medicine.id,
      presentationId: f.presentation.id,
      packLevelId: f.pack.id,
      saleUnit: 'PACK' as const,
      quantity: 1,
      canonicalUnitsPerSaleUnit: 100,
      idempotencyKey: randomUUID(),
    };
    await expect(
      tx(async (db) => {
        await addSaleLine(db, scope, input);
        throw new Error('SYNTHETIC_ALLOCATION_ROLLBACK');
      })
    ).rejects.toThrow('SYNTHETIC_ALLOCATION_ROLLBACK');
    expect(await movements()).toEqual(initialMovements);
    expect(await balances()).toEqual(before);
    const result = await tx((db) => addSaleLine(db, scope, input));
    expect(result.allocation.allocations).toEqual([
      { inventoryLotId: f.lot.id, stockLocationId: f.location.id, units: 100 },
    ]);
    const after = await balances();
    expect(after.find((b) => b.disposition === 'AVAILABLE')).toMatchObject({
      onHandUnits: 130,
      sealedPacks: 1,
      looseUnits: 30,
    });
    expect(after.find((b) => b.disposition === 'QUARANTINE')).toEqual(quarantined);
    const afterMovements = await movements();
    expect(afterMovements.filter((m) => !initialMovements.some((old) => old.id === m.id))).toEqual([
      expect.objectContaining({
        kind: 'SALE',
        disposition: 'AVAILABLE',
        quantityUnits: -100,
        sealedPackDelta: -1,
        looseUnitDelta: 0,
      }),
    ]);
    await expect(
      tx((db) => addSaleLine(db, scope, { ...input, quantity: 2, idempotencyKey: randomUUID() }))
    ).rejects.toThrow('INSUFFICIENT_STOCK');
    expect(await movements()).toEqual(afterMovements);
    expect(await balances()).toEqual(after);
  });
});
