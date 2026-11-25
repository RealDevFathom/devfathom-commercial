// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { shelfLabelCode } from './shelf-label-code';

const url = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const tag = randomUUID(),
  organizationId = 'quality-' + tag,
  site = 'site-' + tag,
  branch = 'store-' + tag,
  actorId = 'reviewer-' + tag;
const from = { organizationId, branchId: site, actorId },
  to = { organizationId, branchId: branch, actorId };
let tenancy: typeof import('@/lib/tenancy/scoped-db'),
  quality: typeof import('./warehouse-quality'),
  operations: typeof import('./inventory-operations'),
  temperature: typeof import('./temperature-log');
const run = <T>(work: (db: ScopedDb) => Promise<T>) => tenancy.withTenantDb(organizationId, work);
const expiry = new Date('2090-01-01T00:00:00Z');

describe.skipIf(!url)('warehouse temperature, custody and recall on PostgreSQL', () => {
  beforeAll(async () => {
    [tenancy, quality, operations, temperature] = await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('./warehouse-quality'),
      import('./inventory-operations'),
      import('./temperature-log'),
    ]);
    await (
      await import('@/lib/testing/rls-role-guard')
    ).assertRlsEnforcingRole(tenancy.withPlatformDb);
    await tenancy.withPlatformDb((db) =>
      db.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          legalName: 'QA Quality',
          displayName: 'QA Quality',
          status: 'ACTIVE',
        },
      })
    );
    await run(async (db) => {
      for (const id of [site, branch])
        await db.pharmacyBranch.create({
          data: {
            organizationId,
            id,
            code: id,
            name: id,
            addressLine: 'Supplier Road',
            city: 'Lahore',
            provinceCode: 'PB',
            warehouseEnabled: id === site,
          },
        });
    });
  });
  async function fixture() {
    const code = randomUUID();
    return run(async (db) => {
      const medicine = await db.medicine.create({
        data: {
          organizationId,
          productName: 'Refrigerated medicine ' + code,
          productFamily: 'PHARMACEUTICAL',
          coldChain: true,
          minimumStorageTemperatureC: 2,
          maximumStorageTemperatureC: 8,
          presentations: { create: { organizationId, presentation: '10 units' } },
        },
        include: { presentations: true },
      });
      const pack = await db.packLevel.create({
        data: {
          organizationId,
          presentationId: medicine.presentations[0]!.id,
          versionGroupId: code,
          version: 1,
          level: 'STRIP',
          unitsPerParent: 10,
          effectiveFrom: new Date('2020-01-01'),
        },
      });
      const batch = await db.pharmacyManufacturingBatch.create({
        data: { organizationId, medicineId: medicine.id, batchNumber: code, expiresAt: expiry },
      });
      const lot = await db.pharmacyInventoryLot.create({
        data: {
          organizationId,
          branchId: site,
          manufacturingBatchId: batch.id,
          packLevelId: pack.id,
          unitsPerPack: 10,
          supplierName: 'Seed supplier',
          supplierInvoiceRef: code,
          unitCostMinor: 0,
          printedMrpMinor: 100,
          receivedExpiresAt: expiry,
          receivedExpiryPrecision: 'DAY',
          receivedAt: new Date(),
        },
      });
      const locations = [];
      for (const branchId of [site, branch]) {
        const location = await db.pharmacyStockLocation.create({
          data: {
            organizationId,
            branchId,
            code: 'COLD-' + code,
            name: 'Cold bin',
            kind: 'FRIDGE',
            coldChain: true,
            minimumTemperatureC: 2,
            maximumTemperatureC: 8,
          },
        });
        await db.pharmacyTemperatureLog.create({
          data: {
            organizationId,
            branchId,
            stockLocationId: location.id,
            actorId,
            temperatureC: 4,
            recordedAt: new Date(),
            outOfRange: false,
          },
        });
        locations.push(location);
      }
      return { medicine, batch, lot, source: locations[0]!, destination: locations[1]! };
    });
  }

  it('keeps a storage exposure held after normal readings return, until reviewer release', async () => {
    const f = await fixture();
    await run((db) =>
      db.pharmacyStockMovement.create({
        data: {
          ...from,
          inventoryLotId: f.lot.id,
          stockLocationId: f.source.id,
          kind: 'RECEIPT',
          disposition: 'AVAILABLE',
          quantityUnits: 10,
          sealedPackDelta: 1,
          looseUnitDelta: 0,
          idempotencyKey: 'stock:' + f.lot.id,
        },
      })
    );
    await run((db) =>
      temperature.ingestTemperatureReadings(
        db,
        from,
        f.source.id,
        new temperature.ManualTemperatureReadingSource({ temperatureC: 13, recordedAt: new Date() })
      )
    );
    await run((db) =>
      temperature.ingestTemperatureReadings(
        db,
        from,
        f.source.id,
        new temperature.ManualTemperatureReadingSource({ temperatureC: 5, recordedAt: new Date() })
      )
    );
    const incident = (await run((db) => quality.listWarehouseQuality(db, from))).find(
      (q) => q.inventoryLotId === f.lot.id
    )!;
    expect(incident).toMatchObject({ quantityUnits: 10, status: 'OPEN' });
    const balances = (db: ScopedDb) =>
      db.pharmacyStockBalance.findMany({
        where: { organizationId, inventoryLotId: f.lot.id, onHandUnits: { gt: 0 } },
        select: { disposition: true, onHandUnits: true },
      });
    expect(await run(balances)).toEqual([{ disposition: 'QUARANTINE', onHandUnits: 10 }]);
    await expect(
      run((db) =>
        operations.releaseQuarantinedPart(db, from, {
          inventoryLotId: f.lot.id,
          stockLocationId: f.source.id,
          units: 10,
          reason: 'manual',
          idempotencyKeyPrefix: 'bypass',
        })
      )
    ).rejects.toThrow();
    await run((db) =>
      quality.reviewWarehouseQuality(db, from, {
        incidentId: incident.id,
        decision: 'RELEASE',
        reason: 'Stability verified.',
        evidenceRef: 'QA doc',
      })
    );
    expect(await run(balances)).toEqual([{ disposition: 'AVAILABLE', onHandUnits: 10 }]);
  });

  it('captures cold-chain receipt, damage, open shortage, redelivery, replay and recall destinations', async () => {
    const f = await fixture();
    const releaseBin = await run(async (db) => {
      await db.pharmacyStockLocation.update({
        where: { id: f.source.id },
        data: { warehouseStaging: true },
      });
      const bin = await db.pharmacyStockLocation.create({
        data: {
          organizationId,
          branchId: site,
          code: 'RELEASE-' + f.lot.id,
          name: 'Stock fridge',
          kind: 'FRIDGE',
          coldChain: true,
          minimumTemperatureC: 2,
          maximumTemperatureC: 8,
        },
      });
      await db.pharmacyTemperatureLog.create({
        data: {
          organizationId,
          branchId: site,
          stockLocationId: bin.id,
          actorId,
          temperatureC: 5,
          recordedAt: new Date(),
          outOfRange: false,
        },
      });
      return bin;
    });
    const { transfer, line } = await run(async (db) => {
      const transfer = await db.pharmacyInterbranchTransfer.create({
        data: {
          organizationId,
          fromBranchId: site,
          toBranchId: branch,
          allocatedById: actorId,
          status: 'APPROVED',
        },
      });
      const line = await db.pharmacyInterbranchTransferLine.create({
        data: {
          organizationId,
          transferId: transfer.id,
          sourceBranchId: site,
          sourceLotId: f.lot.id,
          sourceStockLocationId: f.source.id,
          destinationStockLocationId: f.destination.id,
          quantityUnits: 10,
        },
      });
      const order = await db.pharmacyWarehouseOrder.create({
        data: {
          organizationId,
          branchId: site,
          toBranchId: branch,
          transferId: transfer.id,
          createdById: actorId,
        },
      });
      const demand = await db.pharmacyWarehouseDemand.create({
        data: {
          organizationId,
          branchId: site,
          orderId: order.id,
          medicineId: f.medicine.id,
          destinationStockLocationId: f.destination.id,
          requestedUnits: 10,
        },
      });
      const reservation = await db.pharmacyWarehouseReservation.create({
        data: {
          organizationId,
          branchId: site,
          orderId: order.id,
          demandId: demand.id,
          transferId: transfer.id,
          transferLineId: line.id,
          inventoryLotId: f.lot.id,
          sourceStockLocationId: f.source.id,
          stagingStockLocationId: f.source.id,
          quantityUnits: 10,
          state: 'PACKED',
        },
      });
      await db.pharmacyStockMovement.create({
        data: {
          ...from,
          inventoryLotId: f.lot.id,
          stockLocationId: f.source.id,
          kind: 'TRANSFER_IN',
          disposition: 'WAREHOUSE_RESERVED',
          quantityUnits: 10,
          sealedPackDelta: 1,
          looseUnitDelta: 0,
          idempotencyKey: 'wh:reserve:' + reservation.id + ':fixture:in',
        },
      });
      return { transfer, line };
    });
    expect(
      await run((db) => quality.noteMissingWarehouseDispatchEvidence(db, from, transfer.id))
    ).toBe(true);
    const open = (await run((db) => quality.listWarehouseQuality(db, from))).find(
      (i) => i.transferId === transfer.id
    )!;
    const envelope = { minimumC: 3, maximumC: 7, evidenceRef: 'Transport log' };
    await run((db) =>
      quality.recordWarehouseDispatchEvidence(db, from, {
        transferId: transfer.id,
        requestKey: 'dispatch:' + transfer.id,
        ...envelope,
      })
    );
    expect(
      await run((db) =>
        db.pharmacyWarehouseReservation.findUnique({ where: { transferLineId: line.id } })
      )
    ).toMatchObject({ state: 'CANCELLED' });
    expect(
      await run((db) =>
        db.pharmacyStockBalance.findFirst({
          where: { inventoryLotId: f.lot.id, disposition: 'QUARANTINE' },
        })
      )
    ).toMatchObject({ onHandUnits: 10 });
    expect(open.requiresReleaseBin).toBe(true);
    const release = {
      incidentId: open.id,
      decision: 'RELEASE' as const,
      reason: 'Verified loading log',
      evidenceRef: 'Corrected logger log',
    };
    await expect(run((db) => quality.reviewWarehouseQuality(db, from, release))).rejects.toThrow();
    await run((db) =>
      quality.reviewWarehouseQuality(db, from, { ...release, destinationBinCode: releaseBin.code })
    );
    await run((db) =>
      quality.reviewWarehouseQuality(db, from, { ...release, destinationBinCode: releaseBin.code })
    );
    await expect(
      run((db) =>
        quality.reviewWarehouseQuality(db, from, { ...release, destinationBinCode: f.source.code })
      )
    ).rejects.toThrow();
    expect(
      await run((db) =>
        quality.warehouseDispatchQualityReason(db, from, transfer.id, f.lot.id, f.source.id)
      )
    ).toBeNull();
    await run(async (db) => {
      // Isolate destination custody from the separately tested allocation workflow.
      await db.pharmacyStockMovement.create({
        data: {
          ...from,
          inventoryLotId: f.lot.id,
          stockLocationId: releaseBin.id,
          kind: 'TRANSFER_OUT',
          disposition: 'AVAILABLE',
          quantityUnits: -10,
          sealedPackDelta: -1,
          looseUnitDelta: 0,
          idempotencyKey: 'loaded:' + line.id,
        },
      });
      await db.pharmacyWarehouseReservation.update({
        where: { transferLineId: line.id },
        data: { state: 'DISPATCHED' },
      });
      await db.pharmacyInterbranchTransfer.update({
        where: { id: transfer.id },
        data: { status: 'DISPATCHED', dispatchedAt: new Date(), dispatchedById: actorId },
      });
      await db.pharmacyStockMovement.create({
        data: {
          ...from,
          inventoryLotId: f.lot.id,
          stockLocationId: f.source.id,
          kind: 'TRANSFER_IN',
          disposition: 'IN_TRANSIT',
          quantityUnits: 10,
          sealedPackDelta: 1,
          looseUnitDelta: 0,
          idempotencyKey: 'transit:' + line.id,
        },
      });
    });
    // Cancelled allocations remain on the manifest for audit but never entered transit.
    await run(async (db) => {
      const prior = await db.pharmacyWarehouseReservation.findUniqueOrThrow({
        where: { transferLineId: line.id },
      });
      const alternate = await db.pharmacyStockLocation.create({
        data: {
          organizationId,
          branchId: site,
          code: 'OTHER-' + line.id,
          name: 'Alternate bin',
          kind: 'RACK_BIN',
        },
      });
      const cancelledLine = await db.pharmacyInterbranchTransferLine.create({
        data: {
          organizationId,
          transferId: transfer.id,
          sourceBranchId: site,
          sourceLotId: f.lot.id,
          sourceStockLocationId: alternate.id,
          destinationStockLocationId: f.destination.id,
          quantityUnits: 20,
        },
      });
      await db.pharmacyWarehouseReservation.create({
        data: {
          organizationId,
          branchId: site,
          orderId: prior.orderId,
          demandId: prior.demandId,
          transferId: transfer.id,
          transferLineId: cancelledLine.id,
          inventoryLotId: f.lot.id,
          sourceStockLocationId: alternate.id,
          quantityUnits: 20,
          state: 'CANCELLED',
        },
      });
    });
    const receipt = {
      transferId: transfer.id,
      lineId: line.id,
      receivedUnits: 6,
      damagedUnits: 1,
      lotScan: shelfLabelCode(f.lot.shelfLabelNumber),
      binScan: f.destination.code,
      productScan: f.medicine.id,
      idempotencyKeyPrefix: 'receipt:' + line.id,
    };
    expect((await run((db) => operations.receiveTransferLine(db, to, receipt))).status).toBe(
      'EXCEPTION'
    );
    expect((await run((db) => operations.receiveTransferLine(db, to, receipt))).status).toBe(
      'EXCEPTION'
    );
    await expect(
      run((db) => operations.receiveTransferLine(db, to, { ...receipt, damagedUnits: 0 }))
    ).rejects.toThrow();
    expect(
      await run((db) =>
        db.pharmacyWarehouseTransportEvidence.findFirst({
          where: { organizationId, transferLineId: line.id },
        })
      )
    ).toMatchObject({ heldUnits: 6, damagedUnits: 1, shortageUnits: 4 });
    const notice = await run((db) =>
      operations.createRecall(db, from, {
        batchId: f.batch.id,
        reference: 'QA recall ' + line.id,
        reason: 'Recall exercise',
      })
    );
    const trace = await run((db) => quality.warehouseRecallTrace(db, organizationId, notice.id));
    expect(trace.shipments).toMatchObject([
      { toBranchId: branch, dispatchedUnits: 10, receivedUnits: 6, inTransitUnits: 4 },
    ]);
    expect(trace.bins.map((b) => [b.disposition, b.onHandUnits]).sort()).toEqual([
      ['DAMAGED', 1],
      ['IN_TRANSIT', 4],
      ['QUARANTINE', 5],
    ]);
    expect(
      (
        await run((db) =>
          operations.receiveTransferLine(db, to, {
            ...receipt,
            idempotencyKeyPrefix: 'late:' + line.id,
            transportEvidence: envelope,
            damagedUnits: 0,
            receivedUnits: 4,
          })
        )
      ).status
    ).toBe('RECEIVED');
    const late = await run((db) =>
      db.pharmacyWarehouseTransportEvidence.findFirst({
        where: { organizationId, requestKey: 'late:' + line.id },
      })
    );
    expect(late).toMatchObject({ heldUnits: 4, shortageUnits: 0 });
    const stock = await run((db) =>
      db.pharmacyStockBalance.findMany({
        where: {
          branchId: branch,
          lot: { manufacturingBatchId: f.batch.id },
          onHandUnits: { gt: 0 },
          disposition: 'AVAILABLE',
        },
      })
    );
    expect(stock).toHaveLength(0);
  });
});
