import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./substitute-finder', () => ({ findSubstituteProposals: vi.fn() }));
import { findSubstituteProposals } from './substitute-finder';
import { authorizeSubstituteSale } from './substitute-sale-authorization';
const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'pharmacist-1' };
const substitution = {
  requestedMedicineId: 'original',
  requestedPresentationId: 'original-p',
  inventoryLotId: 'lot-1',
};
const result = {
  line: {
    id: 'line-1',
    saleId: 'sale-1',
    medicineId: 'alternate',
    presentationId: 'alternate-p',
    packLevelId: 'pack-1',
    canonicalUnits: 2,
    quantity: 2,
    unitPriceMinor: 60,
  },
  allocation: { allocations: [{ inventoryLotId: 'lot-1' }] },
};
const create = vi.fn();
const db = { auditLog: { create } } as never;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findSubstituteProposals).mockResolvedValue([
    {
      inventoryLotId: 'lot-1',
      medicineId: 'alternate',
      presentationId: 'alternate-p',
      packLevelId: 'pack-1',
      priceMinor: 100,
      priceDifferenceMinor: 0,
    } as never,
  ]);
});
it('refuses an actual allocated price above the reference without a reason', async () => {
  await expect(
    authorizeSubstituteSale(db, scope, substitution, 2, async () => result)
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(create).not.toHaveBeenCalled();
});
it('binds the authorized reason and actual price to the resulting sale line', async () => {
  await authorizeSubstituteSale(
    db,
    scope,
    { ...substitution, priceOverrideReason: 'Patient requested this brand' },
    2,
    async () => result
  );
  expect(create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      targetType: 'PharmacySaleLine',
      targetId: 'line-1',
      organizationId: 'org-1',
      actorId: 'pharmacist-1',
      metadata: expect.objectContaining({
        saleId: 'sale-1',
        inventoryLotId: 'lot-1',
        reason: 'Patient requested this brand',
        suppliedPriceMinor: 120,
      }),
    }),
  });
});
it('refuses a changed allocation even with a recorded reason', async () => {
  await expect(
    authorizeSubstituteSale(
      db,
      scope,
      { ...substitution, priceOverrideReason: 'Available brand' },
      2,
      async () => ({ ...result, allocation: { allocations: [{ inventoryLotId: 'lot-2' }] } })
    )
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it.each([
  ['an empty allocation', { ...result, allocation: { allocations: [] } }],
  ['a changed canonical quantity', { ...result, line: { ...result.line, canonicalUnits: 3 } }],
  [
    'an unsafe money product',
    { ...result, line: { ...result.line, unitPriceMinor: Number.MAX_SAFE_INTEGER } },
  ],
] as const)('refuses %s', async (_label, changed) => {
  await expect(
    authorizeSubstituteSale(
      db,
      scope,
      { ...substitution, priceOverrideReason: 'Available brand' },
      2,
      async () => changed
    )
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(create).not.toHaveBeenCalled();
});
it('checks stock before adding the line so the final units can be sold', async () => {
  const add = vi.fn(async () => {
    expect(findSubstituteProposals).toHaveBeenCalled();
    return { ...result, line: { ...result.line, unitPriceMinor: 50 } };
  });
  await authorizeSubstituteSale(db, scope, substitution, 2, add);
  expect(add).toHaveBeenCalledOnce();
});
