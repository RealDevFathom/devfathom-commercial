import { describe, expect, it, vi } from 'vitest';

import { type ReceiptNumberSequenceClient, allocateReceiptNumber } from './receipt-numbers';

/**
 * A fake that models the native ON CONFLICT upsert: the first allocation for a
 * (branch, businessDate) creates the row at `nextNumber`, each later one applies
 * the increment. It records the arguments so the tests can assert the exact
 * atomic shape (create nextNumber = 1, update increment = 1, composite where).
 */
function makeTx() {
  const store = new Map<string, number>();
  const upsert = vi.fn(
    async (args: {
      where: { branchId_businessDate: { branchId: string; businessDate: Date } };
      create: { branchId: string; businessDate: Date; nextNumber: number };
      update: { nextNumber: { increment: number } };
      select: { nextNumber: true };
    }) => {
      const { branchId, businessDate } = args.where.branchId_businessDate;
      const key = `${branchId}|${businessDate.toISOString()}`;
      if (store.has(key)) {
        store.set(key, store.get(key)! + args.update.nextNumber.increment);
      } else {
        store.set(key, args.create.nextNumber);
      }
      return { nextNumber: store.get(key)! };
    }
  );
  const tx = {
    restaurantReceiptNumberSequence: { upsert },
  } as unknown as ReceiptNumberSequenceClient;
  return { tx, upsert };
}

const DATE_A = new Date('2026-08-19T00:00:00.000Z');
const DATE_B = new Date('2026-08-20T00:00:00.000Z');

describe('allocateReceiptNumber', () => {
  it('returns 1 for the first receipt of a (branch, businessDate)', async () => {
    const { tx } = makeTx();
    expect(await allocateReceiptNumber(tx, { branchId: 'branch-1', businessDate: DATE_A })).toBe(1);
  });

  it('increments monotonically for the same (branch, businessDate)', async () => {
    const { tx } = makeTx();
    const numbers: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      numbers.push(await allocateReceiptNumber(tx, { branchId: 'branch-1', businessDate: DATE_A }));
    }
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps independent receipt sequences per branch', async () => {
    const { tx } = makeTx();
    expect(await allocateReceiptNumber(tx, { branchId: 'branch-1', businessDate: DATE_A })).toBe(1);
    expect(await allocateReceiptNumber(tx, { branchId: 'branch-2', businessDate: DATE_A })).toBe(1);
    expect(await allocateReceiptNumber(tx, { branchId: 'branch-1', businessDate: DATE_A })).toBe(2);
    expect(await allocateReceiptNumber(tx, { branchId: 'branch-2', businessDate: DATE_A })).toBe(2);
  });

  it('starts a fresh receipt sequence for a new business date on the same branch', async () => {
    const { tx } = makeTx();
    expect(await allocateReceiptNumber(tx, { branchId: 'branch-1', businessDate: DATE_A })).toBe(1);
    expect(await allocateReceiptNumber(tx, { branchId: 'branch-1', businessDate: DATE_A })).toBe(2);
    expect(await allocateReceiptNumber(tx, { branchId: 'branch-1', businessDate: DATE_B })).toBe(1);
  });

  it('issues the exact atomic upsert (composite where, create=1, increment=1, no organizationId)', async () => {
    const { tx, upsert } = makeTx();
    await allocateReceiptNumber(tx, { branchId: 'branch-1', businessDate: DATE_A });
    expect(upsert).toHaveBeenCalledTimes(1);
    const args = upsert.mock.calls[0]![0];
    expect(args.where).toEqual({
      branchId_businessDate: { branchId: 'branch-1', businessDate: DATE_A },
    });
    expect(args.create).toEqual({ branchId: 'branch-1', businessDate: DATE_A, nextNumber: 1 });
    expect(args.update).toEqual({ nextNumber: { increment: 1 } });
    // organizationId is DB-defaulted from the tenant setting; never sent by the caller.
    expect(args.create).not.toHaveProperty('organizationId');
    expect(args.select).toEqual({ nextNumber: true });
  });
});
