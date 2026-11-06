import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { authenticatePharmacyPack } from './pack-authentication-operations';

function fixture(options: { received?: boolean; recalled?: boolean } = {}) {
  const db = {
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }) },
    medicineBarcode: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ packLevelId: 'pack-a', presentation: { medicineId: 'medicine-a' } }),
    },
    pharmacyManufacturingBatch: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'batch-a',
        batchNumber: 'LOT-7',
        expiresAt: new Date('2025-12-31T00:00:00Z'),
        state: options.recalled ? 'RECALLED' : 'ACTIVE',
      }),
    },
    pharmacyPackAuthenticationScan: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'scan-a' }),
    },
    pharmacyInventoryLot: {
      findFirst: vi.fn().mockResolvedValue(options.received ? { id: 'lot-a' } : null),
    },
  };
  return db;
}

const input = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  actorId: 'user-a',
  source: 'DISPENSING' as const,
  payload: '(01)08901234567890(17)251231(10)LOT-7(21)SERIAL-9',
};

describe('pack authentication branch evidence', () => {
  it('keeps an organization batch unverified when the branch has no receipt', async () => {
    const db = fixture();
    const result = await authenticatePharmacyPack(db as never, input);
    expect(result).toMatchObject({ status: 'NOT_VERIFIABLE', advisory: true });
    expect(db.pharmacyInventoryLot.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        branchId: 'branch-a',
        manufacturingBatchId: 'batch-a',
        packLevelId: 'pack-a',
        receivedAt: { not: null },
      },
      select: { id: true },
    });
    expect(db.pharmacyPackAuthenticationScan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org-a',
          branchId: 'branch-a',
          status: 'NOT_VERIFIABLE',
        }),
      })
    );
  });

  it('reports a match only when the current branch has a received lot', async () => {
    const db = fixture({ received: true });
    await expect(authenticatePharmacyPack(db as never, input)).resolves.toMatchObject({
      status: 'VERIFIED',
    });
  });

  it('does not infer a pack match when the barcode lacks a pack level', async () => {
    const db = fixture({ received: true });
    db.medicineBarcode.findFirst.mockResolvedValue({
      packLevelId: null,
      presentation: { medicineId: 'medicine-a' },
    });
    await expect(authenticatePharmacyPack(db as never, input)).resolves.toMatchObject({
      status: 'NOT_VERIFIABLE',
    });
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
  });

  it('keeps an expiry discrepancy unverified when the branch has no receipt', async () => {
    const db = fixture();
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({
      id: 'batch-a',
      batchNumber: 'LOT-7',
      expiresAt: new Date('2026-12-31T00:00:00Z'),
      state: 'ACTIVE',
    });
    await expect(authenticatePharmacyPack(db as never, input)).resolves.toMatchObject({
      status: 'NOT_VERIFIABLE',
      advisory: true,
      issues: expect.arrayContaining(['NOT_VERIFIABLE', 'EXPIRY_MISMATCH']),
    });
  });

  it('retains the expiry discrepancy when a branch receipt exists', async () => {
    const db = fixture({ received: true });
    db.pharmacyManufacturingBatch.findFirst.mockResolvedValue({
      id: 'batch-a',
      batchNumber: 'LOT-7',
      expiresAt: new Date('2026-12-31T00:00:00Z'),
      state: 'ACTIVE',
    });
    await expect(authenticatePharmacyPack(db as never, input)).resolves.toMatchObject({
      status: 'FLAGGED',
      issues: ['EXPIRY_MISMATCH'],
    });
  });

  it('keeps a known recall blocked even without a branch receipt', async () => {
    const db = fixture({ recalled: true });
    await expect(authenticatePharmacyPack(db as never, input)).resolves.toMatchObject({
      status: 'BLOCKED_RECALL',
      advisory: false,
    });
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
  });

  it('does not require a prior receipt during receiving', async () => {
    const db = fixture();
    await expect(
      authenticatePharmacyPack(db as never, { ...input, source: 'RECEIVING' })
    ).resolves.toMatchObject({ status: 'VERIFIED' });
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
  });

  it('refuses an inactive or outside-tenant branch before reading pack evidence', async () => {
    const db = fixture();
    db.pharmacyBranch.findFirst.mockResolvedValue(null);
    await expect(authenticatePharmacyPack(db as never, input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.medicineBarcode.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyPackAuthenticationScan.create).not.toHaveBeenCalled();
  });
});
