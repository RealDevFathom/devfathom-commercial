import { describe, expect, it, vi } from 'vitest';

import { loadReportFilterOptions, REPORT_FILTER_OPTION_LIMIT } from './report-filter-options';

function fakeDb() {
  return {
    pharmacySupplier: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'sup1', name: 'Acme Distributors', active: true },
        { id: 'sup2', name: 'Old Supplier', active: false },
      ]),
    },
    ingredient: { findMany: vi.fn().mockResolvedValue([{ id: 'ing1', name: 'Paracetamol' }]) },
    pharmacyManufacturingBatch: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'batch1',
          batchNumber: 'B-1',
          expiresAt: new Date('2027-03-31T00:00:00Z'),
          medicine: { productName: 'Panadol 500mg' },
        },
      ]),
    },
  };
}

describe('report filter options', () => {
  it('labels supplier, ingredient and batch IDs with names', async () => {
    const db = fakeDb();
    const options = await loadReportFilterOptions(db as never, 'org-a');
    expect(options).toEqual({
      available: true,
      suppliers: [
        { id: 'sup1', label: 'Acme Distributors' },
        { id: 'sup2', label: 'Old Supplier (inactive)' },
      ],
      ingredients: [{ id: 'ing1', label: 'Paracetamol' }],
      batches: [{ id: 'batch1', label: 'Panadol 500mg · batch B-1 · expires 31 Mar 2027' }],
    });
  });

  it('reads only the caller organization, bounded', async () => {
    const db = fakeDb();
    await loadReportFilterOptions(db as never, 'org-a');
    for (const delegate of [db.pharmacySupplier, db.ingredient, db.pharmacyManufacturingBatch]) {
      expect(delegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org-a' },
          take: REPORT_FILTER_OPTION_LIMIT,
        })
      );
    }
  });

  it('falls back to empty pickers without a tenant or when a read fails', async () => {
    const empty = { suppliers: [], ingredients: [], batches: [], available: false };
    expect(await loadReportFilterOptions(fakeDb() as never, null)).toEqual(empty);
    expect(await loadReportFilterOptions(undefined, 'org-a')).toEqual(empty);
    const db = fakeDb();
    db.ingredient.findMany.mockRejectedValue(new Error('private backend detail'));
    expect(await loadReportFilterOptions(db as never, 'org-a')).toEqual(empty);
  });
});
