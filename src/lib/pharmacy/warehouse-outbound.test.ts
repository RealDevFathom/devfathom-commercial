import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { expiryInstant } from './stock-ledger';
import { shelfLabelCode } from './shelf-label-code';
import {
  assertWarehouseScans,
  reservationArrangement,
  warehouseLotEligible,
} from './warehouse-outbound';

const at = new Date('2027-01-01T00:00:00Z');
const scope = { organizationId: 'org', branchId: 'hub', actorId: 'picker' };
const expiry = expiryInstant(new Date('2027-06-30T00:00:00Z'), 'DAY');
const lot = {
  id: 'lot',
  packLevelId: 'pack',
  manufacturingBatchId: 'batch',
  shelfLabelNumber: 19,
  packLevel: { presentationId: 'tablet500' },
  receivedAt: at,
  batch: {
    state: 'ACTIVE' as const,
    batchNumber: 'A-7',
    expiresAt: expiry,
    medicineId: 'm500',
    medicine: { productFamily: 'PHARMACEUTICAL' as const, controlled: false },
  },
};
function scansDb(matches: number) {
  return {
    medicineBarcode: { findFirst: vi.fn().mockResolvedValue({ id: 'barcode' }) },
    pharmacyInventoryLot: { count: vi.fn().mockResolvedValue(matches) },
  } as unknown as ScopedDb;
}

describe('warehouse stock and scans', () => {
  it('honours the shipping shelf life and rejects pharmaceutical lots with missing identity', () => {
    expect(warehouseLotEligible(lot, 30, at)).toBe(true);
    expect(warehouseLotEligible(lot, 210, at)).toBe(false);
    expect(
      warehouseLotEligible({ ...lot, batch: { ...lot.batch, batchNumber: null } }, 0, at)
    ).toBe(false);
    expect(warehouseLotEligible({ ...lot, batch: { ...lot.batch, expiresAt: null } }, 0, at)).toBe(
      false
    );
    expect(
      warehouseLotEligible({ ...lot, batch: { ...lot.batch, state: 'RECALLED' } }, 0, at)
    ).toBe(false);
    expect(
      warehouseLotEligible(
        { ...lot, batch: { ...lot.batch, medicine: { ...lot.batch.medicine, controlled: true } } },
        0,
        at
      )
    ).toBe(false);
  });
  it('preserves loose units, even when their total exceeds a pack', () => {
    expect(reservationArrangement(23, 10, 0)).toEqual({ sealedPacks: 0, looseUnits: 23 });
    expect(reservationArrangement(23, 10, 1)).toEqual({ sealedPacks: 1, looseUnits: 13 });
    expect(reservationArrangement(23, 10, 3)).toEqual({ sealedPacks: 2, looseUnits: 3 });
  });
  it('verifies lot labels and refuses a supplier batch that identifies two stock lots in the bin', async () => {
    await expect(
      assertWarehouseScans(scansDb(2), scope, lot, 'pick', 'm500', shelfLabelCode(19))
    ).resolves.toBeUndefined();
    await expect(
      assertWarehouseScans(scansDb(2), scope, lot, 'pick', 'm500', 'A-7')
    ).rejects.toMatchObject({ reason: 'LABEL_LOT_MISMATCH' });
    await expect(
      assertWarehouseScans(scansDb(1), scope, lot, 'pick', 'm500', 'A-7')
    ).resolves.toBeUndefined();
  });
  it('matches the GS1 embedded lot and expiry as well as pack presentation', async () => {
    const db = scansDb(1);
    const code = '(01)09506000134352(17)270630(10)A-7';
    await expect(
      assertWarehouseScans(db, scope, lot, 'pick', code, 'lot')
    ).resolves.toBeUndefined();
    expect(db.medicineBarcode.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          presentationId: 'tablet500',
          OR: [{ packLevelId: 'pack' }, { packLevelId: null }],
        }),
      })
    );
    await expect(
      assertWarehouseScans(db, scope, lot, 'pick', code.replace('A-7', 'A-8'), 'lot')
    ).rejects.toMatchObject({ reason: 'LABEL_LOT_MISMATCH' });
    await expect(
      assertWarehouseScans(db, scope, lot, 'pick', code.replace('270630', '270529'), 'lot')
    ).rejects.toMatchObject({ reason: 'LABEL_LOT_MISMATCH' });
  });
});
