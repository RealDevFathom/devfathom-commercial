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

import {
  returnedLineValue,
  returnedSaleLineValue,
  returnSaleLine,
  readReturnHistory,
} from './sales';
import { postUnidentifiedSaleReturnEntry } from './finance-postings';

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
  const line = {
    id: 'line',
    saleId: 'sale',
    canonicalUnits: 10,
    sale: { status: 'COMPLETED' },
    medicine: { controlled: false },
    allocations: [
      {
        id: 'a1',
        inventoryLotId: 'lot1',
        stockLocationId: 'shelf1',
        canonicalUnits: 4,
        grossMinor: 400,
        discountMinor: 0,
      },
      {
        id: 'a2',
        inventoryLotId: 'lot2',
        stockLocationId: 'shelf2',
        canonicalUnits: 6,
        grossMinor: 600,
        discountMinor: 0,
      },
    ],
    unidentifiedReturnHolds: [] as Array<{ canonicalUnits: number }>,
    returnLines: [{ inventoryLotId: 'lot1', canonicalUnits: 2 }],
  };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
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
  it.each(Array.from({ length: 7 }, (_, used) => used))(
    'keeps a one-unit partial refund nonnegative after %i returned units',
    async (used) => {
      const { db, line } = fixture();
      line.canonicalUnits = 7;
      line.allocations = [
        {
          id: 'a2',
          inventoryLotId: 'lot2',
          stockLocationId: 'shelf2',
          canonicalUnits: 7,
          grossMinor: 3,
          discountMinor: 2,
        },
      ];
      line.returnLines = used ? [{ inventoryLotId: 'lot2', canonicalUnits: used }] : [];
      await returnSaleLine(db as never, scope, { ...input, canonicalUnits: 1 });
      const data = db.pharmacySaleReturnLine.create.mock.calls[0]![0].data;
      expect(data.grossMinor - data.discountMinor).toBe(used === 6 ? 1 : 0);
      expect(data.discountMinor).toBe(
        Math.floor((2 * (used + 1)) / 7) - Math.floor((2 * used) / 7)
      );
    }
  );
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
  it('rounds cumulative partial value to the exact discounted total', () => {
    const line = { quantity: 1, unitPriceMinor: 100, discountMinor: 2, canonicalUnits: 3 };
    expect([1, 2, 3].map((n) => returnedLineValue(line, n))).toEqual([32, 65, 98]);
  });
  it('floors refund values exactly when the intermediate product exceeds safe integers', () => {
    const line = {
      quantity: 1,
      unitPriceMinor: 2_147_483_647,
      grossMinor: 2_147_483_647,
      discountMinor: 0,
      canonicalUnits: 2_147_483_646,
    };
    expect(returnedLineValue(line, 2_147_483_645)).toBe(2_147_483_645);
    expect(
      returnedSaleLineValue({
        ...line,
        returnLines: [],
        unidentifiedReturnHolds: [{ canonicalUnits: 2_147_483_645 }],
      })
    ).toBe(2_147_483_645);
  });
  it('assigns the exact final remainder to an identified return with a large product', async () => {
    const { db, line } = fixture();
    line.canonicalUnits = 2_147_483_646;
    line.allocations = [
      {
        id: 'a2',
        inventoryLotId: 'lot2',
        stockLocationId: 'shelf2',
        canonicalUnits: 2_147_483_646,
        grossMinor: 2_147_483_647,
        discountMinor: 0,
      },
    ];
    line.returnLines = [{ inventoryLotId: 'lot2', canonicalUnits: 2_147_483_645 }];
    await returnSaleLine(db as never, scope, { ...input, canonicalUnits: 1 });
    expect(db.pharmacySaleReturnLine.create.mock.calls[0]![0].data).toMatchObject({
      grossMinor: 2,
      discountMinor: 0,
    });
  });
  it('adds exact identified value to the reserved share for unidentified holds', () => {
    expect(
      returnedSaleLineValue({
        quantity: 3,
        unitPriceMinor: 133,
        grossMinor: 400,
        discountMinor: 40,
        canonicalUnits: 3,
        returnLines: [{ canonicalUnits: 1, grossMinor: 200, discountMinor: 20 }],
        unidentifiedReturnHolds: [{ canonicalUnits: 1 }],
      })
    ).toBe(270);
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
  it('does not let a named return displace value reserved by an unidentified hold', async () => {
    const { db, line } = fixture();
    line.unidentifiedReturnHolds.push({ canonicalUnits: 1 });
    await expect(
      returnSaleLine(db as never, scope, { ...input, canonicalUnits: 1 })
    ).rejects.toThrow('INVALID_STATE');
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
