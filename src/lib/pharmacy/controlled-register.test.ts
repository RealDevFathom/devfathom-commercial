import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { appendControlledCorrection, registerBalanceAfter } from './controlled-register';

describe('registerBalanceAfter', () => {
  it('adds a purchase-style correction and refuses a negative balance', () => {
    expect(registerBalanceAfter(10, -4)).toBe(6);
    expect(registerBalanceAfter(10, 0)).toBe(10);
    expect(registerBalanceAfter(3, -4)).toBeNull();
    expect(registerBalanceAfter(1.5, 1)).toBeNull();
  });
});

describe('appendControlledCorrection', () => {
  it('appends a correction and leaves the original row untouched', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'new' });
    const original = {
      id: 'entry_1',
      prescriptionId: 'rx',
      prescriptionLineId: 'line',
      patientId: 'patient',
      prescriberId: 'prescriber',
      prescriberName: 'Dr Khan',
      prescriberRegNo: 'R-1',
      patientAddress: '12 Mall Road',
      medicineId: 'med',
      manufacturer: 'Maker',
      inventoryLotId: 'lot',
      batchNumber: 'B-1',
      runningBalance: 8,
      rxSerialWritten: true,
      emergency: false,
      counterpartyName: null,
      refEntryId: null,
    };
    const db = {
      pharmacyControlledRegisterEntry: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(original)
          .mockResolvedValueOnce({ ...original, serial: 4, runningBalance: 8 }),
        aggregate: vi.fn().mockResolvedValue({ _max: { serial: 4 } }),
        create,
        update: vi.fn(),
        delete: vi.fn(),
      },
    } as unknown as ScopedDb;

    await expect(
      appendControlledCorrection(db, {
        organizationId: 'org',
        branchId: 'branch',
        correctsEntryId: 'entry_1',
        correctionReason: 'Quantity was one pack, not two.',
        quantityCanonicalUnits: 1,
        balanceDelta: 1,
        recordedByUserId: 'cashier',
        witnessedByUserId: 'pharmacist',
        signatureRef: 'pin:pharmacist',
      })
    ).resolves.toEqual({ serial: 5, runningBalance: 9 });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entryKind: 'CORRECTION',
        serial: 5,
        stockMovementId: null,
        correctsEntryId: 'entry_1',
        runningBalance: 9,
        balanceDelta: 1,
        correctionReason: 'Quantity was one pack, not two.',
        patientAddress: '12 Mall Road',
        manufacturer: 'Maker',
      }),
    });
    expect(db.pharmacyControlledRegisterEntry.update).not.toHaveBeenCalled();
    expect(db.pharmacyControlledRegisterEntry.delete).not.toHaveBeenCalled();
  });
});
