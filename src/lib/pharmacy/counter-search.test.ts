import { describe, expect, it, vi } from 'vitest';
import { searchCounterCatalog } from './counter';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'actor-a' };
function fixture() {
  const db = {
    medicineBarcode: { findUnique: vi.fn().mockResolvedValue(null) },
    medicineAlias: { findMany: vi.fn().mockResolvedValue([]) },
    medicine: { findMany: vi.fn().mockResolvedValue([]) },
    medicineStrengthComponent: { findMany: vi.fn().mockResolvedValue([]) },
    presentation: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyInventoryLot: { findMany: vi.fn().mockResolvedValue([]) },
    packLevel: { findMany: vi.fn().mockResolvedValue([]) },
    medicinePackMrp: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { db, scoped: db as unknown as ScopedDb };
}
describe('counter catalogue query paths', () => {
  it('uses the tenant/barcode unique key without falling back to fuzzy matches', async () => {
    const { db, scoped } = fixture();
    expect(
      await searchCounterCatalog(scoped, scope, { query: '8964000111222', exactBarcode: true })
    ).toEqual({ rows: [], truncated: false });
    expect(db.medicineBarcode.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_normalizedCode: {
            organizationId: 'org-a',
            normalizedCode: '8964000111222',
          },
        },
      })
    );
    expect(db.medicineAlias.findMany).not.toHaveBeenCalled();
    expect(db.medicine.findMany).not.toHaveBeenCalled();
    expect(db.medicineStrengthComponent.findMany).not.toHaveBeenCalled();
    expect(db.presentation.findMany).not.toHaveBeenCalled();
  });
  it('never hydrates a non-saleable barcode target', async () => {
    const { db, scoped } = fixture();
    db.medicineBarcode.findUnique.mockResolvedValue({
      presentation: { medicineId: 'blocked', medicine: { saleable: false } },
    });
    expect(
      (await searchCounterCatalog(scoped, scope, { query: '123456', exactBarcode: true })).rows
    ).toEqual([]);
    expect(db.medicine.findMany).not.toHaveBeenCalled();
  });
  it('retains substring searches and caps each candidate source at twenty', async () => {
    const { db, scoped } = fixture();
    await searchCounterCatalog(scoped, scope, { query: 'ceta', limit: 50 });
    expect(db.medicine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          saleable: true,
          OR: ['productName', 'brandName', 'manufacturer', 'drapRegistrationNumber'].map(
            (field) => ({ [field]: { contains: 'ceta', mode: 'insensitive' } })
          ),
        }),
        take: 20,
      })
    );
    expect(db.medicineAlias.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20 }));
    expect(db.medicineStrengthComponent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 })
    );
  });
});
