import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { appendControlledPurchaseReversals } from './controlled-register';

const scope = { organizationId: 'org', branchId: 'branch' };
const input = {
  ...scope,
  movements: [{ sourceMovementId: 'receipt', reversalMovementId: 'reverse' }],
  recordedByUserId: 'reverser',
  reason: 'Invoice cancelled',
};
const purchase = {
  ...scope,
  id: 'original',
  entryKind: 'PURCHASE',
  serial: 1,
  medicineId: 'med',
  inventoryLotId: 'lot',
  stockMovementId: 'receipt',
  batchNumber: 'B1',
  quantityCanonicalUnits: 10,
  prescriptionId: 'rx',
  prescriptionLineId: 'rx-line',
  patientId: 'patient',
  prescriberId: 'doctor',
  prescriberName: 'Dr Test',
  prescriberRegNo: 'DR1',
  patientAddress: 'Synthetic address',
  manufacturer: 'Maker',
  witnessedByUserId: 'witness',
  signatureRef: 'pin:original-witness',
  rxSerialWritten: true,
  emergency: true,
  counterpartyName: 'Supplier',
  refEntryId: 'ref',
};
const source = {
  ...scope,
  id: 'receipt',
  kind: 'RECEIPT',
  inventoryLotId: 'lot',
  stockLocationId: 'store',
  disposition: 'AVAILABLE',
  quantityUnits: 10,
  sealedPackDelta: 1,
  looseUnitDelta: 0,
};
const reversal = {
  ...source,
  id: 'reverse',
  kind: 'ADJUSTMENT',
  reversesMovementId: 'receipt',
  quantityUnits: -10,
  sealedPackDelta: -1,
};
function fixture(
  options: {
    quarantine?: boolean;
    controlled?: boolean;
    movements?: Record<string, unknown>[];
    original?: Record<string, unknown>;
    existing?: boolean;
    previous?: number;
    sellable?: number;
  } = {}
) {
  const calls: string[] = [];
  const create = vi.fn().mockResolvedValue({ id: 'correction' });
  const db = {
    $queryRaw: vi.fn(async () => {
      calls.push('lock');
    }),
    pharmacyStockMovement: {
      findMany: vi.fn(async () => {
        calls.push('movements');
        return (
          options.movements ??
          [source, reversal].map((row) => ({
            ...row,
            disposition: options.quarantine ? 'QUARANTINE' : row.disposition,
          }))
        );
      }),
    },
    pharmacyControlledRegisterEntry: {
      findMany: vi.fn(async () => {
        calls.push('purchases');
        return [{ ...purchase, ...options.original }];
      }),
      findFirst: vi.fn(async ({ where }: { where: { correctsEntryId?: string } }) =>
        where.correctsEntryId
          ? options.existing
            ? { id: 'already' }
            : null
          : { runningBalance: options.previous ?? (options.quarantine ? 0 : 10) }
      ),
      aggregate: vi.fn().mockResolvedValue({ _max: { serial: 1 } }),
      create,
      update: vi.fn(),
      delete: vi.fn(),
    },
    pharmacyInventoryLot: {
      findMany: vi.fn(async () => {
        calls.push('lots');
        return [
          {
            id: 'lot',
            branchId: 'branch',
            batch: {
              medicineId: 'med',
              batchNumber: 'B1',
              medicine: { controlled: options.controlled ?? true },
            },
          },
        ];
      }),
    },
    pharmacyStockBalance: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { onHandUnits: options.sellable ?? 0 } }),
    },
  };
  return { db: db as unknown as ScopedDb, raw: db, create, calls };
}

describe('controlled goods-in reversal helper (GitHub pharmacy #305)', () => {
  it.each([false, true])(
    'derives the delta from the actual movement; quarantine=%s',
    async (quarantine) => {
      const { db, raw, create, calls } = fixture({ quarantine });
      await appendControlledPurchaseReversals(db, input);
      expect(calls).toEqual(['lock', 'movements', 'purchases', 'lots']);
      expect(raw.pharmacyControlledRegisterEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { serial: 'asc' },
        })
      );
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ...scope,
          entryKind: 'CORRECTION',
          serial: 2,
          stockMovementId: null,
          correctsEntryId: 'original',
          restorationMovementId: 'reverse',
          quantityCanonicalUnits: 10,
          balanceDelta: quarantine ? 0 : -10,
          runningBalance: 0,
          recordedByUserId: 'reverser',
          correctionReason: input.reason,
          ...Object.fromEntries(
            [
              'medicineId',
              'inventoryLotId',
              'batchNumber',
              'prescriptionId',
              'prescriptionLineId',
              'patientId',
              'prescriberId',
              'prescriberName',
              'prescriberRegNo',
              'patientAddress',
              'manufacturer',
              'witnessedByUserId',
              'signatureRef',
              'rxSerialWritten',
              'emergency',
              'counterpartyName',
              'refEntryId',
            ].map((key) => [key, purchase[key as keyof typeof purchase]])
          ),
        }),
      });
      expect(raw.pharmacyControlledRegisterEntry.update).not.toHaveBeenCalled();
      expect(raw.pharmacyControlledRegisterEntry.delete).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['missing source', [reversal]],
    ['missing reversal', [source]],
    ...[
      { kind: 'RETURN' },
      { branchId: 'elsewhere' },
      { inventoryLotId: 'other' },
      { stockLocationId: 'other' },
      { reversesMovementId: 'unrelated' },
      { quantityUnits: 10 },
      { quantityUnits: -9 },
      { quantityUnits: NaN },
      { disposition: 'QUARANTINE' },
      { sealedPackDelta: 0 },
      { looseUnitDelta: 1 },
    ].map((patch) => [JSON.stringify(patch), [source, { ...reversal, ...patch }]]),
  ] as [string, Record<string, unknown>[]][])('fails closed for %s', async (_label, movements) => {
    const { db, create } = fixture({ movements });
    await expect(appendControlledPurchaseReversals(db, input)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    { medicineId: null },
    { medicineId: 'other' },
    { batchNumber: 'other' },
    { inventoryLotId: 'other' },
    { branchId: 'other' },
    { quantityCanonicalUnits: 9 },
  ])('refuses malformed or mismatched source register identity %j', async (original) => {
    const { db, create } = fixture({ original });
    await expect(appendControlledPurchaseReversals(db, input)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses repeated correction rather than silently skipping it', async () => {
    const { db, create } = fixture({ existing: true });
    await expect(appendControlledPurchaseReversals(db, input)).rejects.toThrow('ALREADY_CORRECTED');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [{ sourceMovementId: 'receipt', reversalMovementId: '' }],
    [input.movements[0]!, input.movements[0]!],
    [input.movements[0]!, { sourceMovementId: 'other', reversalMovementId: 'reverse' }],
  ])('refuses malformed/reused movement pairs %j', async (...movements) => {
    const { db, create } = fixture();
    await expect(appendControlledPurchaseReversals(db, { ...input, movements })).rejects.toThrow(
      'MOVEMENT'
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('requires reconciliation with both the previous register and actual sellable stock', async () => {
    for (const options of [{ previous: 9 }, { sellable: 1 }]) {
      const { db, create } = fixture(options);
      await expect(appendControlledPurchaseReversals(db, input)).rejects.toThrow();
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('refuses a missing required controlled AVAILABLE original before any append', async () => {
    const { db, raw, create } = fixture();
    raw.pharmacyControlledRegisterEntry.findMany.mockResolvedValueOnce([]);
    await expect(appendControlledPurchaseReversals(db, input)).rejects.toThrow(
      'MISSING_PURCHASE_ORIGINAL'
    );
    expect(create).not.toHaveBeenCalled();
    expect(raw.pharmacyControlledRegisterEntry.aggregate).not.toHaveBeenCalled();
  });

  it('refuses a mixed complete/incomplete required set before any correction', async () => {
    const { db, raw, create } = fixture();
    raw.pharmacyStockMovement.findMany.mockResolvedValueOnce([
      source,
      reversal,
      { ...source, id: 'receipt2' },
      { ...reversal, id: 'reverse2', reversesMovementId: 'receipt2' },
    ]);
    await expect(
      appendControlledPurchaseReversals(db, {
        ...input,
        movements: [
          ...input.movements,
          { sourceMovementId: 'receipt2', reversalMovementId: 'reverse2' },
        ],
      })
    ).rejects.toThrow('MISSING_PURCHASE_ORIGINAL');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    { controlled: false, quarantine: false },
    { controlled: true, quarantine: true },
    { controlled: false, quarantine: true },
  ])('does not invent an optional original for %j', async (options) => {
    const { db, raw, create } = fixture(options);
    raw.pharmacyControlledRegisterEntry.findMany.mockResolvedValueOnce([]);
    await appendControlledPurchaseReversals(db, input);
    expect(create).not.toHaveBeenCalled();
  });
});
