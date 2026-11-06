import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { revalidatePackLineEvidence } from './pack-line-evidence';

const input = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  scanId: 'scan-a',
  medicineId: 'medicine-a',
  presentationId: 'presentation-a',
  packLevelId: 'pack-a',
};
function fixture() {
  return {
    pharmacyPackAuthenticationScan: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ gtin: '08901234567890', batchNumber: 'LOT-7', expiresOn: '251231' }),
    },
    medicineBarcode: {
      findFirst: vi
        .fn()
        .mockResolvedValue({
          packLevelId: 'pack-a',
          presentation: { id: 'presentation-a', organizationId: 'org-a', medicineId: 'medicine-a' },
        }),
    },
    pharmacyManufacturingBatch: {
      findFirst: vi
        .fn()
        .mockResolvedValue({
          id: 'batch-a',
          expiresAt: new Date('2025-12-31T00:00:00Z'),
          state: 'ACTIVE',
        }),
    },
    pharmacyInventoryLot: { findFirst: vi.fn().mockResolvedValue({ id: 'lot-a' }) },
  };
}
describe('revalidate scan against line', () => {
  it('uses only a dispensing scan from the requested tenant and branch', async () => {
    const db = fixture();
    expect(await revalidatePackLineEvidence(db as never, input)).toEqual({ status: 'VERIFIED' });
    expect(db.pharmacyPackAuthenticationScan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'scan-a',
          organizationId: 'org-a',
          branchId: 'branch-a',
          source: 'DISPENSING',
        },
      })
    );
    expect(db.pharmacyInventoryLot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          branchId: 'branch-a',
          receivedAt: { not: null },
        }),
      })
    );
  });
  it('refuses a scan not visible in that scope', async () => {
    const db = fixture();
    db.pharmacyPackAuthenticationScan.findFirst.mockResolvedValue(null);
    await expect(revalidatePackLineEvidence(db as never, input)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(db.medicineBarcode.findFirst).not.toHaveBeenCalled();
  });
  it('never infers a mismatch from absent branch receipt or unknown batch', async () => {
    const db = fixture();
    db.pharmacyInventoryLot.findFirst.mockResolvedValue(null);
    expect(
      await revalidatePackLineEvidence(db as never, { ...input, medicineId: 'different' })
    ).toEqual({ status: 'UNVERIFIED' });
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue(null);
    expect(await revalidatePackLineEvidence(db as never, input)).toEqual({ status: 'UNVERIFIED' });
  });
  it('flags a received pack with different expiry or selected line', async () => {
    const db = fixture();
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({
      id: 'batch-a',
      expiresAt: new Date('2026-12-31T00:00:00Z'),
      state: 'ACTIVE',
    });
    expect(await revalidatePackLineEvidence(db as never, input)).toEqual({ status: 'MISMATCH' });
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({
      id: 'batch-a',
      expiresAt: new Date('2025-12-31T00:00:00Z'),
      state: 'ACTIVE',
    });
    expect(
      await revalidatePackLineEvidence(db as never, { ...input, packLevelId: 'other' })
    ).toEqual({ status: 'MISMATCH' });
  });
  it('normalizes GS1 day 00 and blocks a known recall even without receipt', async () => {
    const db = fixture();
    db.pharmacyPackAuthenticationScan.findFirst.mockResolvedValue({
      gtin: '08901234567890',
      batchNumber: 'LOT-7',
      expiresOn: '251200',
    });
    expect(await revalidatePackLineEvidence(db as never, input)).toEqual({ status: 'VERIFIED' });
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({
      id: 'batch-a',
      expiresAt: new Date('2025-12-31T00:00:00Z'),
      state: 'RECALLED',
    });
    expect(await revalidatePackLineEvidence(db as never, input)).toEqual({
      status: 'BLOCKED_RECALL',
    });
  });
  it('withholds malformed and field-injected legacy evidence', async () => {
    const db = fixture();
    db.pharmacyPackAuthenticationScan.findFirst.mockResolvedValue({
      gtin: '08901234567890',
      batchNumber: 'LOT-7(17)251231',
      expiresOn: '251231',
    });
    expect(await revalidatePackLineEvidence(db as never, input)).toEqual({ status: 'UNVERIFIED' });
    expect(db.medicineBarcode.findFirst).not.toHaveBeenCalled();
  });
});
