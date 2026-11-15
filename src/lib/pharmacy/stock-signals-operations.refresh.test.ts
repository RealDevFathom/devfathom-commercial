/**
 * DEV-82 — a refresh triggered by one zone's sensor push reconciles only that
 * zone's COLD_CHAIN alerts. With no stock facts every live signal is "no longer
 * produced"; the scoped refresh must still leave another zone's cold-chain
 * alert open, while an ordinary refresh keeps closing everything it no longer
 * produces.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { refreshStockSignals } from './stock-signals-operations';

const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' };
const AT = new Date('2026-11-15T10:00:00.000Z');

const LIVE = [
  {
    id: 'sig_a',
    dedupKey: 'cold-a',
    kind: 'COLD_CHAIN',
    stockLocationId: 'fridge_a',
    status: 'OPEN',
  },
  {
    id: 'sig_b',
    dedupKey: 'cold-b',
    kind: 'COLD_CHAIN',
    stockLocationId: 'fridge_b',
    status: 'OPEN',
  },
  { id: 'sig_c', dedupKey: 'low-c', kind: 'LOW_STOCK', stockLocationId: null, status: 'OPEN' },
];

function database() {
  const update = vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  const db = {
    $queryRaw: vi.fn(async () => []),
    pharmacySafetyStock: { findMany: vi.fn(async () => []) },
    pharmacyStockMovement: { aggregate: vi.fn(async () => ({ _max: { occurredAt: null } })) },
    pharmacyStockLocation: { findMany: vi.fn(async () => []) },
    pharmacyTemperatureLog: { findMany: vi.fn(async () => []) },
    pharmacyStockSignal: { findMany: vi.fn(async () => LIVE), update, create: vi.fn() },
    pharmacyStockSignalEvent: { create: vi.fn(async () => ({})) },
  };
  return { db: db as unknown as ScopedDb, update };
}

const closedIds = (update: ReturnType<typeof database>['update']) =>
  update.mock.calls.map(([args]) => args.where.id).sort();

describe('refreshStockSignals cold-chain scoping (DEV-82)', () => {
  it('closes every signal it no longer produces on an ordinary refresh', async () => {
    const { db, update } = database();
    const result = await refreshStockSignals(db, scope, AT);
    expect(result.closed).toBe(3);
    expect(closedIds(update)).toEqual(['sig_a', 'sig_b', 'sig_c']);
  });

  it("keeps another zone's cold-chain alert open on a sensor-triggered refresh", async () => {
    const { db, update } = database();
    const result = await refreshStockSignals(db, scope, AT, undefined, {
      closeColdChainOnlyAt: 'fridge_a',
    });
    expect(result.closed).toBe(2);
    expect(closedIds(update)).toEqual(['sig_a', 'sig_c']);
  });
});
