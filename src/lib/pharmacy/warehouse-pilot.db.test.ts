import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureWarehouseTestDatabase } from '@/lib/test-support/warehouse-database';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  retirePharmacyRegulatoryRules,
  seedPharmacyRegulatoryProfile,
} from '@/lib/test-support/pharmacy-regulatory';

configureWarehouseTestDatabase();
const organizationId = 'wh_pilot_' + randomUUID();
const scope = { organizationId, branchId: organizationId + '_store', actorId: 'picker' };
const branchIds = [scope.branchId, organizationId + '_east', organizationId + '_west'];
const rules: string[] = [];

let tenancy: typeof import('@/lib/tenancy/scoped-db');
function inTenant<T>(operation: (db: ScopedDb) => Promise<T>) {
  return tenancy.withTenantDb(organizationId, operation);
}

async function stockFixture(label: string, productCode: string, eligibleUnits: number) {
  const { receiveLot } = await import('./stock-ledger');
  return inTenant(async (db) => {
    const bins = await Promise.all(
      branchIds.map((branchId) =>
        db.pharmacyStockLocation.create({
          data: { organizationId, branchId, code: 'BIN-' + label, name: 'Shelf', kind: 'RACK_BIN' },
        })
      )
    );
    const source = bins[0]!;
    const staging = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId: scope.branchId,
        code: 'PACK-' + label,
        name: 'Packing',
        kind: 'RACK_BIN',
        warehouseStaging: true,
      },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: 'Pilot tablets 250 mg',
        productFamily: 'PHARMACEUTICAL',
        presentations: { create: { organizationId, presentation: 'Ten tablets' } },
      },
      include: { presentations: true },
    });
    const pack = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: label,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date(0),
      },
    });
    await db.medicineBarcode.create({
      data: {
        organizationId,
        presentationId: pack.presentationId,
        packLevelId: pack.id,
        type: 'INTERNAL',
        code: productCode,
        normalizedCode: productCode,
      },
    });
    async function stock(days: number) {
      const expiresAt = new Date(Date.now() + days * 86_400_000);
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId,
          medicineId: medicine.id,
          batchNumber: 'PILOT-' + days,
          expiresAt,
          expiryPrecision: 'DAY',
        },
      });
      const { lot } = await receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: source.id,
        unitsPerPack: 10,
        supplierName: 'Pilot supplier',
        supplierInvoiceRef: 'INV-' + label + days,
        unitCostMinor: 150,
        printedMrpMinor: 200,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: days === 15 ? 10 : eligibleUnits,
        idempotencyKey: 'stock-' + label + days,
        receivedAt: new Date(),
      });
      return lot.id;
    }
    const shortDatedLotId = await stock(15);
    const eligibleLotId = await stock(365);
    return {
      medicineId: medicine.id,
      source,
      staging,
      destinations: bins.slice(1),
      shortDatedLotId,
      eligibleLotId,
    };
  });
}

describe('warehouse branch replenishment pilot under PostgreSQL RLS', () => {
  beforeAll(async () => {
    tenancy = await import('@/lib/tenancy/scoped-db');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(tenancy.withPlatformDb);
    await tenancy.withPlatformDb((db) =>
      db.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          legalName: 'Warehouse pilot',
          displayName: 'Pilot',
          status: 'ACTIVE',
          pharmacyBranchTransfersEnabled: true,
        },
      })
    );
    await inTenant((db) =>
      db.pharmacyBranch.createMany({
        data: branchIds.map((id, index) => ({
          organizationId,
          id,
          code: 'P' + index,
          name: 'Pilot ' + index,
          provinceCode: 'PK-PB',
          city: 'Lahore',
          addressLine: '1 Test Road',
          warehouseEnabled: index === 0,
          warehouseMinimumShelfLifeDays: index === 0 ? 0 : 60,
        })),
      })
    );
    for (const branchId of branchIds) {
      rules.push(await seedPharmacyRegulatoryProfile(tenancy.withPlatformDb, inTenant, branchId));
    }
  });

  afterAll(async () => {
    if (tenancy) await retirePharmacyRegulatoryRules(tenancy.withPlatformDb, rules);
  });

  it('releases a cancelled reservation and refills an open demand against the same lot exactly once', async () => {
    const { createWarehouseOutbound, replenishWarehouseOutbound, cancelWarehouseOutbound } =
      await import('./warehouse-outbound');
    const fixture = await stockFixture('refill', '25000003', 30);
    const [first, second] = fixture.destinations;
    async function request(destination: typeof first, requestedUnits: number, key: string) {
      return inTenant((db) =>
        createWarehouseOutbound(db, scope, {
          toBranchId: destination!.branchId,
          lines: [
            {
              medicineId: fixture.medicineId,
              destinationStockLocationId: destination!.id,
              requestedUnits,
            },
          ],
          idempotencyKey: key,
        })
      );
    }
    const competing = await request(first, 17, 'refill-competing');
    const partial = await request(second, 24, 'refill-partial');
    expect(partial.demands[0]!.shortfallUnits).toBe(11);
    await inTenant((db) =>
      cancelWarehouseOutbound(db, scope, {
        orderId: competing.id,
        reason: 'Branch cancelled its request.',
        idempotencyKey: 'cancel-competing',
      })
    );
    const refill = () =>
      inTenant((db) =>
        replenishWarehouseOutbound(db, scope, {
          orderId: partial.id,
          idempotencyKey: 'refill-partial-again',
        })
      );
    for (const order of [await refill(), await refill()]) {
      expect(order.demands[0]!.shortfallUnits).toBe(0);
      expect(order.reservations).toHaveLength(1);
      expect(order.reservations[0]).toMatchObject({
        id: partial.reservations[0]!.id,
        quantityUnits: 24,
      });
    }
    const cancel = () =>
      inTenant((db) =>
        cancelWarehouseOutbound(db, scope, {
          orderId: partial.id,
          reason: 'No longer needed.',
          idempotencyKey: 'cancel-partial',
        })
      );
    await cancel();
    await cancel();
    const balance = await inTenant((db) =>
      db.pharmacyStockBalance.findFirstOrThrow({
        where: {
          organizationId,
          branchId: scope.branchId,
          inventoryLotId: fixture.eligibleLotId,
          stockLocationId: fixture.source.id,
          disposition: 'AVAILABLE',
        },
      })
    );
    expect(balance).toMatchObject({ onHandUnits: 30, sealedPacks: 2, looseUnits: 10 });
  });

  it('withdraws only an affected packed line and requires fresh approval to ship its unaffected sibling', async () => {
    const affected = await stockFixture('mixed-held', '25000020', 10);
    const healthy = await stockFixture('mixed-good', '25000021', 10);
    const { createWarehouseOutbound, pickWarehouseLine, packWarehouseLine } =
      await import('./warehouse-outbound');
    const { approveTransfer, dispatchTransfer, setManufacturingBatchState } =
      await import('./inventory-operations');
    const destination = healthy.destinations[0]!;
    const order = await inTenant((db) =>
      createWarehouseOutbound(db, scope, {
        toBranchId: destination.branchId,
        idempotencyKey: 'multi-demand',
        lines: [affected, healthy].map((f) => ({
          medicineId: f.medicineId,
          destinationStockLocationId: f.destinations[0]!.id,
          requestedUnits: 10,
        })),
      })
    );
    for (const r of order.reservations) {
      const f = r.medicineId === affected.medicineId ? affected : healthy;
      const scans = {
        reservationId: r.id,
        lotScan: r.lotCode!,
        productScan: f.medicineId,
        stagingBinScan: f.staging.code,
        quantityUnits: r.quantityUnits,
      };
      await inTenant((db) =>
        pickWarehouseLine(db, scope, {
          ...scans,
          sourceBinScan: f.source.code,
          idempotencyKey: 'pick-' + r.id,
        })
      );
      await inTenant((db) =>
        packWarehouseLine(db, scope, { ...scans, idempotencyKey: 'pack-' + r.id })
      );
    }
    const approve = () =>
      inTenant((db) => approveTransfer(db, { ...scope, actorId: 'reviewer' }, order.transferId!));
    await approve();
    await inTenant(async (db) => {
      const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
        where: { id: affected.eligibleLotId },
      });
      await setManufacturingBatchState(
        db,
        organizationId,
        {
          manufacturingBatchId: lot.manufacturingBatchId,
          state: 'QUARANTINED',
          reason: 'Quality review',
        },
        scope.actorId
      );
    });
    await expect(
      inTenant((db) => dispatchTransfer(db, scope, order.transferId!, 'stale-multi'))
    ).rejects.toThrow();
    await approve();
    await inTenant((db) => dispatchTransfer(db, scope, order.transferId!, 'ship-multi'));
    const balances = await inTenant((db) =>
      db.pharmacyStockBalance.findMany({
        where: {
          organizationId,
          inventoryLotId: { in: [affected.eligibleLotId, healthy.eligibleLotId] },
          onHandUnits: { gt: 0 },
        },
        select: { inventoryLotId: true, disposition: true, onHandUnits: true },
      })
    );
    expect(balances).toEqual(
      expect.arrayContaining([
        { inventoryLotId: affected.eligibleLotId, disposition: 'QUARANTINE', onHandUnits: 10 },
        { inventoryLotId: healthy.eligibleLotId, disposition: 'IN_TRANSIT', onHandUnits: 10 },
      ])
    );
    const pending = await inTenant((db) =>
      db.pharmacyWarehouseOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: { reservations: true },
      })
    );
    expect(pending.status).toBe('OPEN');
    expect(pending.reservations.map((r) => r.state).sort()).toEqual(['CANCELLED', 'DISPATCHED']);
  });

  it('promises the last eligible pack once, verifies physical scans, and posts one dispatch and receipt across retries', async () => {
    const { createWarehouseOutbound, pickWarehouseLine, packWarehouseLine } =
      await import('./warehouse-outbound');
    const { approveTransfer, dispatchTransfer } = await import('./inventory-operations');
    const { receiveWarehouseTransferLine } = await import('./warehouse-quality');
    const { medicineId, source, staging, destinations, eligibleLotId, shortDatedLotId } =
      await stockFixture('initial', '25000001', 10);
    const orders = await Promise.all(
      destinations.map((destination) =>
        inTenant((db) =>
          createWarehouseOutbound(db, scope, {
            toBranchId: destination.branchId,
            lines: [{ medicineId, destinationStockLocationId: destination.id, requestedUnits: 10 }],
            idempotencyKey: 'demand-' + destination.branchId,
          })
        )
      )
    );
    expect(orders.map((o) => o.demands[0]!.shortfallUnits).sort((a, b) => a - b)).toEqual([0, 10]);
    const fulfilled = orders.find((o) => o.transferId)!;
    for (const branchId of branchIds.slice(1)) {
      const visibleOrders = await inTenant(async (db) => {
        await db.$queryRaw`SELECT set_config('app.current_branch_id', ${branchId}, true)`;
        return db.pharmacyWarehouseOrder.findMany({
          where: { id: { in: orders.map((o) => o.id) } },
          select: { toBranchId: true },
        });
      });
      expect(visibleOrders).toEqual([{ toBranchId: branchId }]);
    }
    const reservation = fulfilled.reservations[0]!;
    expect(reservation.inventoryLotId).toBe(eligibleLotId);
    expect(
      await inTenant((db) =>
        db.pharmacyStockBalance.findFirst({
          where: {
            organizationId,
            inventoryLotId: shortDatedLotId,
            disposition: 'AVAILABLE',
          },
        })
      )
    ).toMatchObject({ onHandUnits: 10 });

    const { allocateForSale } = await import('./stock-ledger');
    const { reserveSupplierClaim } = await import('./inventory-operations');
    await expect(
      inTenant((db) =>
        allocateForSale(db, scope, {
          medicineId,
          requiredUnits: 20,
          at: new Date(),
          idempotencyKeyPrefix: 'counter-attempt',
        })
      )
    ).rejects.toMatchObject({ reason: 'INSUFFICIENT_STOCK' });
    await expect(
      inTenant((db) =>
        reserveSupplierClaim(db, scope, {
          inventoryLotId: eligibleLotId,
          reservedUnits: 10,
          returnBy: new Date(Date.now() + 86400000),
        })
      )
    ).rejects.toMatchObject({ reason: 'INSUFFICIENT_STOCK' });

    const scans = {
      reservationId: reservation.id,
      productScan: '25000001',
      lotScan: reservation.lotCode!,
      quantityUnits: 10,
      stagingBinScan: staging.code,
    };
    const pick = { ...scans, sourceBinScan: source.code, idempotencyKey: 'pick' };
    for (const invalid of [
      { sourceBinScan: 'unknown bin' },
      { lotScan: 'different batch' },
      { productScan: 'different strength' },
    ]) {
      await expect(
        inTenant((db) => pickWarehouseLine(db, scope, { ...pick, ...invalid }))
      ).rejects.toThrow();
    }
    await inTenant((db) => pickWarehouseLine(db, scope, pick));
    await inTenant((db) => pickWarehouseLine(db, scope, pick));
    await inTenant((db) => packWarehouseLine(db, scope, { ...scans, idempotencyKey: 'pack' }));
    await inTenant((db) =>
      approveTransfer(db, { ...scope, actorId: 'second-approver' }, fulfilled.transferId!)
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const shipment = await inTenant((db) =>
        dispatchTransfer(db, scope, fulfilled.transferId!, 'dispatch')
      );
      expect(shipment.status).toBe('DISPATCHED');
    }
    const beforeReceipt = await inTenant(async (db) => ({
      movements: await db.pharmacyStockMovement.count({
        where: {
          organizationId,
          inventoryLotId: eligibleLotId,
          disposition: 'IN_TRANSIT',
          quantityUnits: 10,
        },
      }),
      finance: await db.financeJournalEntry.count({
        where: {
          organizationId,
          sourceKind: 'PHARMACY_INTERBRANCH_TRANSFER_LINE',
          sourceId: reservation.transferLineId,
        },
      }),
    }));
    expect(beforeReceipt).toEqual({ movements: 1, finance: 1 });
    const destination = destinations.find((d) => d.branchId === fulfilled.toBranchId)!;
    const receipt = {
      transferId: fulfilled.transferId!,
      lineId: reservation.transferLineId,
      receivedUnits: 10,
      productScan: scans.productScan,
      lotScan: scans.lotScan,
      binScan: destination.code,
      idempotencyKeyPrefix: 'receive',
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await inTenant((db) =>
        receiveWarehouseTransferLine(db, { ...scope, branchId: destination.branchId }, receipt)
      );
    }
    const destinationBalances = await inTenant((db) =>
      db.pharmacyStockBalance.findMany({
        where: {
          organizationId,
          branchId: destination.branchId,
          disposition: 'AVAILABLE',
          stockLocationId: destination.id,
        },
      })
    );
    expect(destinationBalances.map((b) => b.onHandUnits)).toEqual([10]);
  }, 30000);
  it('blocks packed stock on a mid-shipment recall and traces the batch into quarantine at the receiving branch', async () => {
    const { createWarehouseOutbound, pickWarehouseLine, packWarehouseLine } =
      await import('./warehouse-outbound');
    const { createRecall, approveTransfer, dispatchTransfer, receiveTransferLine } =
      await import('./inventory-operations');
    const { warehouseRecallTrace } = await import('./warehouse-quality');
    const { medicineId, source, staging, destinations, eligibleLotId } = await stockFixture(
      'recall',
      '25000002',
      20
    );
    const shipments = [];
    for (const destination of destinations) {
      const order = await inTenant((db) =>
        createWarehouseOutbound(db, scope, {
          toBranchId: destination.branchId,
          lines: [{ medicineId, destinationStockLocationId: destination.id, requestedUnits: 10 }],
          idempotencyKey: 'recall-request-' + destination.branchId,
        })
      );
      const r = order.reservations[0]!;
      const scans = {
        reservationId: r.id,
        productScan: '25000002',
        lotScan: r.lotCode!,
        stagingBinScan: staging.code,
        quantityUnits: 10,
      };
      await inTenant((db) =>
        pickWarehouseLine(db, scope, {
          ...scans,
          sourceBinScan: source.code,
          idempotencyKey: 'pick-' + r.id,
        })
      );
      await inTenant((db) =>
        packWarehouseLine(db, scope, { ...scans, idempotencyKey: 'pack-' + r.id })
      );
      await inTenant((db) =>
        approveTransfer(db, { ...scope, actorId: 'reviewer' }, order.transferId!)
      );
      shipments.push({
        transferId: order.transferId!,
        lineId: r.transferLineId,
        destination,
        scans,
      });
    }
    const [sent, packed] = shipments;
    await inTenant((db) => dispatchTransfer(db, scope, sent!.transferId, 'first-dispatch'));
    const recall = await inTenant(async (db) => {
      const lot = await db.pharmacyInventoryLot.findUniqueOrThrow({ where: { id: eligibleLotId } });
      return createRecall(db, scope, {
        batchId: lot.manufacturingBatchId,
        reference: 'pilot-recall',
        reason: 'quality alert',
      });
    });
    await expect(
      inTenant((db) => dispatchTransfer(db, scope, packed!.transferId, 'held-dispatch'))
    ).rejects.toThrow();
    const before = await inTenant((db) => warehouseRecallTrace(db, organizationId, recall.id));
    expect(before.bins.find((b) => b.stockLocationId === staging.id)).toMatchObject({
      disposition: 'QUARANTINE',
      onHandUnits: 10,
    });
    expect(
      await inTenant((db) =>
        db.pharmacyWarehouseReservation.findUnique({
          where: { transferLineId: packed!.lineId },
          select: { state: true },
        })
      )
    ).toEqual({ state: 'CANCELLED' });
    expect(before.shipments).toHaveLength(1);
    expect(before.shipments[0]).toMatchObject({
      transferId: sent!.transferId,
      toBranchId: sent!.destination.branchId,
      inTransitUnits: 10,
    });
    expect(before.bins.reduce((sum, row) => sum + row.onHandUnits, 0)).toBe(20);
    await inTenant((db) =>
      receiveTransferLine(
        db,
        { ...scope, branchId: sent!.destination.branchId },
        {
          transferId: sent!.transferId,
          lineId: sent!.lineId,
          receivedUnits: 10,
          binScan: sent!.destination.code,
          productScan: sent!.scans.productScan,
          lotScan: sent!.scans.lotScan,
          idempotencyKeyPrefix: 'recalled-receipt',
        }
      )
    );
    const after = await inTenant((db) => warehouseRecallTrace(db, organizationId, recall.id));
    expect(after.shipments[0]).toMatchObject({ inTransitUnits: 0, receivedUnits: 10 });
    expect(after.bins.find((b) => b.branchId === sent!.destination.branchId)).toMatchObject({
      disposition: 'QUARANTINE',
      onHandUnits: 10,
    });
    expect(after.bins.reduce((sum, row) => sum + row.onHandUnits, 0)).toBe(20);
  }, 30000);
});
