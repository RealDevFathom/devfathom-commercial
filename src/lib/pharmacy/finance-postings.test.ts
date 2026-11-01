/**
 * PH-FIN / FIN-01 — the pure half of the posting adapters: the apportionment
 * that lets revenue and discount be split across a sale's lot allocations
 * without unbalancing the entry.
 *
 * The adapters themselves are database-backed and are covered in
 * `finance-postings.db.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

import { apportion, postKhataCollectionEntry } from './finance-postings';

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe('apportion — FIN-01 pro-rata split that still balances', () => {
  it('splits evenly when the weights divide the amount', () => {
    expect(apportion(1000, [1, 1])).toEqual([500, 500]);
  });

  it('splits in proportion to the weights', () => {
    expect(apportion(1000, [3, 1])).toEqual([750, 250]);
  });

  it('keeps the total exact when the split does not divide evenly', () => {
    // 1000 over three equal parts is 333.33…; dropping the remainder would
    // leave the entry short by 1 minor unit and the balance check would refuse
    // it, so the last share absorbs it.
    const shares = apportion(1000, [1, 1, 1]);
    expect(shares).toEqual([333, 333, 334]);
    expect(sum(shares)).toBe(1000);
  });

  it.each([
    [7, [3, 5, 11]],
    [1, [1, 1, 1, 1]],
    [999_983, [17, 29, 31, 37]],
    [12_345, [1, 1]],
  ])('never loses or invents money splitting %i across %j', (total, weights) => {
    expect(sum(apportion(total, weights))).toBe(total);
  });

  it('gives every share to a single allocation', () => {
    expect(apportion(4321, [9])).toEqual([4321]);
  });

  it('returns zero shares for a zero amount, so no empty leg is ever posted', () => {
    expect(apportion(0, [4, 6])).toEqual([0, 0]);
  });

  it('returns zero shares when the weights carry no quantity at all', () => {
    expect(apportion(500, [0, 0])).toEqual([0, 0]);
  });
});

describe('postKhataCollectionEntry — #380 drawer-backed receivable settlement', () => {
  const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'cashier_a' };
  const db = (movement: Record<string, unknown> | null) => ({
    pharmacyDrawerMovement: { findFirst: vi.fn().mockResolvedValue(movement) },
    financeJournalEntry: { findFirst: vi.fn(), create: vi.fn(), findFirstOrThrow: vi.fn() },
    financeJournalLine: { create: vi.fn() },
  });
  const movement = {
    id: 'movement_a',
    kind: 'PAID_IN',
    amountMinor: 250,
    drawerSession: { branchId: 'branch_a' },
  };
  const at = new Date('2026-10-29T09:00:00.000Z');

  it.each([
    ['a missing movement', null, 'NOT_FOUND'],
    [
      'another branch drawer',
      { ...movement, drawerSession: { branchId: 'branch_b' } },
      'CROSS_BRANCH_REFERENCE',
    ],
    ['a paid-out movement', { ...movement, kind: 'PAID_OUT' }, 'INVALID_STATE'],
  ])('refuses %s without writing the journal', async (_name, row, reason) => {
    const client = db(row);
    await expect(
      postKhataCollectionEntry(client as never, scope, { drawerMovementId: 'movement_a', at })
    ).rejects.toMatchObject({ reason });
    expect(client.pharmacyDrawerMovement.findFirst).toHaveBeenCalledWith({
      where: { id: 'movement_a', organizationId: 'org_a' },
      include: { drawerSession: { select: { branchId: true } } },
    });
    expect(client.financeJournalEntry.create).not.toHaveBeenCalled();
  });

  it('returns the existing entry on retry instead of posting again', async () => {
    const client = db(movement);
    const existing = { id: 'entry_a', lines: [] };
    client.financeJournalEntry.findFirst.mockResolvedValue(existing);
    await expect(
      postKhataCollectionEntry(client as never, scope, { drawerMovementId: 'movement_a', at })
    ).resolves.toBe(existing);
    expect(client.financeJournalEntry.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        idempotencyKey: 'finance:PHARMACY_KHATA_COLLECTION:movement_a',
      },
      include: { lines: true },
    });
    expect(client.financeJournalEntry.create).not.toHaveBeenCalled();
  });
});
