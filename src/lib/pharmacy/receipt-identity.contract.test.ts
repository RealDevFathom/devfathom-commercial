/**
 * WHA-1370 R1/R2 against the real validator
 * (src/lib/pharmacy/receipt-identity.ts, sha256 7db40d2a…). No mocks: this is
 * the rule set that sale-completion.identity.test.ts replaces with a recorder.
 *
 * Fixture: two lines across three allocations. Each refusal changes exactly one
 * fact, most on the LAST line or allocation, so a check that stops early fails.
 *
 * Place next to the source: src/lib/pharmacy/receipt-identity.contract.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  PharmacyReceiptIdentityError,
  readReceiptIdentity,
  validateReceiptIdentity,
  type ReceiptIdentityFacts,
} from './receipt-identity';

function facts(): ReceiptIdentityFacts {
  return {
    id: 'sale_1',
    receiptNumber: 41,
    receiptDeviceId: 'counter-a',
    businessDate: new Date('2026-10-11T00:00:00.000Z'),
    completedAt: new Date('2026-10-11T09:30:00.000Z'),
    lines: [
      {
        id: 'line_1',
        medicineId: 'med_1',
        presentationId: 'pres_1',
        canonicalUnits: 30,
        allocations: [
          { id: 'al_1', inventoryLotId: 'lot_1', canonicalUnits: 20 },
          { id: 'al_2', inventoryLotId: 'lot_2', canonicalUnits: 10 },
        ],
      },
      {
        id: 'line_2',
        medicineId: 'med_2',
        presentationId: 'pres_2',
        canonicalUnits: 5,
        allocations: [{ id: 'al_3', inventoryLotId: 'lot_3', canonicalUnits: 5 }],
      },
    ],
  };
}

function allocation(
  allocationId: string,
  inventoryLotId: string,
  batchNumber: string,
  canonicalUnits: number
) {
  return {
    allocationId,
    inventoryLotId,
    batchNumber,
    expiresAt: '2027-06-30T00:00:00.000Z',
    canonicalUnits,
  };
}

function snapshot() {
  return {
    receiptIdentitySnapshotVersion: 1,
    saleId: 'sale_1',
    receiptNumber: 41,
    deviceId: 'counter-a',
    businessDate: '2026-10-11',
    issuedAt: '2026-10-11T09:30:00.000Z',
    lines: [
      {
        saleLineId: 'line_1',
        medicineId: 'med_1',
        presentationId: 'pres_1',
        medicineName: 'Paracetamol',
        strength: '500 mg' as string | null,
        presentation: 'Tablet',
        allocations: [
          allocation('al_1', 'lot_1', 'B-001', 20),
          allocation('al_2', 'lot_2', 'B-002', 10),
        ],
      },
      {
        saleLineId: 'line_2',
        medicineId: 'med_2',
        presentationId: 'pres_2',
        medicineName: 'Amoxicillin',
        strength: '250 mg' as string | null,
        presentation: 'Capsule',
        allocations: [allocation('al_3', 'lot_3', 'C-777', 5)],
      },
    ],
  };
}

type Snapshot = ReturnType<typeof snapshot>;
type Mutation = (s: Snapshot, f: ReceiptIdentityFacts) => void;

describe('R1 validateReceiptIdentity accepts exact correspondence', () => {
  it('returns the parsed snapshot with every allocation intact', () => {
    const result = validateReceiptIdentity(snapshot(), facts());
    expect(result).toEqual(snapshot());
    expect(result.lines.flatMap((l) => l.allocations.map((a) => a.batchNumber))).toEqual([
      'B-001',
      'B-002',
      'C-777',
    ]);
  });

  it('does not compare issued labels to the current catalog', () => {
    // Names, strength, batch and expiry are issued text; a later catalog rename
    // must not invalidate an already-issued receipt.
    const s = snapshot();
    s.lines[1]!.medicineName = 'Renamed product';
    s.lines[1]!.strength = null;
    s.lines[1]!.allocations[0]!.batchNumber = 'RELABELLED';
    s.lines[1]!.allocations[0]!.expiresAt = '2029-01-01T00:00:00.000Z';
    expect(() => validateReceiptIdentity(s, facts())).not.toThrow();
  });
});

describe('R2 validateReceiptIdentity refuses any single wrong fact', () => {
  it.each<[string, Mutation]>([
    // Schema
    [
      'the snapshot version is 2',
      (s) => {
        s.receiptIdentitySnapshotVersion = 2;
      },
    ],
    [
      'the snapshot carries an unknown key',
      (s) => {
        Object.assign(s, { cardPan: '4111' });
      },
    ],
    [
      'an allocation carries an unknown key',
      (s) => {
        Object.assign(s.lines[1]!.allocations[0]!, { note: 'x' });
      },
    ],
    [
      'the last allocation has zero units',
      (s, f) => {
        s.lines[1]!.allocations[0]!.canonicalUnits = 0;
        (f.lines[1] as { canonicalUnits: number }).canonicalUnits = 0;
      },
    ],
    [
      'the receipt number is fractional',
      (s, f) => {
        s.receiptNumber = 41.5;
        f.receiptNumber = 41.5;
      },
    ],
    [
      'the business date is not ISO',
      (s) => {
        s.businessDate = '11/10/2026';
      },
    ],
    [
      'the last line has no allocations',
      (s) => {
        s.lines[1]!.allocations = [];
      },
    ],
    // Sale header
    [
      'the sale id differs',
      (s) => {
        s.saleId = 'sale_2';
      },
    ],
    [
      'the receipt number differs',
      (s) => {
        s.receiptNumber = 42;
      },
    ],
    [
      'the device differs',
      (s) => {
        s.deviceId = 'counter-b';
      },
    ],
    [
      'the business date differs',
      (s) => {
        s.businessDate = '2026-10-12';
      },
    ],
    [
      'issuedAt differs by one second',
      (s) => {
        s.issuedAt = '2026-10-11T09:30:01.000Z';
      },
    ],
    [
      'the sale was never numbered',
      (_s, f) => {
        f.receiptNumber = null;
      },
    ],
    [
      'the sale has no completion time',
      (_s, f) => {
        f.completedAt = null;
      },
    ],
    // Lines
    [
      'a line is missing',
      (s) => {
        s.lines.pop();
      },
    ],
    [
      'a line id is unknown',
      (s) => {
        s.lines[1]!.saleLineId = 'line_9';
      },
    ],
    [
      'a line id is repeated',
      (s) => {
        s.lines[1] = { ...s.lines[0]! };
      },
    ],
    [
      'the last line names another medicine',
      (s) => {
        s.lines[1]!.medicineId = 'med_1';
      },
    ],
    [
      'the last line names another presentation',
      (s) => {
        s.lines[1]!.presentationId = 'pres_1';
      },
    ],
    // Allocations
    [
      'an allocation is dropped from a split line',
      (s) => {
        s.lines[0]!.allocations.pop();
      },
    ],
    [
      'the last allocation names another lot',
      (s) => {
        s.lines[1]!.allocations[0]!.inventoryLotId = 'lot_1';
      },
    ],
    [
      'the last allocation units differ',
      (s) => {
        s.lines[1]!.allocations[0]!.canonicalUnits = 6;
      },
    ],
    [
      'an allocation id is repeated within a line',
      (s) => {
        s.lines[0]!.allocations[1] = allocation('al_1', 'lot_1', 'B-001', 10);
      },
    ],
    [
      "a line claims another line's allocation",
      (s) => {
        s.lines[1]!.allocations[0] = allocation('al_1', 'lot_1', 'B-001', 5);
      },
    ],
    [
      'allocations do not sum to the line units',
      (_s, f) => {
        (f.lines[0] as { canonicalUnits: number }).canonicalUnits = 31;
      },
    ],
  ])('refuses when %s', (_label, mutate) => {
    const s = snapshot();
    const f = facts();
    mutate(s, f);
    expect(() => validateReceiptIdentity(s, f)).toThrow(PharmacyReceiptIdentityError);
  });

  it('refuses a non-object payload', () => {
    expect(() => validateReceiptIdentity(null, facts())).toThrow(PharmacyReceiptIdentityError);
  });
});

describe('readReceiptIdentity', () => {
  const statusOnly = [{ payload: { status: 'COMPLETED' } }, { payload: null }];

  it('returns null when only status events exist', () => {
    expect(readReceiptIdentity(statusOnly, facts())).toBeNull();
  });

  it('returns the one validated identity among status events', () => {
    expect(readReceiptIdentity([...statusOnly, { payload: snapshot() }], facts())).toEqual(
      snapshot()
    );
  });

  it('refuses two identity events even when both are valid', () => {
    expect(() =>
      readReceiptIdentity([{ payload: snapshot() }, { payload: snapshot() }], facts())
    ).toThrow(PharmacyReceiptIdentityError);
  });

  it('refuses a single identity event that does not match the sale', () => {
    const s = snapshot();
    s.lines[1]!.allocations[0]!.canonicalUnits = 6;
    expect(() => readReceiptIdentity([{ payload: s }], facts())).toThrow(
      PharmacyReceiptIdentityError
    );
  });
});
