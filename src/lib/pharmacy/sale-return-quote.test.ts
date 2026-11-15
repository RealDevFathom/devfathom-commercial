import { describe, expect, it, vi } from 'vitest';
import { planLotReturn, quoteSaleLineReturn } from './sales';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// DEV-501: the counter prefills a refund from the same pure plan returnSaleLine records, so
// a verified lot is valued at its own allocation price, not the line-wide average.

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };

/** One sold line of 2 units: one unit from a PKR 1.00 batch, one from a PKR 3.00 batch. */
function mixedLine() {
  return {
    id: 'line-a',
    quantity: 2,
    unitPriceMinor: 200,
    grossMinor: 400,
    discountMinor: 0,
    canonicalUnits: 2,
    allocations: [
      {
        id: 'alloc-1',
        inventoryLotId: 'lot-cheap',
        canonicalUnits: 1,
        grossMinor: 100,
        discountMinor: 0,
      },
      {
        id: 'alloc-2',
        inventoryLotId: 'lot-dear',
        canonicalUnits: 1,
        grossMinor: 300,
        discountMinor: 0,
      },
    ],
    returnLines: [] as Array<{
      inventoryLotId: string;
      canonicalUnits: number;
      grossMinor: number | null;
      discountMinor: number | null;
    }>,
    unidentifiedReturnHolds: [] as Array<{
      canonicalUnits: number;
      grossMinor: number | null;
      discountMinor: number | null;
    }>,
  };
}

function fakeDb(line: ReturnType<typeof mixedLine> & { sale?: { status: string } }) {
  return {
    pharmacySaleLine: {
      findFirst: vi.fn().mockResolvedValue({ sale: { status: 'COMPLETED' }, ...line }),
    },
  } as unknown as ScopedDb;
}

describe('DEV-501 return refund quote', () => {
  it('prices each verified lot from its own allocation snapshot', () => {
    const line = mixedLine();
    expect(planLotReturn(line, 'lot-cheap', 1)).toEqual({
      slices: [
        {
          allocation: line.allocations[0],
          units: 1,
          money: { grossMinor: 100, discountMinor: 0 },
        },
      ],
      remaining: 0,
    });
    expect(planLotReturn(line, 'lot-dear', 1).slices[0]!.money).toEqual({
      grossMinor: 300,
      discountMinor: 0,
    });
    // More than the lot sold is left unplanned; an unsold lot plans nothing.
    expect(planLotReturn(line, 'lot-dear', 2).remaining).toBe(1);
    expect(planLotReturn(line, 'lot-other', 1)).toEqual({ slices: [], remaining: 1 });
  });

  it('does not mutate the sold line it plans from', () => {
    const line = mixedLine();
    planLotReturn(line, 'lot-cheap', 1);
    expect(line.returnLines).toEqual([]);
  });

  it('skips what an earlier return already took from the lot', () => {
    const line = mixedLine();
    line.allocations.push({
      id: 'alloc-3',
      inventoryLotId: 'lot-cheap',
      canonicalUnits: 1,
      grossMinor: 150,
      discountMinor: 0,
    });
    line.canonicalUnits = 3;
    line.quantity = 3;
    line.grossMinor = 550;
    line.returnLines.push({
      inventoryLotId: 'lot-cheap',
      canonicalUnits: 1,
      grossMinor: 100,
      discountMinor: 0,
    });
    const plan = planLotReturn(line, 'lot-cheap', 1);
    expect(plan.slices.map((slice) => slice.allocation.id)).toEqual(['alloc-3']);
    expect(plan.slices[0]!.money.grossMinor).toBe(150);
  });

  it('quotes the selected lot, not the line average', async () => {
    await expect(
      quoteSaleLineReturn(fakeDb(mixedLine()), scope, {
        saleLineId: 'line-a',
        lotId: 'lot-dear',
        canonicalUnits: 1,
      })
    ).resolves.toEqual({ valueMinor: 300 });
    await expect(
      quoteSaleLineReturn(fakeDb(mixedLine()), scope, {
        saleLineId: 'line-a',
        lotId: 'lot-cheap',
        canonicalUnits: 1,
      })
    ).resolves.toEqual({ valueMinor: 100 });
  });

  it('quotes unidentified stock at the line average, as its hold is valued', async () => {
    await expect(
      quoteSaleLineReturn(fakeDb(mixedLine()), scope, { saleLineId: 'line-a', canonicalUnits: 1 })
    ).resolves.toEqual({ valueMinor: 200 });
  });

  it('refuses quantities and lots that the return would refuse', async () => {
    await expect(
      quoteSaleLineReturn(fakeDb(mixedLine()), scope, { saleLineId: 'line-a', canonicalUnits: 3 })
    ).rejects.toMatchObject({ reason: 'RETURN_EXCEEDS_SOLD' });
    await expect(
      quoteSaleLineReturn(fakeDb(mixedLine()), scope, {
        saleLineId: 'line-a',
        lotId: 'lot-dear',
        canonicalUnits: 2,
      })
    ).rejects.toMatchObject({ reason: 'RETURN_EXCEEDS_SOLD' });
    await expect(
      quoteSaleLineReturn(fakeDb(mixedLine()), scope, {
        saleLineId: 'line-a',
        lotId: 'lot-other',
        canonicalUnits: 1,
      })
    ).rejects.toMatchObject({ reason: 'CROSS_BRANCH_REFERENCE' });
    const db = {
      pharmacySaleLine: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as ScopedDb;
    await expect(
      quoteSaleLineReturn(db, scope, { saleLineId: 'line-a', canonicalUnits: 1 })
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });

  it('reads only the active tenant branch', async () => {
    const db = fakeDb(mixedLine());
    await quoteSaleLineReturn(db, scope, { saleLineId: 'line-a', canonicalUnits: 1 });
    expect(
      (db as unknown as { pharmacySaleLine: { findFirst: ReturnType<typeof vi.fn> } })
        .pharmacySaleLine.findFirst
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'line-a', organizationId: 'org-a', branchId: 'branch-a' },
      })
    );
  });
});
