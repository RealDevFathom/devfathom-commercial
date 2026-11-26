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

async function stockFixture(
  label: string,
  productCode: string,
  eligibleUnits: number,
  stockReceivingBranch = false
) {
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
    async function stock(days: number, bin = source) {
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
      const { lot } = await receiveLot(
        db,
        { ...scope, branchId: bin.branchId },
        {
          manufacturingBatchId: batch.id,
          packLevelId: pack.id,
          stockLocationId: bin.id,
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
        }
      );
      return lot.id;
    }
    if (stockReceivingBranch) await stock(45, bins[1]!);
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

  it.each(['dispatch', 'cancel'] as const)(
    'replenishes the released lot in its original bin before %s without reusing its cancelled line',
    async (outcome) => {
      const key = 'release-refill-' + outcome;
      const affected = await stockFixture(
        key + '-held',
        outcome === 'dispatch' ? '25000050' : '25000052',
        7
      );
      const sibling = await stockFixture(
        key + '-sibling',
        outcome === 'dispatch' ? '25000051' : '25000053',
        13
      );
      const {
        createWarehouseOutbound,
        replenishWarehouseOutbound,
        pickWarehouseLine,
        packWarehouseLine,
        cancelWarehouseOutbound,
        adoptWarehouseTransfer,
      } = await import('./warehouse-outbound');
      const { approveTransfer, dispatchTransfer, receiveTransferLine, setManufacturingBatchState } =
        await import('./inventory-operations');
      const { listWarehouseQuality, reviewWarehouseQuality } = await import('./warehouse-quality');
      const order = await inTenant((db) =>
        createWarehouseOutbound(db, scope, {
          toBranchId: affected.destinations[0]!.branchId,
          idempotencyKey: key + ':create',
          lines: [affected, sibling].map((f) => ({
            medicineId: f.medicineId,
            destinationStockLocationId: f.destinations[0]!.id,
            requestedUnits: f === affected ? 7 : 13,
          })),
        })
      );
      type Reservation = (typeof order.reservations)[number];
      async function pack(r: Reservation, f: typeof affected) {
        const scans = {
          reservationId: r.id,
          quantityUnits: r.quantityUnits,
          productScan: f.medicineId,
          lotScan: r.lotCode!,
          stagingBinScan: f.staging.code,
        };
        await inTenant((db) =>
          pickWarehouseLine(db, scope, {
            ...scans,
            sourceBinScan: f.source.code,
            idempotencyKey: key + ':pick:' + r.id,
          })
        );
        await inTenant((db) =>
          packWarehouseLine(db, scope, { ...scans, idempotencyKey: key + ':pack:' + r.id })
        );
      }
      const original = order.reservations.find((r) => r.inventoryLotId === affected.eligibleLotId)!;
      const packedSibling = order.reservations.find(
        (r) => r.inventoryLotId === sibling.eligibleLotId
      )!;
      const priorTransferId = order.transferId!;
      await pack(original, affected);
      await pack(packedSibling, sibling);
      const approver = { ...scope, actorId: 'reviewer' };
      await inTenant((db) => approveTransfer(db, approver, priorTransferId));
      const batch = await inTenant((db) =>
        db.pharmacyInventoryLot.findUniqueOrThrow({
          where: { id: affected.eligibleLotId },
          select: { manufacturingBatchId: true },
        })
      );
      for (const state of ['QUARANTINED', 'ACTIVE'] as const) {
        await inTenant((db) =>
          setManufacturingBatchState(
            db,
            organizationId,
            {
              manufacturingBatchId: batch.manufacturingBatchId,
              state,
              reason: 'Quality assessment',
            },
            scope.actorId
          )
        );
      }
      const incident = (await inTenant((db) => listWarehouseQuality(db, scope))).find(
        (row) => row.inventoryLotId === affected.eligibleLotId
      )!;
      await inTenant((db) =>
        reviewWarehouseQuality(db, scope, {
          incidentId: incident.id,
          decision: 'RELEASE',
          reason: 'Product cleared',
          evidenceRef: 'Release record',
          destinationBinCode: affected.source.code,
        })
      );
      const siblingMoves = () =>
        inTenant((db) =>
          db.pharmacyStockMovement.count({
            where: { organizationId, inventoryLotId: sibling.eligibleLotId },
          })
        );
      const beforeMoves = await siblingMoves();
      const refill = (operationKey: string) =>
        inTenant((db) =>
          replenishWarehouseOutbound(db, scope, {
            orderId: order.id,
            idempotencyKey: key + operationKey,
          })
        );
      const [replacement, replay] = await Promise.all([refill(':refill'), refill(':refill')]);
      const replacementId = replacement.transferId!;
      expect(replacementId).not.toBe(priorTransferId);
      expect(replay.transferId).toBe(replacementId);
      expect((await refill(':refresh')).transferId).toBe(replacementId);
      expect(replacement.demands.map((d) => d.shortfallUnits)).toEqual([0, 0]);
      expect(replacement.reservations).toHaveLength(3);
      const repicked = replacement.reservations.find(
        (r) => r.inventoryLotId === affected.eligibleLotId && r.state === 'RESERVED'
      )!;
      expect(repicked).toMatchObject({
        quantityUnits: 7,
        sourceStockLocationId: affected.source.id,
        transferId: replacementId,
      });
      expect(repicked.id).not.toBe(original.id);
      expect(repicked.transferLineId).not.toBe(original.transferLineId);
      const carried = replacement.reservations.find((r) => r.id === packedSibling.id)!;
      expect(carried).toMatchObject({
        transferId: replacementId,
        state: 'PACKED',
        quantityUnits: 13,
        stagingStockLocationId: sibling.staging.id,
      });
      expect(carried.transferLineId).not.toBe(packedSibling.transferLineId);
      expect(replacement.reservations.find((r) => r.id === original.id)).toMatchObject({
        state: 'CANCELLED',
        transferId: priorTransferId,
        transferLineId: original.transferLineId,
      });
      expect(await siblingMoves()).toBe(beforeMoves);
      expect(
        (
          await inTenant((db) =>
            db.pharmacyInterbranchTransfer.findUniqueOrThrow({ where: { id: priorTransferId } })
          )
        ).status
      ).toBe('SUPERSEDED');
      const originalLines = await inTenant((db) =>
        db.pharmacyInterbranchTransferLine.findMany({
          where: { organizationId, transferId: priorTransferId },
          select: { id: true, receivedUnits: true },
        })
      );
      expect(originalLines).toEqual(
        expect.arrayContaining(
          [original, packedSibling].map((r) => ({ id: r.transferLineId, receivedUnits: 0 }))
        )
      );
      const audit = await inTenant((db) =>
        db.pharmacyWarehouseCommand.findFirstOrThrow({
          where: { organizationId, orderId: order.id, kind: 'REPLACE_TRANSFER' },
        })
      );
      expect(audit.payload).toEqual({
        priorTransferId,
        replacementTransferId: replacementId,
        carried: [
          {
            reservationId: packedSibling.id,
            priorLineId: packedSibling.transferLineId,
            replacementLineId: carried.transferLineId,
          },
        ],
      });
      await expect(
        inTenant((db) => approveTransfer(db, approver, priorTransferId))
      ).rejects.toThrow();
      await expect(
        inTenant((db) =>
          adoptWarehouseTransfer(db, scope, {
            transferId: priorTransferId,
            idempotencyKey: key + ':readopt',
          })
        )
      ).rejects.toThrow();
      await expect(
        inTenant((db) => dispatchTransfer(db, scope, priorTransferId, key + ':old-dispatch'))
      ).rejects.toThrow();
      if (outcome === 'cancel') {
        const cancel = () =>
          inTenant((db) =>
            cancelWarehouseOutbound(db, scope, {
              orderId: order.id,
              idempotencyKey: key + ':cancel',
              reason: 'Branch no longer needs stock',
            })
          );
        await cancel();
        await cancel();
        const balances = await inTenant((db) =>
          db.pharmacyStockBalance.findMany({
            where: {
              organizationId,
              inventoryLotId: { in: [affected.eligibleLotId, sibling.eligibleLotId] },
              onHandUnits: { gt: 0 },
            },
            select: {
              inventoryLotId: true,
              stockLocationId: true,
              disposition: true,
              onHandUnits: true,
            },
          })
        );
        expect(balances).toHaveLength(2);
        expect(balances).toEqual(
          expect.arrayContaining([
            {
              inventoryLotId: affected.eligibleLotId,
              stockLocationId: affected.source.id,
              disposition: 'AVAILABLE',
              onHandUnits: 7,
            },
            {
              inventoryLotId: sibling.eligibleLotId,
              stockLocationId: sibling.staging.id,
              disposition: 'QUARANTINE',
              onHandUnits: 13,
            },
          ])
        );
        return;
      }
      await pack(repicked, affected);
      await expect(
        inTenant((db) => dispatchTransfer(db, scope, replacementId, key + ':unapproved'))
      ).rejects.toThrow();
      await inTenant((db) => approveTransfer(db, approver, replacementId));
      for (let n = 0; n < 2; n++)
        await inTenant((db) => dispatchTransfer(db, scope, replacementId, key + ':ship'));
      for (const [r, f] of [
        [repicked, affected],
        [carried, sibling],
      ] as const) {
        const destination = f.destinations[0]!;
        const receipt = {
          transferId: replacementId,
          lineId: r.transferLineId,
          receivedUnits: r.quantityUnits,
          lotScan: r.lotCode!,
          productScan: f.medicineId,
          binScan: destination.code,
          idempotencyKeyPrefix: key + ':receipt:' + r.id,
        };
        for (let n = 0; n < 2; n++)
          await inTenant((db) =>
            receiveTransferLine(db, { ...scope, branchId: destination.branchId }, receipt)
          );
        const remaining = await inTenant((db) =>
          db.pharmacyStockBalance.findMany({
            where: { organizationId, inventoryLotId: r.inventoryLotId, onHandUnits: { gt: 0 } },
          })
        );
        expect(remaining).toHaveLength(0);
        const received = await inTenant((db) =>
          db.pharmacyStockBalance.aggregate({
            where: {
              organizationId,
              branchId: destination.branchId,
              stockLocationId: destination.id,
              disposition: 'AVAILABLE',
            },
            _sum: { onHandUnits: true },
          })
        );
        expect(received._sum.onHandUnits).toBe(r.quantityUnits);
      }
      expect(
        (
          await inTenant((db) =>
            db.pharmacyInterbranchTransfer.findUniqueOrThrow({ where: { id: replacementId } })
          )
        ).status
      ).toBe('RECEIVED');
    },
    30000
  );

  it('withdraws only an affected packed line and requires fresh approval to ship its unaffected sibling', async () => {
    const affected = await stockFixture('mixed-held', '25000020', 10, true);
    const healthy = await stockFixture('mixed-good', '25000021', 10, true);
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
    // The recipient also expects seven units on an ordinary transfer for the withdrawn SKU.
    // Its legacy line has no warehouse reservation; all three supply readers must retain it.
    const receiving = { ...scope, branchId: destination.branchId, actorId: randomUUID() };
    await inTenant(async (db) => {
      await db.organizationDepartment.createMany({
        data: [{ organizationId, key: 'PHARMACY', name: 'Pharmacy' }],
        skipDuplicates: true,
      });
      await db.user.create({
        data: {
          id: receiving.actorId,
          organizationId,
          email: receiving.actorId + '@example.invalid',
          name: 'Buyer',
          department: 'PHARMACY',
          title: 'Buyer',
          status: 'ACTIVE',
        },
      });
      await db.pharmacyBranchAssignment.createMany({
        data: [scope.branchId, receiving.branchId].map((branchId) => ({
          organizationId,
          branchId,
          userId: receiving.actorId,
          active: true,
        })),
      });
      const ordinary = await db.pharmacyInterbranchTransfer.create({
        data: {
          organizationId,
          fromBranchId: scope.branchId,
          toBranchId: receiving.branchId,
          status: 'APPROVED',
          allocatedById: scope.actorId,
        },
      });
      await db.pharmacyInterbranchTransferLine.create({
        data: {
          organizationId,
          transferId: ordinary.id,
          sourceBranchId: scope.branchId,
          sourceLotId: affected.shortDatedLotId,
          sourceStockLocationId: affected.source.id,
          destinationStockLocationId: affected.destinations[0]!.id,
          quantityUnits: 7,
        },
      });
      const { DEFAULT_LOST_DEMAND_TRIGGERS } = await import('./lost-demand-advice');
      const demand = [affected, healthy].flatMap((f) =>
        Array.from({ length: DEFAULT_LOST_DEMAND_TRIGGERS.requestCountThreshold }, () => ({
          organizationId,
          branchId: receiving.branchId,
          requestedMedicineId: f.medicineId,
          saleUnit: 'UNIT' as const,
          quantity: 30,
          reason: 'STOCKOUT' as const,
          inventoryRuleSnapshot: {},
          capturedByUserId: scope.actorId,
        }))
      );
      await db.unfulfilledDemandEvent.createMany({ data: demand });
    });
    const { loadForecastingInputs } = await import('./forecasting-inputs');
    const { readLostDemandAdvice } = await import('./lost-demand-advice-reader');
    const { loadSignalFacts } = await import('./stock-signals-operations');
    await inTenant(async (db) => {
      const { advice } = await readLostDemandAdvice(db, receiving);
      const { inbound } = await loadSignalFacts(db, receiving, new Date());
      for (const [medicineId, expectedUnits] of [
        [affected.medicineId, 7],
        [healthy.medicineId, 10],
      ] as const) {
        const recommendation = advice.find((row) => row.medicineId === medicineId);
        expect(recommendation?.onOrderUnits).toBe(expectedUnits);
        // The donor has 10 free short-dated units per SKU. Only the seven units
        // promised on the ordinary transfer still need deducting from that balance.
        expect(recommendation?.transfer).toMatchObject({
          fromBranchId: scope.branchId,
          surplusUnits: medicineId === affected.medicineId ? 3 : 10,
        });
        expect(
          inbound.filter((f) => f.medicineId === medicineId).reduce((n, f) => n + f.units, 0)
        ).toBe(expectedUnits);
        const forecast = await loadForecastingInputs(db, {
          organizationId,
          branchId: receiving.branchId,
          medicineId,
        });
        expect(forecast.inbound.reduce((n, f) => n + f.lot.availableUnits, 0)).toBe(expectedUnits);
      }
    });
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
