import { describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { DEFAULT_OUTBOX_RETRY_POLICY, backoffDelayMs } from '@/lib/restaurant/outbox';
import {
  OutboxConsumerRegistry,
  dispatchOutboxBatch,
  restaurantOutboxConsumers,
  type OutboxDispatchRecord,
} from '@/lib/restaurant/outbox-dispatcher';

// A minimal in-memory ScopedDb mirroring the exact operations dispatchOutboxBatch
// performs — the `FOR UPDATE SKIP LOCKED` due-row claim (via $queryRaw) plus
// findUnique/update — so the success / retry / dead-letter / skip / batch-bound
// paths are exercised deterministically (no DB). The DB concurrency evidence lives
// in the L1 scheduler battery.
type Row = Record<string, unknown>;

function createFakeDb(seed: Row[]) {
  const rows = new Map<string, Row>();
  for (const row of seed) rows.set(row.id as string, { ...row });

  const restaurantEventOutbox = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id);
      return row ? { ...row } : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = rows.get(where.id);
      if (!row) throw new Error(`fake update: outbox ${where.id} not found`);
      Object.assign(row, data);
      return { ...row };
    },
  };

  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    // The dispatcher's claim query interpolates `now` first, then the excluded
    // (skipped) ids — mirror that ordering to filter the in-memory set.
    $queryRaw: async (sql: { values: unknown[] }) => {
      const now = sql.values[0] as Date;
      const excluded = new Set(sql.values.slice(1) as string[]);
      const due = [...rows.values()]
        .filter(
          (row) =>
            row.status === 'PENDING' &&
            (row.nextAttemptAt == null || (row.nextAttemptAt as Date) <= now) &&
            !excluded.has(row.id as string)
        )
        .sort((a, b) => {
          const an = (a.nextAttemptAt as Date | null)?.getTime() ?? 0;
          const bn = (b.nextAttemptAt as Date | null)?.getTime() ?? 0;
          return an - bn || (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime();
        });
      return due.length ? [{ id: due[0]!.id as string }] : [];
    },
    restaurantEventOutbox,
  };

  return { db: db as unknown as ScopedDb, rows };
}

const T0 = new Date('2026-08-20T12:00:00.000Z');

function pendingRow(overrides: Row = {}): Row {
  return {
    id: 'ob_1',
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: null,
    eventType: 'order.opened',
    aggregateType: 'restaurant.order',
    aggregateId: 'order_1',
    payload: { hello: 'world' },
    lastError: null,
    createdAt: T0,
    ...overrides,
  };
}

describe('OutboxConsumerRegistry', () => {
  it('registers, resolves, and refuses a duplicate registration', () => {
    const registry = new OutboxConsumerRegistry();
    const consumer = async () => {};
    registry.register('order.opened', consumer);
    expect(registry.resolve('order.opened')).toBe(consumer);
    expect(registry.has('order.opened')).toBe(true);
    expect(registry.eventTypes()).toEqual(['order.opened']);
    expect(() => registry.register('order.opened', consumer)).toThrow(/already registered/);
    expect(() => registry.register('  ', consumer)).toThrow(/non-empty/);
  });

  it('ships EMPTY as the process-wide default (L2 registers no consumer)', () => {
    expect(restaurantOutboxConsumers.eventTypes()).toEqual([]);
  });
});

describe('dispatchOutboxBatch', () => {
  it('delivers a PENDING row to its consumer and marks it DISPATCHED', async () => {
    const { db, rows } = createFakeDb([pendingRow()]);
    const seen: OutboxDispatchRecord[] = [];
    let consumerTx: ScopedDb | undefined;
    const registry = new OutboxConsumerRegistry();
    registry.register('order.opened', async (record, tx) => {
      seen.push(record);
      consumerTx = tx;
    });

    const summary = await dispatchOutboxBatch(db, { registry, now: T0 });

    expect(summary).toEqual({ dispatched: 1, retried: 0, dead: 0, skipped: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.payload).toEqual({ hello: 'world' });
    expect(consumerTx).toBe(db);
    const row = rows.get('ob_1')!;
    expect(row.status).toBe('DISPATCHED');
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).toBeNull();
    expect(row.lastError).toBeNull();
  });

  it('re-queues a failed dispatch with exponential backoff (attempts remain)', async () => {
    const { db, rows } = createFakeDb([pendingRow()]);
    const registry = new OutboxConsumerRegistry();
    registry.register('order.opened', async () => {
      throw new Error('consumer boom');
    });

    const summary = await dispatchOutboxBatch(db, { registry, now: T0 });

    expect(summary).toEqual({ dispatched: 0, retried: 1, dead: 0, skipped: 0 });
    const row = rows.get('ob_1')!;
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect((row.nextAttemptAt as Date).getTime()).toBe(
      T0.getTime() + backoffDelayMs(1, DEFAULT_OUTBOX_RETRY_POLICY)
    );
    expect(row.lastError).toBe('consumer boom');
  });

  it('dead-letters a row once its attempt budget is spent', async () => {
    const lastAttempt = DEFAULT_OUTBOX_RETRY_POLICY.maxAttempts - 1;
    const { db, rows } = createFakeDb([pendingRow({ attempts: lastAttempt })]);
    const registry = new OutboxConsumerRegistry();
    registry.register('order.opened', async () => {
      throw new Error('still failing');
    });

    const summary = await dispatchOutboxBatch(db, { registry, now: T0 });

    expect(summary).toEqual({ dispatched: 0, retried: 0, dead: 1, skipped: 0 });
    const row = rows.get('ob_1')!;
    expect(row.status).toBe('DEAD');
    expect(row.attempts).toBe(DEFAULT_OUTBOX_RETRY_POLICY.maxAttempts);
    expect(row.nextAttemptAt).toBeNull();
  });

  it('leaves a row with no registered consumer PENDING (skipped, not dropped)', async () => {
    const { db, rows } = createFakeDb([pendingRow({ eventType: 'sop.reminder' })]);

    const summary = await dispatchOutboxBatch(db, {
      registry: new OutboxConsumerRegistry(),
      now: T0,
    });

    expect(summary).toEqual({ dispatched: 0, retried: 0, dead: 0, skipped: 1 });
    expect(rows.get('ob_1')!.status).toBe('PENDING');
    expect(rows.get('ob_1')!.attempts).toBe(0);
  });

  it('does not busy-loop on the same skipped row within one batch', async () => {
    const { db } = createFakeDb([
      pendingRow({ id: 'ob_1', eventType: 'sop.reminder' }),
      pendingRow({ id: 'ob_2', eventType: 'sop.reminder', createdAt: new Date(T0.getTime() + 1) }),
    ]);
    // Both undeliverable — the batch must terminate having skipped each exactly once.
    const summary = await dispatchOutboxBatch(db, {
      registry: new OutboxConsumerRegistry(),
      now: T0,
      batchSize: 50,
    });
    expect(summary.skipped).toBe(2);
  });

  it('honors the batch bound and only dispatches due rows', async () => {
    const future = new Date(T0.getTime() + 60_000);
    const { db, rows } = createFakeDb([
      pendingRow({ id: 'ob_1', createdAt: T0 }),
      pendingRow({ id: 'ob_2', createdAt: new Date(T0.getTime() + 1) }),
      pendingRow({ id: 'ob_3', createdAt: new Date(T0.getTime() + 2) }),
      pendingRow({ id: 'ob_future', nextAttemptAt: future, createdAt: T0 }),
    ]);
    let delivered = 0;
    const registry = new OutboxConsumerRegistry();
    registry.register('order.opened', async () => {
      delivered += 1;
    });

    const summary = await dispatchOutboxBatch(db, { registry, now: T0, batchSize: 2 });

    expect(delivered).toBe(2);
    expect(summary.dispatched).toBe(2);
    // The not-yet-due row is never touched.
    expect(rows.get('ob_future')!.status).toBe('PENDING');
  });
});
