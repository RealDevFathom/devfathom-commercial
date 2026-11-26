import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { PharmacyInventoryError } from './inventory';
import { actorIsPharmacyOwner } from './procurement-access';
import type { LedgerScope } from './stock-ledger';

export async function configureWarehouseSite(
  db: ScopedDb,
  scope: LedgerScope,
  input: { enabled: boolean; minimumShelfLifeDays: number; stagingLocationIds: string[] }
) {
  const { organizationId, branchId, actorId } = scope;
  if (!(await actorIsPharmacyOwner(db, organizationId, actorId)))
    throw new PharmacyInventoryError(
      'BLOCKED_STOCK',
      'Only the pharmacy owner may configure warehouse operations.'
    );
  const [branch] = await db.$queryRaw<{ warehouseEnabled: boolean }[]>`
    SELECT "warehouseEnabled" FROM pharmacy_branches WHERE "organizationId"=${organizationId} AND id=${branchId} AND active FOR UPDATE`;
  if (!branch) throw new PharmacyInventoryError('NOT_FOUND');
  const where = { organizationId, branchId };
  if (branch.warehouseEnabled && !input.enabled) {
    const pending = await Promise.all([
      db.pharmacyWarehouseOrder.count({ where: { ...where, status: 'OPEN' } }),
      db.pharmacyWarehouseRequest.count({
        where: { organizationId, warehouseBranchId: branchId, status: 'REQUESTED' },
      }),
      db.pharmacyInterbranchTransfer.count({
        where: {
          organizationId,
          fromBranchId: branchId,
          status: { in: ['DISPATCHED', 'PARTIALLY_RECEIVED', 'EXCEPTION'] },
        },
      }),
      db.pharmacyWarehousePutAway.count({
        where: {
          ...where,
          completedAt: null,
          line: {
            goodsReceipt: { status: 'POSTED' },
            inventoryLot: {
              balances: { some: { disposition: 'WAREHOUSE_RECEIVING', onHandUnits: { gt: 0 } } },
            },
          },
        },
      }),
      db.pharmacyWarehouseQualityIncident.count({ where: { ...where, status: 'OPEN' } }),
    ]);
    if (pending.some((n) => n > 0))
      throw new PharmacyInventoryError(
        'INVALID_STATE',
        'Complete or cancel open warehouse work before switching off this site.'
      );
  }
  const ids = [...new Set(input.stagingLocationIds)];
  if (!input.enabled && ids.length)
    throw new PharmacyInventoryError(
      'INVALID_STATE',
      'Clear the staging bins when switching off warehouse operations.'
    );
  const eligible = await db.pharmacyStockLocation.count({
    where: {
      ...where,
      id: { in: ids },
      active: true,
      kind: { in: ['STORE', 'RACK_BIN', 'FRIDGE'] },
    },
  });
  if (eligible !== ids.length)
    throw new PharmacyInventoryError(
      'INVALID_STATE',
      'Choose active storage, rack or refrigerator bins at this site for staging.'
    );
  const retired = { ...where, warehouseStaging: true, id: { notIn: ids } };
  const exiting = await db.pharmacyStockLocation.findMany({ where: retired, select: { id: true } });
  const active = await db.pharmacyWarehouseReservation.count({
    where: {
      ...where,
      stagingStockLocationId: { in: exiting.map((bin) => bin.id) },
      state: { in: ['PICKED', 'PACKED'] },
    },
  });
  if (active)
    throw new PharmacyInventoryError(
      'INVALID_STATE',
      'Finish the picks in these staging bins before changing their use.'
    );
  const added = await db.pharmacyStockLocation.findMany({
    where: { ...where, warehouseStaging: false, id: { in: ids } },
    select: { id: true },
  });
  if (added.length) {
    const stocked = await db.pharmacyStockBalance.count({
      where: {
        ...where,
        stockLocationId: { in: added.map((bin) => bin.id) },
        disposition: { in: ['AVAILABLE', 'WAREHOUSE_RECEIVING', 'WAREHOUSE_RESERVED'] },
        onHandUnits: { gt: 0 },
      },
    });
    if (stocked)
      throw new PharmacyInventoryError(
        'INVALID_STATE',
        'Choose an empty staging bin or move its stock before changing its use.'
      );
  }
  await db.pharmacyStockLocation.updateMany({ where: retired, data: { warehouseStaging: false } });
  if (ids.length)
    await db.pharmacyStockLocation.updateMany({
      where: { ...where, id: { in: ids } },
      data: { warehouseStaging: true },
    });
  return db.pharmacyBranch.update({
    where: { id: branchId },
    data: {
      warehouseEnabled: input.enabled,
      warehouseMinimumShelfLifeDays: input.minimumShelfLifeDays,
    },
    select: { id: true, warehouseEnabled: true, warehouseMinimumShelfLifeDays: true },
  });
}
