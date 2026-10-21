import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  appendControlledCorrection,
  appendControlledPurchaseEntries,
  appendControlledSaleEntries,
  derivedCorrectionDelta,
  emergencyNoRxDecision,
  registerBalanceAfter,
} from './controlled-register';

describe('registerBalanceAfter', () => {
  it('adds a signed delta and refuses a negative balance', () => {
    expect(registerBalanceAfter(10, -4)).toBe(6);
    expect(registerBalanceAfter(10, 0)).toBe(10);
    expect(registerBalanceAfter(3, -4)).toBeNull();
    expect(registerBalanceAfter(1.5, 1)).toBeNull();
  });
});

describe('derivedCorrectionDelta', () => {
  it('derives the sale and purchase deltas and caps them at the original quantity', () => {
    expect(derivedCorrectionDelta('SALE', 2, 1)).toBe(1);
    expect(derivedCorrectionDelta('PURCHASE', 10, 8)).toBe(-2);
    expect(derivedCorrectionDelta('SALE', 2, 5)).toBeNull();
    expect(derivedCorrectionDelta('PURCHASE', 4, 9)).toBeNull();
    expect(derivedCorrectionDelta('CORRECTION', 4, 3)).toBeNull();
    expect(derivedCorrectionDelta('SALE', 4, 0)).toBeNull();
  });
});

describe('emergencyNoRxDecision', () => {
  it('caps quantity and refuses a repeat while a follow-up is open', () => {
    expect(emergencyNoRxDecision({ units: 10, recentSupplies: 0, openFollowUp: false })).toBeNull();
    expect(emergencyNoRxDecision({ units: 11, recentSupplies: 0, openFollowUp: false })).toMatch(
      /limited to 10/
    );
    expect(emergencyNoRxDecision({ units: 1, recentSupplies: 1, openFollowUp: false })).toMatch(
      /missing prescription/
    );
    expect(emergencyNoRxDecision({ units: 1, recentSupplies: 0, openFollowUp: true })).toMatch(
      /missing prescription/
    );
  });
});

const original = {
  id: 'entry_1',
  entryKind: 'SALE' as const,
  quantityCanonicalUnits: 2,
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

function correctionDb(options: {
  existing?: { id: string } | null;
  sellable?: number;
  adjustment?: { id: string } | null;
  entryKind?: 'SALE' | 'PURCHASE' | 'CORRECTION';
}) {
  const calls: string[] = [];
  const create = vi.fn().mockResolvedValue({ id: 'new' });
  const incident = vi.fn().mockResolvedValue({ id: 'incident' });
  const db = {
    $queryRaw: vi.fn(async () => {
      calls.push('lock');
    }),
    pharmacyControlledRegisterEntry: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        calls.push('read');
        if (where.id === 'entry_1') return { ...original, entryKind: options.entryKind ?? 'SALE' };
        if (where.correctsEntryId) return options.existing ?? null;
        if (where.inventoryLotId) return { runningBalance: 8 };
        return null;
      }),
      aggregate: vi.fn(async () => {
        calls.push('serial');
        return { _max: { serial: 4 } };
      }),
      create,
      update: vi.fn(),
      delete: vi.fn(),
    },
    pharmacyStockBalance: {
      aggregate: vi.fn(async () => ({ _sum: { onHandUnits: options.sellable ?? 9 } })),
    },
    pharmacyStockMovement: {
      findFirst: vi.fn(async () => options.adjustment ?? null),
    },
    pharmacyRegisterIncident: { create: incident },
  } as unknown as ScopedDb;
  return { db, create, incident, calls };
}

describe('appendControlledCorrection', () => {
  it('appends a server-derived correction and leaves the original row untouched', async () => {
    const { db, create, incident } = correctionDb({ sellable: 9 });
    await expect(
      appendControlledCorrection(db, {
        organizationId: 'org',
        branchId: 'branch',
        correctsEntryId: 'entry_1',
        correctionReason: 'Quantity was one pack, not two.',
        quantityCanonicalUnits: 1,
        recordedByUserId: 'cashier',
        witnessedByUserId: 'pharmacist',
        signatureRef: 'pin:pharmacist',
      })
    ).resolves.toEqual({ serial: 5, runningBalance: 9, incidentOpened: false });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entryKind: 'CORRECTION',
        serial: 5,
        stockMovementId: null,
        correctsEntryId: 'entry_1',
        runningBalance: 9,
        balanceDelta: 1,
        quantityCanonicalUnits: 1,
        correctionReason: 'Quantity was one pack, not two.',
        patientAddress: '12 Mall Road',
        manufacturer: 'Maker',
      }),
    });
    expect(incident).not.toHaveBeenCalled();
    expect(db.pharmacyControlledRegisterEntry.update).not.toHaveBeenCalled();
    expect(db.pharmacyControlledRegisterEntry.delete).not.toHaveBeenCalled();
  });

  it('takes the branch lock before reading the original row', async () => {
    const { db, calls } = correctionDb({});
    await appendControlledCorrection(db, {
      organizationId: 'org',
      branchId: 'branch',
      correctsEntryId: 'entry_1',
      correctionReason: 'Counted again.',
      quantityCanonicalUnits: 1,
      recordedByUserId: 'cashier',
      witnessedByUserId: 'pharmacist',
      signatureRef: 'pin:pharmacist',
    });
    expect(calls[0]).toBe('lock');
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('read'));
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('serial'));
  });

  it('refuses a correction whose balance does not match sellable stock', async () => {
    const { db, create, incident } = correctionDb({ sellable: 8 });
    await expect(
      appendControlledCorrection(db, {
        organizationId: 'org',
        branchId: 'branch',
        correctsEntryId: 'entry_1',
        correctionReason: 'Shelf was short.',
        quantityCanonicalUnits: 1,
        recordedByUserId: 'cashier',
        witnessedByUserId: 'pharmacist',
        signatureRef: 'pin:pharmacist',
      })
    ).rejects.toThrow('STOCK');
    expect(create).not.toHaveBeenCalled();
    expect(incident).not.toHaveBeenCalled();
  });

  it('refuses a second correction and a correction of a correction', async () => {
    const twice = correctionDb({ existing: { id: 'already' } });
    await expect(
      appendControlledCorrection(twice.db, {
        organizationId: 'org',
        branchId: 'branch',
        correctsEntryId: 'entry_1',
        correctionReason: 'Again.',
        quantityCanonicalUnits: 1,
        recordedByUserId: 'cashier',
        witnessedByUserId: 'pharmacist',
        signatureRef: 'pin:pharmacist',
      })
    ).rejects.toThrow('ALREADY_CORRECTED');
    expect(twice.create).not.toHaveBeenCalled();

    const nested = correctionDb({ entryKind: 'CORRECTION' });
    await expect(
      appendControlledCorrection(nested.db, {
        organizationId: 'org',
        branchId: 'branch',
        correctsEntryId: 'entry_1',
        correctionReason: 'Nested.',
        quantityCanonicalUnits: 1,
        recordedByUserId: 'cashier',
        witnessedByUserId: 'pharmacist',
        signatureRef: 'pin:pharmacist',
      })
    ).rejects.toThrow('ALREADY_CORRECTED');
  });

  it('refuses a delta larger than the original quantity', async () => {
    const { db, create } = correctionDb({});
    await expect(
      appendControlledCorrection(db, {
        organizationId: 'org',
        branchId: 'branch',
        correctsEntryId: 'entry_1',
        correctionReason: 'Too large.',
        quantityCanonicalUnits: 5,
        recordedByUserId: 'cashier',
        witnessedByUserId: 'pharmacist',
        signatureRef: 'pin:pharmacist',
      })
    ).rejects.toThrow('CAP');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('appendControlledSaleEntries', () => {
  it('locks, stores the real negative delta, and ignores quarantine stock', async () => {
    const calls: string[] = [];
    const create = vi.fn().mockResolvedValue({ id: 'sale-row' });
    const balance = vi.fn(async ({ where }: { where: { disposition?: unknown } }) => {
      calls.push('balance');
      expect(where.disposition).toEqual({ not: 'QUARANTINE' });
      return { _sum: { onHandUnits: 6 } };
    });
    const db = {
      $queryRaw: vi.fn(async () => {
        calls.push('lock');
      }),
      pharmacyControlledRegisterEntry: {
        aggregate: vi.fn(async () => {
          calls.push('serial');
          return { _max: { serial: 3 } };
        }),
        findFirst: vi.fn(async () => null),
        create,
      },
      pharmacyStockMovement: {
        findFirstOrThrow: vi.fn(async () => ({
          id: 'mov',
          inventoryLotId: 'lot',
          quantityUnits: -4,
        })),
      },
      pharmacyInventoryLot: {
        findFirstOrThrow: vi.fn(async () => ({
          id: 'lot',
          batch: { batchNumber: 'B-9' },
        })),
      },
      pharmacyStockBalance: { aggregate: balance },
    } as unknown as ScopedDb;

    await appendControlledSaleEntries(db, {
      organizationId: 'org',
      branchId: 'branch',
      movementIds: ['mov'],
      patientId: 'patient',
      patientAddress: '12 Mall Road',
      medicineId: 'med',
      manufacturer: 'Maker',
      prescriberId: null,
      prescriberName: 'Dr Khan',
      prescriberRegNo: null,
      prescriptionId: null,
      prescriptionLineId: null,
      emergency: true,
      rxSerialWritten: false,
      refEntryId: null,
      recordedByUserId: 'cashier',
      witnessedByUserId: 'pharmacist',
      signatureRef: 'pin:pharmacist',
    });

    expect(calls[0]).toBe('lock');
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('serial'));
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entryKind: 'SALE',
        serial: 4,
        quantityCanonicalUnits: 4,
        balanceDelta: -4,
        runningBalance: 6,
        batchNumber: 'B-9',
      }),
    });
  });

  it('continues the running balance from the previous row of the same medicine and lot', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'sale-row' });
    const db = {
      $queryRaw: vi.fn(),
      pharmacyControlledRegisterEntry: {
        aggregate: vi.fn().mockResolvedValue({ _max: { serial: 1 } }),
        findFirst: vi.fn(async ({ where }: { where: { medicineId?: string } }) => {
          expect(where.medicineId).toBe('med');
          return { runningBalance: 10 };
        }),
        create,
      },
      pharmacyStockMovement: {
        findFirstOrThrow: vi.fn(async () => ({
          id: 'mov',
          inventoryLotId: 'lot',
          quantityUnits: -4,
        })),
      },
      pharmacyInventoryLot: {
        findFirstOrThrow: vi.fn(async () => ({ id: 'lot', batch: { batchNumber: 'B' } })),
      },
      pharmacyStockBalance: { aggregate: vi.fn() },
    } as unknown as ScopedDb;

    await appendControlledSaleEntries(db, {
      organizationId: 'org',
      branchId: 'branch',
      movementIds: ['mov'],
      patientId: 'patient',
      patientAddress: '12 Mall Road',
      medicineId: 'med',
      manufacturer: null,
      prescriberId: 'prescriber',
      prescriberName: 'Dr Khan',
      prescriberRegNo: 'R-1',
      prescriptionId: 'rx',
      prescriptionLineId: 'line',
      emergency: false,
      rxSerialWritten: true,
      refEntryId: null,
      recordedByUserId: 'cashier',
      witnessedByUserId: 'pharmacist',
      signatureRef: 'pin:pharmacist',
    });

    expect(db.pharmacyStockBalance.aggregate).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ balanceDelta: -4, runningBalance: 6 }),
    });
  });

  it('refuses a confirmed Sindh sale with no complete address before writing any row', async () => {
    const lock = vi.fn();
    const db = { $queryRaw: lock } as unknown as ScopedDb;
    await expect(
      appendControlledSaleEntries(db, {
        organizationId: 'org',
        branchId: 'branch',
        movementIds: ['mov'],
        patientId: 'patient',
        patientAddress: '   ',
        medicineId: 'med',
        manufacturer: null,
        prescriberId: 'prescriber',
        prescriberName: 'Dr Khan',
        prescriberRegNo: 'R-1',
        prescriptionId: 'rx',
        prescriptionLineId: 'line',
        emergency: false,
        rxSerialWritten: true,
        refEntryId: null,
        recordedByUserId: 'cashier',
        witnessedByUserId: 'pharmacist',
        signatureRef: 'pin:pharmacist',
        province: { provinceCode: 'PK-SD', pendingLegalReview: false },
      })
    ).rejects.toThrow(/complete address/);
    // It fails before taking the register lock.
    expect(lock).not.toHaveBeenCalled();
  });

  it('allows a Sindh sale whose rules are still pending legal review', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'sale-row' });
    const db = {
      $queryRaw: vi.fn(),
      pharmacyControlledRegisterEntry: {
        aggregate: vi.fn().mockResolvedValue({ _max: { serial: 1 } }),
        findFirst: vi.fn().mockResolvedValue({ runningBalance: 10 }),
        create,
      },
      pharmacyStockMovement: {
        findFirstOrThrow: vi.fn(async () => ({ id: 'mov', inventoryLotId: 'lot', quantityUnits: -4 })),
      },
      pharmacyInventoryLot: {
        findFirstOrThrow: vi.fn(async () => ({ id: 'lot', batch: { batchNumber: 'B' } })),
      },
      pharmacyStockBalance: { aggregate: vi.fn() },
    } as unknown as ScopedDb;

    await appendControlledSaleEntries(db, {
      organizationId: 'org',
      branchId: 'branch',
      movementIds: ['mov'],
      patientId: 'patient',
      patientAddress: '',
      medicineId: 'med',
      manufacturer: null,
      prescriberId: 'prescriber',
      prescriberName: 'Dr Khan',
      prescriberRegNo: 'R-1',
      prescriptionId: 'rx',
      prescriptionLineId: 'line',
      emergency: false,
      rxSerialWritten: true,
      refEntryId: null,
      recordedByUserId: 'cashier',
      witnessedByUserId: 'pharmacist',
      signatureRef: 'pin:pharmacist',
      province: { provinceCode: 'PK-SD', pendingLegalReview: true },
    });
    expect(create).toHaveBeenCalled();
  });
});

describe('appendControlledPurchaseEntries', () => {
  it('stores the accepted units as the balance delta', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'purchase-row' });
    const db = {
      $queryRaw: vi.fn(),
      pharmacyControlledRegisterEntry: {
        aggregate: vi.fn().mockResolvedValue({ _max: { serial: 0 } }),
        findFirst: vi.fn(async () => ({ runningBalance: 3 })),
        create,
      },
      pharmacyStockBalance: { aggregate: vi.fn() },
    } as unknown as ScopedDb;

    await appendControlledPurchaseEntries(db, {
      organizationId: 'org',
      branchId: 'branch',
      recordedByUserId: 'receiver',
      witnessedByUserId: 'pharmacist',
      signatureRef: 'pin:pharmacist',
      lines: [
        {
          medicineId: 'med',
          manufacturer: 'Maker',
          inventoryLotId: 'lot',
          stockMovementId: 'mov',
          batchNumber: 'B-1',
          quantityCanonicalUnits: 5,
          counterpartyName: 'Karachi Distributors',
        },
      ],
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entryKind: 'PURCHASE',
        quantityCanonicalUnits: 5,
        balanceDelta: 5,
        runningBalance: 8,
        signatureRef: 'pin:pharmacist',
        witnessedByUserId: 'pharmacist',
      }),
    });
  });
});
