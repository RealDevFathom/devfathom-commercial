/**
 * WHA-1370 issued-receipt cases R1–R3 against the recovered completion step
 * (src/lib/pharmacy/sale-completion.ts, manifest sha256 e59dcef2…).
 *
 * `validateReceiptIdentity` lives in src/lib/pharmacy/receipt-identity.ts, which
 * was not staged for this lane, so it is replaced by a pass-through recorder:
 * these cases prove what the completion step checks and hands to the validator,
 * not what the validator itself enforces. Rollback of the receipt number on a
 * refused identity needs the real transaction (see R2 note below).
 *
 * Place next to the source: src/lib/pharmacy/sale-completion.identity.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validate: vi.fn<(snapshot: unknown, sale: unknown) => { validated: unknown }>((snapshot) => ({
    validated: snapshot,
  })),
  post: vi
    .fn<(db: unknown, scope: unknown, entry: { saleLineId: string; at: Date }) => Promise<void>>()
    .mockResolvedValue(undefined),
}));

// #633: the batch re-check has its own PostgreSQL suite (sale-batch-safety.db.test.ts); here
// it records its place in the order and hands back the batch facts it checked under lock.
const safety = vi.hoisted(() => ({
  checked: new Map<string, { batchNumber: string; expiresAt: Date }>(),
  assert: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('./finance-postings', () => ({ postSaleLineEntry: mocks.post }));
vi.mock('./sale-batch-safety', () => ({ assertSaleBatchesSellable: safety.assert }));
vi.mock('./receipt-identity', () => {
  class PharmacyReceiptIdentityError extends Error {
    constructor() {
      super('RECEIPT_IDENTITY');
      this.name = 'PharmacyReceiptIdentityError';
    }
  }
  return { PharmacyReceiptIdentityError, validateReceiptIdentity: mocks.validate };
});

import { PharmacyReceiptIdentityError } from './receipt-identity';
import { completePaidPharmacySale } from './sale-completion';

const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'cashier_1' };
const input = { deviceId: 'counter-a', businessDate: new Date('2026-10-11T00:00:00.000Z') };

function allocation(
  id: string,
  medicineId: string,
  batchNumber: string,
  expiresAt: string,
  canonicalUnits: number
) {
  return {
    id,
    organizationId: 'org_a',
    branchId: 'branch_a',
    inventoryLotId: `lot_${id}`,
    canonicalUnits,
    lot: {
      organizationId: 'org_a',
      branchId: 'branch_a',
      batch: { organizationId: 'org_a', medicineId, batchNumber, expiresAt: new Date(expiresAt) },
    },
  };
}
function line(id: string, medicineId: string, allocations: ReturnType<typeof allocation>[]) {
  return {
    id,
    organizationId: 'org_a',
    branchId: 'branch_a',
    medicineId,
    presentationId: `pres_${medicineId}`,
    medicine: {
      organizationId: 'org_a',
      productName: `Product ${medicineId}`,
      strengths: [{ value: '500.00', unit: 'mg' }],
    },
    presentation: { organizationId: 'org_a', medicineId, presentation: 'Tablet' },
    allocations,
  };
}
/** Two lines across three lots: line 1 is split over two batches. */
function sale() {
  return {
    id: 'sale_1',
    status: 'OPEN',
    lines: [
      line('line_1', 'med_1', [
        allocation('al_1', 'med_1', 'B-001', '2027-01-31T00:00:00.000Z', 20),
        allocation('al_2', 'med_1', 'B-002', '2027-06-30T00:00:00.000Z', 10),
      ]),
      line('line_2', 'med_2', [
        allocation('al_3', 'med_2', 'C-777', '2028-03-31T00:00:00.000Z', 5),
      ]),
    ],
    tenders: [],
  };
}

let order: string[];
function makeDb() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn<(sql: unknown) => Promise<{ receipt_number: number }[]>>(async () => {
      order.push('sequence');
      return [{ receipt_number: 41 }];
    }),
    pharmacySale: {
      update: vi.fn(async () => {
        order.push('sale-completed');
        return {};
      }),
    },
    pharmacySaleEvent: {
      create: vi.fn<(args: { data: Record<string, unknown> }) => Promise<object>>(async () => {
        order.push('event');
        return {};
      }),
    },
  };
}
let db = makeDb();
const complete = (s: ReturnType<typeof sale>) =>
  completePaidPharmacySale(db as never, scope, s as never, input);

beforeEach(() => {
  order = [];
  db = makeDb();
  safety.checked = new Map();
  safety.assert.mockReset().mockImplementation(async () => {
    order.push('batch-safety');
    return safety.checked;
  });
  mocks.validate.mockClear();
  mocks.post.mockClear().mockImplementation(async () => {
    order.push('posting');
  });
});

describe('R1 receipt identity carries every batch fact', () => {
  it('hands the validator all three allocations with batch, expiry and units, and stores its result', async () => {
    await expect(complete(sale())).resolves.toBe(41);
    expect(mocks.validate).toHaveBeenCalledTimes(1);
    const snapshot = mocks.validate.mock.calls[0]![0] as {
      receiptNumber: number;
      deviceId: string;
      businessDate: string;
      saleId: string;
      lines: Array<{ saleLineId: string; strength: string | null; allocations: unknown[] }>;
    };
    expect(snapshot).toMatchObject({
      receiptIdentitySnapshotVersion: 1,
      saleId: 'sale_1',
      receiptNumber: 41,
      deviceId: 'counter-a',
      businessDate: '2026-10-11',
    });
    expect(snapshot.lines.map((l) => l.saleLineId)).toEqual(['line_1', 'line_2']);
    expect(snapshot.lines[0]!.strength).toBe('500 mg');
    expect(snapshot.lines.flatMap((l) => l.allocations)).toEqual([
      {
        allocationId: 'al_1',
        inventoryLotId: 'lot_al_1',
        batchNumber: 'B-001',
        expiresAt: '2027-01-31T00:00:00.000Z',
        canonicalUnits: 20,
      },
      {
        allocationId: 'al_2',
        inventoryLotId: 'lot_al_2',
        batchNumber: 'B-002',
        expiresAt: '2027-06-30T00:00:00.000Z',
        canonicalUnits: 10,
      },
      {
        allocationId: 'al_3',
        inventoryLotId: 'lot_al_3',
        batchNumber: 'C-777',
        expiresAt: '2028-03-31T00:00:00.000Z',
        canonicalUnits: 5,
      },
    ]);
    // The validator sees the sale with the issued number and device, not the stale OPEN copy.
    expect(mocks.validate.mock.calls[0]![1]).toMatchObject({
      id: 'sale_1',
      receiptNumber: 41,
      receiptDeviceId: 'counter-a',
    });
    const event = db.pharmacySaleEvent.create.mock.calls[0]![0] as unknown as {
      data: Record<string, unknown>;
    };
    expect(event.data).toMatchObject({
      organizationId: 'org_a',
      branchId: 'branch_a',
      saleId: 'sale_1',
      kind: 'COMPLETED',
      actorId: 'cashier_1',
      payload: mocks.validate.mock.results[0]!.value,
    });
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls.map(([, , entry]) => entry.saleLineId)).toEqual([
      'line_1',
      'line_2',
    ]);
    for (const [, , entry] of mocks.post.mock.calls) expect(entry.at).toBe(event.data.occurredAt);
  });

  it('numbers receipts per organisation, scope branch and device, never from sale data', async () => {
    await complete(sale());
    const sql = db.$queryRaw.mock.calls[0]![0] as unknown as { values: unknown[] };
    expect(sql.values.slice(1)).toEqual(['org_a', 'branch_a', 'counter-a']);
    expect(db.pharmacySale.update).toHaveBeenCalledWith({
      where: { organizationId_id: { organizationId: 'org_a', id: 'sale_1' } },
      data: expect.objectContaining({
        status: 'COMPLETED',
        receiptNumber: 41,
        receiptDeviceId: 'counter-a',
        businessDate: input.businessDate,
      }),
    });
  });
});

describe('R2 a foreign fact anywhere refuses the receipt', () => {
  type Sale = ReturnType<typeof sale>;
  it.each<[string, (s: Sale) => void]>([
    [
      'the last allocation is from another branch',
      (s) => {
        s.lines[1]!.allocations[0]!.branchId = 'branch_b';
      },
    ],
    [
      'the second allocation lot is from another organisation',
      (s) => {
        s.lines[0]!.allocations[1]!.lot.organizationId = 'org_b';
      },
    ],
    [
      'the second allocation lot sits in another branch',
      (s) => {
        s.lines[0]!.allocations[1]!.lot.branchId = 'branch_b';
      },
    ],
    [
      'a batch belongs to a different medicine',
      (s) => {
        s.lines[1]!.allocations[0]!.lot.batch.medicineId = 'med_1';
      },
    ],
    [
      'a batch belongs to another organisation',
      (s) => {
        s.lines[0]!.allocations[0]!.lot.batch.organizationId = 'org_b';
      },
    ],
    [
      'a presentation belongs to another medicine',
      (s) => {
        s.lines[1]!.presentation.medicineId = 'med_1';
      },
    ],
    [
      'a medicine belongs to another organisation',
      (s) => {
        s.lines[0]!.medicine.organizationId = 'org_b';
      },
    ],
    [
      'a line is from another branch',
      (s) => {
        s.lines[1]!.branchId = 'branch_b';
      },
    ],
  ])('refuses when %s: no validator, event or posting', async (_label, mutate) => {
    const s = sale();
    mutate(s);
    await expect(complete(s)).rejects.toBeInstanceOf(PharmacyReceiptIdentityError);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(db.pharmacySaleEvent.create).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  // R2 (low): the number is drawn and the sale marked COMPLETED before the
  // identity check. Correct only because every caller runs inside one
  // transaction that rolls back on throw. This pins the order; the rollback
  // itself must be proven on PostgreSQL (sequence not advanced, sale OPEN).
  it('ORDER: sequence and COMPLETED update precede the identity refusal', async () => {
    const s = sale();
    s.lines[1]!.allocations[0]!.branchId = 'branch_b';
    await expect(complete(s)).rejects.toBeInstanceOf(PharmacyReceiptIdentityError);
    expect(order).toEqual(['batch-safety', 'sequence', 'sale-completed']);
  });

  it('#633: re-checks the batches before drawing a number and prints the facts it checked', async () => {
    safety.checked.set('lot_al_2', {
      batchNumber: 'B-002',
      expiresAt: new Date('2027-05-31T19:00:00.000Z'),
    });
    await expect(complete(sale())).resolves.toBe(41);
    expect(safety.assert).toHaveBeenCalledWith(db, scope, 'sale_1');
    expect(order[0]).toBe('batch-safety');
    const snapshot = mocks.validate.mock.calls[0]![0] as {
      lines: Array<{ allocations: Array<{ allocationId: string; expiresAt: string }> }>;
    };
    expect(snapshot.lines[0]!.allocations.map((row) => row.expiresAt)).toEqual([
      '2027-01-31T00:00:00.000Z',
      '2027-05-31T19:00:00.000Z',
    ]);
  });

  it('#633: an unsafe batch refuses before any number, update, event or posting', async () => {
    safety.assert.mockImplementationOnce(async () => {
      order.push('batch-safety');
      throw new Error('SALE_BATCH_RECALLED');
    });
    await expect(complete(sale())).rejects.toThrow('SALE_BATCH_RECALLED');
    expect(order).toEqual(['batch-safety']);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe('R3 device identity', () => {
  // R3 (informational): deviceId is the caller-supplied counter label used for
  // the per-device sequence and receipt; completion does not check it against
  // an enrolled device. Any enrolment rule would live upstream in settlement.
  // The mocked client has no device delegate, so any registry read would throw here.
  it('uses the supplied deviceId verbatim and reads no device registry', async () => {
    await expect(complete(sale())).resolves.toBe(41);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.validate.mock.calls[0]![0]).toMatchObject({ deviceId: 'counter-a' });
  });
});
