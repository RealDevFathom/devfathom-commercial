import { describe, expect, it, vi } from 'vitest';
import { commitEntityRows, rollbackImportedEntities, type EntityImportWriter } from './entity-committers';

function writer() {
  const entity = (type: string) => async () => [{ entityType: type, entityId: `${type}-1`, operation: 'CREATED' as const }];
  return {
    product: vi.fn(async () => [
      { entityType: 'Medicine', entityId: 'medicine-1', operation: 'CREATED' as const },
      { entityType: 'PharmacyStockMovement', entityId: 'opening-1', operation: 'STOCK_MOVEMENT' as const, movementKind: 'OPENING' as const },
    ]),
    customer: vi.fn(entity('PharmacyCustomer')),
    supplier: vi.fn(entity('PharmacySupplier')),
    historicalSale: vi.fn(entity('PharmacyImportedSale')),
    manifest: vi.fn(), audit: vi.fn(), remove: vi.fn(), reverseOpeningMovement: vi.fn(async () => 'reversal-1'),
  } satisfies EntityImportWriter;
}
const context = { batchId: 'batch', actorId: 'owner', branchId: 'branch', stockLocationId: 'location', awardImportedLoyalty: false };
const row = (targetModelKey: string) => ({ id: targetModelKey, sourceKey: targetModelKey, targetModelKey, rawPayload: {} });

describe('entity committer registry', () => {
  it.each([['med.product', 'product'], ['party.customer', 'customer'], ['party.supplier', 'supplier'], ['history.document', 'historicalSale']] as const)(
    'commits %s and manifests every created id', async (key, method) => {
      const target = writer();
      const result = await commitEntityRows(target, context, [row(key)], 0);
      expect(target[method]).toHaveBeenCalledOnce();
      expect(target.manifest).toHaveBeenCalledTimes(result.length);
    }
  );

  it('uses only OPENING movements for imported product stock', async () => {
    const target = writer();
    const created = await commitEntityRows(target, context, [row('med.product')], 0);
    expect(created.find((item) => item.operation === 'STOCK_MOVEMENT')?.entityId).toBe('opening-1');
  });

  it('rejects a product adapter that attempts a receipt movement', async () => {
    const target = writer();
    target.product.mockResolvedValueOnce([
      { entityType: 'PharmacyStockMovement', entityId: 'bad', operation: 'STOCK_MOVEMENT' },
    ]);
    await expect(commitEntityRows(target, context, [row('med.product')], 0)).rejects.toThrow('OPENING');
  });

  it('refuses unresolved blocking preview errors', async () => {
    await expect(commitEntityRows(writer(), context, [row('med.product')], 1)).rejects.toThrow('blocking preview');
  });

  it.each(['Medicine', 'PharmacyCustomer', 'PharmacySupplier', 'PharmacyImportedSale'])('rolls back %s', async (entityType) => {
    const target = writer();
    await rollbackImportedEntities(target, context, [{ entityType, entityId: 'created', operation: 'CREATED' }]);
    expect(target.remove).toHaveBeenCalledWith(expect.objectContaining({ entityType }), context);
  });

  it('compensates opening movements rather than deleting them', async () => {
    const target = writer();
    await rollbackImportedEntities(target, context, [{ entityType: 'PharmacyStockMovement', entityId: 'opening', operation: 'STOCK_MOVEMENT' }]);
    expect(target.reverseOpeningMovement).toHaveBeenCalledOnce();
    expect(target.remove).not.toHaveBeenCalled();
  });
});
