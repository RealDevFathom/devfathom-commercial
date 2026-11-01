import { describe, expect, it, vi } from 'vitest';
// These domain-unit fakes isolate posting; actual automatic journals are asserted
// through restricted PostgreSQL in operational-finance.db.test.ts.
vi.mock('./finance-postings', () => ({
  postSaleReturnEntry: vi.fn().mockResolvedValue({}),
  postUnidentifiedSaleReturnEntry: vi.fn().mockResolvedValue({}),
  postSaleLineEntry: vi.fn().mockResolvedValue({}),
  postTenderEntry: vi.fn().mockResolvedValue({}),
  postTenderRefundEntry: vi.fn().mockResolvedValue({}),
}));

import { returnedLineValue, returnSaleLine, readReturnHistory } from './sales';
import { postUnidentifiedSaleReturnEntry } from './finance-postings';
import { can } from '@/lib/abac';

vi.mock('@/lib/abac', () => ({ can: vi.fn() }));

const scope = { organizationId: 'o', branchId: 'b', actorId: 'a' };
const input = {
  saleLineId: 'line',
  lotId: 'lot2',
  canonicalUnits: 6,
  disposition: 'RESTOCK' as const,
  reason: 'WRONG_ITEM',
  integrityDecision: 'sealed, storage verified',
  idempotencyKey: 'key',
};
function fixture() {
  vi.mocked(can).mockResolvedValue(true);
  const line = {
    id: 'line',
    saleId: 'sale',
    canonicalUnits: 10,
    sale: { status: 'COMPLETED' },
    medicine: { controlled: false },
    allocations: [
      { id: 'a1', inventoryLotId: 'lot1', stockLocationId: 'shelf1', canonicalUnits: 4 },
      { id: 'a2', inventoryLotId: 'lot2', stockLocationId: 'shelf2', canonicalUnits: 6 },
    ],
    unidentifiedReturnHolds: [] as Array<{ canonicalUnits: number }>,
    returnLines: [{ inventoryLotId: 'lot1', canonicalUnits: 2 }],
  };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findFirst: vi.fn().mockResolvedValue({ id: 'a', status: 'ACTIVE' }) },
    pharmacySaleLine: { findFirst: vi.fn().mockResolvedValue(line) },
    pharmacySaleEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    pharmacyStockLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'shelf' }) },
    pharmacyInventoryLot: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ batch: { state: 'ACTIVE', expiresAt: new Date('2099-01-01') } }),
    },
    pharmacySaleReturn: {
      create: vi.fn().mockResolvedValue({ id: 'return', createdAt: new Date('2026-10-21') }),
      findFirst: vi.fn().mockResolvedValue({
        id: 'return',
        lines: [{ stockMovementId: 'movement' }],
        unidentifiedHolds: [],
      }),
    },
    pharmacyStockMovement: {
      create: vi.fn().mockResolvedValue({ id: 'movement' }),
      findFirst: vi.fn().mockResolvedValue({ id: 'movement' }),
    },
    pharmacySaleReturnLine: { create: vi.fn().mockResolvedValue({}) },
    pharmacyUnidentifiedReturnHold: { create: vi.fn().mockResolvedValue({ id: 'hold' }) },
    pharmacyReturnVerificationTask: { create: vi.fn().mockResolvedValue({ id: 'task' }) },
  };
  return { db, line };
}
describe('counter return boundaries', () => {
  it('restocks only the explicitly named second lot, never the first allocation', async () => {
    const { db } = fixture();
    await returnSaleLine(db as never, scope, input);
    expect(db.pharmacyStockMovement.create.mock.calls.map(([v]) => v.data)).toEqual([
      expect.objectContaining({
        inventoryLotId: 'lot2',
        stockLocationId: 'shelf2',
        disposition: 'AVAILABLE',
        quantityUnits: 6,
      }),
    ]);
    expect(db.pharmacySaleEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: 'a',
          payload: expect.objectContaining({
            disposition: 'RESTOCK',
            integrityDecision: input.integrityDecision,
          }),
        }),
      })
    );
  });
  it.each(['RECALLED', 'QUARANTINED', 'EXPIRED'])(
    'refuses unsafe %s restock before a stock movement',
    async (state) => {
      const { db } = fixture();
      db.pharmacyInventoryLot.findFirst.mockResolvedValue({
        batch: {
          state: state === 'EXPIRED' ? 'ACTIVE' : state,
          expiresAt: new Date(state === 'EXPIRED' ? '2000-01-01' : '2099-01-01'),
        },
      });
      await expect(returnSaleLine(db as never, scope, input)).rejects.toThrow('UNSAFE_STOCK');
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyInventoryLot.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'lot2', organizationId: 'o', branchId: 'b' } })
      );
    }
  );
  it('rejects cross-branch quarantine locations', async () => {
    const { db } = fixture();
    db.pharmacyStockLocation.findFirst.mockResolvedValue(null);
    await expect(
      returnSaleLine(db as never, scope, {
        ...input,
        disposition: 'QUARANTINE',
        quarantineLocationId: 'other',
      })
    ).rejects.toThrow('CROSS_BRANCH_REFERENCE');
    expect(db.pharmacySaleReturn.create).not.toHaveBeenCalled();
  });
  it('replays exact return evidence and rejects changed payloads', async () => {
    const { db } = fixture();
    await returnSaleLine(db as never, scope, input);
    const payload = db.pharmacySaleEvent.create.mock.calls[0][0].data.payload;
    db.pharmacySaleEvent.findFirst.mockResolvedValue({ payload });
    expect(await returnSaleLine(db as never, scope, input)).toMatchObject({
      returnId: 'return',
      replayed: true,
    });
    expect(db.pharmacySaleReturn.create).toHaveBeenCalledTimes(1);
    await expect(
      returnSaleLine(db as never, scope, { ...input, canonicalUnits: 3 })
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('recognizes a committed controlled return replay without reusing a witness credential', async () => {
    const { db, line } = fixture();
    line.medicine.controlled = true;
    // Supply the exact durable evidence as though the first request committed before its response
    // was lost. The replay must be resolved before fresh-witness authorization.
    const fingerprint = JSON.stringify({ ...input, disposition: 'RESTOCK' });
    db.pharmacySaleEvent.findFirst.mockResolvedValue({
      payload: { returnId: 'return', fingerprint },
    });
    await expect(returnSaleLine(db as never, scope, input)).resolves.toMatchObject({
      returnId: 'return',
      replayed: true,
    });
  });
  it('denies a controlled return replay to an actor without dispense permission', async () => {
    const { db, line } = fixture();
    line.medicine.controlled = true;
    vi.mocked(can).mockResolvedValue(false);
    const fingerprint = JSON.stringify({ ...input, disposition: 'RESTOCK' });
    db.pharmacySaleEvent.findFirst.mockResolvedValue({
      payload: { returnId: 'return', fingerprint },
    });
    await expect(returnSaleLine(db as never, scope, input)).rejects.toMatchObject({
      forbidden: true,
    });
    expect(db.pharmacySaleEvent.findFirst).not.toHaveBeenCalled();
  });
  it('rounds cumulative partial value to the exact discounted total', () => {
    const line = { quantity: 1, unitPriceMinor: 100, discountMinor: 2, canonicalUnits: 3 };
    expect([1, 2, 3].map((n) => returnedLineValue(line, n))).toEqual([32, 65, 98]);
  });
  it('does not disclose another branch receipt history', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await expect(
      readReturnHistory({ pharmacySale: { findFirst } } as never, scope, 'other')
    ).rejects.toThrow('NOT_FOUND');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'o', branchId: 'b' }),
      })
    );
  });
  it.each([true, false])('flags controlled sold lines (controlled=%s)', async (controlled) => {
    const sale = {
      id: 'sale',
      receiptNumber: 1,
      receiptDeviceId: 'd',
      businessDate: new Date('2026-10-01'),
      lines: [
        {
          id: 'line',
          medicine: { productName: 'Medicine', controlled },
          saleUnit: 'STRIP',
          quantity: 1,
          unitPriceMinor: 1000,
          discountMinor: 0,
          canonicalUnitsPerSaleUnit: 10,
          canonicalUnits: 10,
          returnLines: [],
          unidentifiedReturnHolds: [],
          allocations: [],
        },
      ],
      tenders: [],
      returns: [],
    };
    const findFirst = vi.fn().mockResolvedValue(sale);
    const history = await readReturnHistory(
      {
        pharmacySale: { findFirst },
        pharmacyStockLocation: { findMany: vi.fn().mockResolvedValue([]) },
      } as never,
      scope,
      'sale'
    );
    expect(history.lines[0].controlled).toBe(controlled);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          lines: expect.objectContaining({
            include: expect.objectContaining({
              medicine: { select: { productName: true, controlled: true } },
            }),
          }),
        }),
      })
    );
  });
});

describe('verified physical lot boundaries', () => {
  it('refuses an unsold lot even when it is active', async () => {
    const { db } = fixture();
    await expect(returnSaleLine(db as never, scope, { ...input, lotId: 'other' })).rejects.toThrow(
      'CROSS_BRANCH_REFERENCE'
    );
    expect(db.pharmacySaleReturn.create).not.toHaveBeenCalled();
  });
  it('caps a named lot after earlier returns, even when another lot has units left', async () => {
    const { db } = fixture();
    await expect(
      returnSaleLine(db as never, scope, { ...input, lotId: 'lot1', canonicalUnits: 3 })
    ).rejects.toThrow('RETURN_EXCEEDS_SOLD');
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });
  it.each(['RESTOCK', 'QUARANTINE'] as const)(
    'quarantines unidentified %s requests without assigning a lot',
    async (disposition) => {
      const { db } = fixture();
      const result = await returnSaleLine(db as never, scope, {
        ...input,
        lotId: undefined,
        disposition,
        quarantineLocationId: 'q',
      });
      expect(result).toMatchObject({
        holding: { id: 'hold' },
        verificationTask: { id: 'task' },
        movement: null,
      });
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacySaleReturnLine.create).not.toHaveBeenCalled();
      expect(db.pharmacyUnidentifiedReturnHold.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          saleLineId: 'line',
          quarantineLocationId: 'shelf',
          canonicalUnits: 6,
        }),
      });
      expect(db.pharmacyReturnVerificationTask.create).toHaveBeenCalledWith({
        data: { organizationId: 'o', branchId: 'b', holdingId: 'hold', requestedByUserId: 'a' },
      });
      expect(postUnidentifiedSaleReturnEntry).toHaveBeenCalledWith(db, scope, {
        holdingId: 'hold',
        at: new Date('2026-10-21'),
      });
    }
  );
  it('counts unidentified holdings against all subsequent named returns', async () => {
    const { db, line } = fixture();
    line.unidentifiedReturnHolds.push({ canonicalUnits: 5 });
    await expect(
      returnSaleLine(db as never, scope, { ...input, canonicalUnits: 4 })
    ).rejects.toThrow('RETURN_EXCEEDS_SOLD');
    expect(db.pharmacySaleReturn.create).not.toHaveBeenCalled();
  });
  it('requires quarantine custody for legacy restock requests with no verified lot', async () => {
    const { db } = fixture();
    db.pharmacyStockLocation.findFirst.mockResolvedValue(null);
    await expect(
      returnSaleLine(db as never, scope, { ...input, lotId: undefined })
    ).rejects.toThrow('CROSS_BRANCH_REFERENCE');
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });
});

it('routes a legacy restock payload without a location to existing branch quarantine', async () => {
  const { db } = fixture();
  const result = await returnSaleLine(db as never, scope, { ...input, lotId: undefined });
  expect(result.movement).toBeNull();
  expect(db.pharmacyStockLocation.findFirst).toHaveBeenCalledWith({
    where: { id: undefined, organizationId: 'o', branchId: 'b', active: true, kind: 'QUARANTINE' },
    orderBy: { id: 'asc' },
  });
  expect(db.pharmacyReturnVerificationTask.create).toHaveBeenCalledOnce();
});
