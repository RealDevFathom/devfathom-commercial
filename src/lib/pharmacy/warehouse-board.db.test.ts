// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { configureWarehouseTestDatabase } from '@/lib/test-support/warehouse-database';

configureWarehouseTestDatabase();

describe('warehouse board under PostgreSQL row-level security', () => {
  it('counts a linked request once and keeps replenishment between other branches private', async () => {
    const { warehouseBoard } = await import('./warehouse-board');
    const { withPlatformDb, withTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(withPlatformDb);
    const organizationId = 'wh-board-' + randomUUID();
    await withPlatformDb((db) =>
      db.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          legalName: 'Warehouse fixture',
          displayName: 'Warehouse fixture',
          status: 'ACTIVE',
        },
      })
    );
    await withTenantDb(organizationId, async (db) => {
      const ids = Array.from({ length: 3 }, () => randomUUID());
      const [warehouse, destination, other] = ids;
      for (const id of ids)
        await db.pharmacyBranch.create({
          data: {
            id,
            organizationId,
            name: id,
            code: id,
            warehouseEnabled: id === warehouse,
            addressLine: 'Test road',
            city: 'Karachi',
            provinceCode: 'SD',
          },
        });
      const bin = await db.pharmacyStockLocation.create({
        data: {
          organizationId,
          branchId: destination,
          name: 'Receiving',
          code: 'REC',
          kind: 'STORE',
        },
      });
      const medicine = await db.medicine.create({
        data: { organizationId, productName: 'Fixture 10 mg', productFamily: 'PHARMACEUTICAL' },
      });
      const applied = await db.pharmacyWarehouseOrder.create({
        data: {
          organizationId,
          branchId: warehouse,
          toBranchId: destination,
          createdById: 'fixture',
        },
      });
      await db.pharmacyWarehouseDemand.create({
        data: {
          organizationId,
          branchId: warehouse,
          orderId: applied.id,
          medicineId: medicine.id,
          destinationStockLocationId: bin.id,
          requestedUnits: 15,
        },
      });
      const request = {
        organizationId,
        warehouseBranchId: warehouse,
        branchId: destination,
        medicineId: medicine.id,
        destinationStockLocationId: bin.id,
        requestedById: 'fixture',
      };
      await db.pharmacyWarehouseRequest.createMany({
        data: [
          {
            ...request,
            status: 'ALLOCATED',
            requestedUnits: 15,
            orderId: applied.id,
            idempotencyKey: 'first',
          },
          { ...request, status: 'REQUESTED', requestedUnits: 5, idempotencyKey: 'second' },
          { ...request, status: 'DIRECT_PURCHASE', requestedUnits: 12, idempotencyKey: 'direct' },
        ],
      });
      for (const branchId of [warehouse, destination]) {
        const board = await warehouseBoard(db, { organizationId, branchId, actorId: 'fixture' });
        expect(board.metrics.fillRate).toEqual({
          requestedUnits: 20,
          fulfilledUnits: 0,
          percent: 0,
        });
        expect(board.shortages).toMatchObject([{ orderId: applied.id, shortfallUnits: 15 }]);
        expect(board.metrics.binAccuracy.percent).toBeNull();
      }
      const otherBoard = await warehouseBoard(db, {
        organizationId,
        branchId: other,
        actorId: 'fixture',
      });
      expect(otherBoard.metrics.fillRate.percent).toBeNull();
      expect(otherBoard.shortages).toEqual([]);
    });
  }, 30000);
});
