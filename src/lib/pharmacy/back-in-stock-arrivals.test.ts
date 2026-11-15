import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  deferred: [] as Array<() => void>,
  transactions: [] as string[],
  captured: [] as string[],
  failLot: null as string | null,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/side-effects/scope', () => ({
  afterTenantTransaction: (work: () => void) => state.deferred.push(work),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (organizationId: string, run: (tx: unknown) => unknown) => {
    state.transactions.push(organizationId);
    return run({});
  },
}));
vi.mock('./sales', () => {
  class PharmacySaleError extends Error {}
  return {
    PharmacySaleError,
    captureSafeRestockArrival: async (
      _db: unknown,
      _scope: unknown,
      input: { inventoryLotId: string }
    ) => {
      if (input.inventoryLotId === state.failLot) throw new Error('reservation exceeds stock');
      state.captured.push(input.inventoryLotId);
      return [];
    },
  };
});

import { scheduleReceiptArrivalCapture } from './back-in-stock-arrivals';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };

beforeEach(() => {
  state.deferred = [];
  state.transactions = [];
  state.captured = [];
  state.failLot = null;
});

describe('DEV-79 receipt arrival capture', () => {
  it('waits for the receipt transaction to end, then captures each lot in its own transaction', async () => {
    scheduleReceiptArrivalCapture(scope, ['lot-a', 'lot-b', 'lot-a']);
    expect(state.captured).toEqual([]);
    expect(state.transactions).toEqual([]);
    expect(state.deferred).toHaveLength(1);
    state.deferred[0]!();
    await vi.waitFor(() => expect(state.captured).toEqual(['lot-a', 'lot-b']));
    expect(state.transactions).toEqual(['org-a', 'org-a']);
  });

  it('keeps going and never throws when one lot cannot be captured', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.failLot = 'lot-a';
    scheduleReceiptArrivalCapture(scope, ['lot-a', 'lot-b']);
    expect(() => state.deferred[0]!()).not.toThrow();
    await vi.waitFor(() => expect(state.captured).toEqual(['lot-b']));
    expect(error).toHaveBeenCalledWith('[back-in-stock] Arrival capture failed', {
      inventoryLotId: 'lot-a',
      error: 'Error',
    });
    error.mockRestore();
  });
});
