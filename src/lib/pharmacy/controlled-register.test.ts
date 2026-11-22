import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  appendControlledCorrection,
  appendControlledPurchaseEntries,
  appendControlledPurchaseReversals,
  appendControlledSaleEntries,
  appendControlledSupplierReturn,
  DEFAULT_EMERGENCY_SUPPLY_POLICY,
  derivedCorrectionDelta,
  emergencyNoRxDecision,
  registerBalanceAfter,
  resolveEmergencySupplyPolicy,
} from './controlled-register';

describe('controlled supplier return refusals', () => {
  const message =
    'The register could not confirm this supplier return. Check the original dispatch and register before trying again.';
  it.each([
    ['PostgreSQL', { code: '23514' }],
    ['Prisma adapter', { meta: { driverAdapterError: { cause: { originalCode: '23514' } } } }],
    [
      'Prisma database error',
      new Error('Database error. Code: `23514`. Message: `check constraint failed`'),
    ],
  ])('translates a %s check violation into a plain refusal', async (_source, failure) => {
    const { db, create } = correctionDb({ sellable: 8 });
    db.$queryRaw = vi.fn().mockResolvedValue([{ id: 'purchase', medicineId: 'medicine' }]);
    create.mockRejectedValueOnce(failure);
    await expect(
      appendControlledSupplierReturn(
        db,
        { organizationId: 'org', branchId: 'branch', actorId: 'sender' },
        {
          supplierId: 'supplier',
          supplierName: 'Supplier',
          lineId: 'line',
          inventoryLotId: 'lot',
          movementId: 'movement',
          quantity: 1,
          witness: { witnessedByUserId: 'witness', signatureRef: 'pin:fixture' },
        }
      )
    ).rejects.toMatchObject({ reason: 'REGISTER_REFUSED', message });
  });
});

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
    const policy = resolveEmergencySupplyPolicy(null);
    expect(
      emergencyNoRxDecision({ units: 10, recentSupplies: 0, openFollowUp: false, policy })
    ).toBeNull();
    expect(
      emergencyNoRxDecision({ units: 11, recentSupplies: 0, openFollowUp: false, policy })
    ).toMatch(/limited to 10/);
    expect(
      emergencyNoRxDecision({ units: 1, recentSupplies: 1, openFollowUp: false, policy })
    ).toMatch(/missing prescription/);
    expect(
      emergencyNoRxDecision({ units: 1, recentSupplies: 0, openFollowUp: true, policy })
    ).toMatch(/missing prescription/);
  });
});

describe('resolveEmergencySupplyPolicy', () => {
  it.each([
    { id: 'pk_pb_v2', maxUnits: 4, repeatWindowHours: 24 },
    { id: 'pk_sd_v2', maxUnits: 20, repeatWindowHours: 48 },
  ])('uses the configured cap and repeat window for $id', ({ id, ...configured }) => {
    const policy = resolveEmergencySupplyPolicy({
      id,
      controlledRegisterFlags: { values: { emergencySupply: configured } },
    });
    expect(policy).toEqual({
      ...configured,
      source: 'JURISDICTION_RULE_SET',
      ruleSetId: id,
      repeatWindowMs: configured.repeatWindowHours * 60 * 60 * 1000,
    });
    expect(
      emergencyNoRxDecision({
        units: configured.maxUnits,
        recentSupplies: 0,
        openFollowUp: false,
        policy,
      })
    ).toBeNull();
    expect(
      emergencyNoRxDecision({
        units: configured.maxUnits + 1,
        recentSupplies: 0,
        openFollowUp: false,
        policy,
      })
    ).toContain(`limited to ${configured.maxUnits} units`);
    expect(
      emergencyNoRxDecision({ units: 1, recentSupplies: 1, openFollowUp: false, policy })
    ).toMatch(/missing prescription/);
    expect(
      emergencyNoRxDecision({ units: 1, recentSupplies: 0, openFollowUp: true, policy })
    ).toMatch(/missing prescription/);
  });

  it.each([
    undefined,
    null,
    { maxUnits: [], repeatWindowHours: 72 },
    {},
    { maxUnits: 0, repeatWindowHours: 72 },
    { maxUnits: -1, repeatWindowHours: 72 },
    { maxUnits: 1.5, repeatWindowHours: 72 },
    { maxUnits: Number.MAX_SAFE_INTEGER + 1, repeatWindowHours: 72 },
    { maxUnits: '20', repeatWindowHours: 72 },
    { maxUnits: 20, repeatWindowHours: 0 },
    { maxUnits: 20, repeatWindowHours: -1 },
    { maxUnits: 20, repeatWindowHours: 1.5 },
    { maxUnits: 20, repeatWindowHours: Infinity },
    { maxUnits: 20, repeatWindowHours: 2_400_000_001 },
    { maxUnits: 20, repeatWindowHours: 72, source: 'UNKNOWN' },
  ])('falls back safely for malformed or absent policy %j', (emergencySupply) => {
    const policy = resolveEmergencySupplyPolicy({
      id: 'legacy',
      controlledRegisterFlags: { values: { emergencySupply } },
    });
    expect(policy).toEqual({
      ...DEFAULT_EMERGENCY_SUPPLY_POLICY,
      ruleSetId: 'legacy',
      repeatWindowMs: 72 * 60 * 60 * 1000,
    });
    expect(
      emergencyNoRxDecision({ units: 11, recentSupplies: 0, openFollowUp: false, policy })
    ).toMatch(/limited to 10/);
  });

  it.each([null, {}, { values: [] }, { values: null }])(
    'falls back safely for malformed rule fields %j',
    (controlledRegisterFlags) => {
      expect(resolveEmergencySupplyPolicy({ id: 'legacy', controlledRegisterFlags })).toEqual({
        ...DEFAULT_EMERGENCY_SUPPLY_POLICY,
        ruleSetId: 'legacy',
        repeatWindowMs: 72 * 60 * 60 * 1000,
      });
    }
  );

  it('identifies defaults explicitly, including backfilled and placeholder policies', () => {
    expect(resolveEmergencySupplyPolicy(null)).toEqual({
      ...DEFAULT_EMERGENCY_SUPPLY_POLICY,
      ruleSetId: null,
      repeatWindowMs: 72 * 60 * 60 * 1000,
    });
    expect(
      resolveEmergencySupplyPolicy({
        id: 'placeholder',
        controlledRegisterFlags: {
          values: { recordEverySale: true, emergencySupply: DEFAULT_EMERGENCY_SUPPLY_POLICY },
          provisional: false,
        },
      }).source
    ).toBe('DEFAULT_POLICY');
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
        return { _sum: { quantityCanonicalUnits: null }, _max: { serial: 4 } };
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

describe('appendControlledPurchaseReversals', () => {
  it('appends a movement-backed zero-quantity correction with a fresh witness', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'correction' });
    const purchase = {
      ...original,
      entryKind: 'PURCHASE' as const,
      quantityCanonicalUnits: 2,
      witnessedByUserId: 'pharmacist',
      signatureRef: 'pin:pharmacist',
      stockMovementId: 'receipt-movement',
    };
    const db = {
      $queryRaw: vi.fn(),
      pharmacyControlledRegisterEntry: {
        findMany: vi.fn().mockResolvedValue([purchase]),
        findFirst: vi.fn().mockResolvedValue({ runningBalance: 2 }),
        aggregate: vi
          .fn()
          .mockResolvedValue({ _sum: { quantityCanonicalUnits: null }, _max: { serial: 1 } }),
        create,
      },
      pharmacyStockBalance: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { onHandUnits: 0 } }),
      },
      pharmacyStockMovement: {
        findFirst: vi.fn().mockResolvedValue({ id: 'reversal-movement', quantityUnits: -2 }),
      },
    } as unknown as ScopedDb;

    await appendControlledPurchaseReversals(db, {
      organizationId: 'org',
      branchId: 'branch',
      recordedByUserId: 'receiver',
      reason: 'Supplier sent the wrong consignment.',
      reversedMovementIds: Object.freeze(['receipt-movement']),
      witness: { witnessedByUserId: 'fresh-witness', signatureRef: 'pin:fresh-verification' },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entryKind: 'CORRECTION',
        correctsEntryId: 'entry_1',
        quantityCanonicalUnits: 0,
        balanceDelta: -2,
        runningBalance: 0,
        restorationMovementId: 'reversal-movement',
        recordedByUserId: 'receiver',
        witnessedByUserId: 'fresh-witness',
        signatureRef: 'pin:fresh-verification',
        correctionReason: 'Supplier sent the wrong consignment.',
      }),
    });
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
          return { _sum: { quantityCanonicalUnits: null }, _max: { serial: 3 } };
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
        aggregate: vi
          .fn()
          .mockResolvedValue({ _sum: { quantityCanonicalUnits: null }, _max: { serial: 1 } }),
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
});

describe('appendControlledPurchaseEntries', () => {
  it('stores the accepted units as the balance delta', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'purchase-row' });
    const db = {
      $queryRaw: vi.fn(),
      pharmacyControlledRegisterEntry: {
        aggregate: vi
          .fn()
          .mockResolvedValue({ _sum: { quantityCanonicalUnits: null }, _max: { serial: 0 } }),
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
