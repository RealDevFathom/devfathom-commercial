/**
 * DEV-575: counter scan and search latency.
 *
 * A scanned barcode resolves with one exact indexed read and skips the fuzzy
 * lookups; a typed search runs its fuzzy lookups together, not one after another.
 */
import { describe, expect, it, vi } from 'vitest';

import { searchCounterCatalog } from './counter';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };

function catalogDb(barcodeHit: boolean) {
  return {
    pharmacySaleLine: { groupBy: vi.fn(async () => []) },
    medicineBarcode: {
      findFirst: vi.fn(async () =>
        barcodeHit ? { presentation: { medicineId: 'medicine-a' } } : null
      ),
    },
    medicineAlias: { findMany: vi.fn(async () => [] as { medicineId: string }[]) },
    medicineStrengthComponent: { findMany: vi.fn(async () => []) },
    presentation: { findMany: vi.fn(async () => []) },
    medicine: { findMany: vi.fn(async () => [] as { id: string }[]) },
    pharmacyInventoryLot: { findMany: vi.fn(async () => []) },
    packLevel: { findMany: vi.fn(async () => []) },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
    pharmacyStockBalance: { findMany: vi.fn(async () => []) },
    pharmacyStockLocation: { findMany: vi.fn(async () => []) },
  };
}

describe('counter search latency (DEV-575)', () => {
  it('resolves an exact barcode without running the fuzzy lookups', async () => {
    const db = catalogDb(true);

    await searchCounterCatalog(db as never, scope, { query: '8964000123456' });

    expect(db.medicineBarcode.findFirst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          normalizedCode: '8964000123456',
        }),
      })
    );
    expect(db.medicineAlias.findMany).not.toHaveBeenCalled();
    expect(db.medicineStrengthComponent.findMany).not.toHaveBeenCalled();
    expect(db.presentation.findMany).not.toHaveBeenCalled();
    // The only medicine read hydrates the barcode's own row.
    expect(db.medicine.findMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['medicine-a'] }, saleable: true }),
      })
    );
  });

  it('runs the fuzzy lookups together and keeps their match order', async () => {
    const db = catalogDb(false);
    let releaseAlias: (rows: { medicineId: string }[]) => void = () => undefined;
    db.medicineAlias.findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseAlias = resolve;
        })
    );
    db.medicine.findMany.mockImplementationOnce(async () => [{ id: 'medicine-name' }]);

    const searching = searchCounterCatalog(db as never, scope, { query: 'Panadol' });
    await vi.waitFor(() => expect(db.medicineAlias.findMany).toHaveBeenCalledOnce());

    // The alias read is still pending, yet the other lookups have started.
    expect(db.medicine.findMany).toHaveBeenCalledOnce();
    expect(db.medicineStrengthComponent.findMany).toHaveBeenCalledOnce();
    expect(db.presentation.findMany).toHaveBeenCalledOnce();

    releaseAlias([{ medicineId: 'medicine-alias' }]);
    await searching;

    expect(db.medicine.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['medicine-alias', 'medicine-name'] } }),
      })
    );
  });
});
