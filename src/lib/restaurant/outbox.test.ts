import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_OUTBOX_RETRY_POLICY,
  ORDER_AGGREGATE_TYPE,
  OUTBOX_STATUS,
  type OrderEventOutboxClient,
  type OutboxRecord,
  appendOrderEvent,
  backoffDelayMs,
  planDispatchFailure,
  planDispatchSuccess,
} from './outbox';

function makeTx() {
  const events: Array<{ orderId: string; sequence: number }> = [];
  const outboxCreates: Array<Record<string, unknown>> = [];
  let eventId = 0;
  let outboxId = 0;
  const findFirst = vi.fn(async ({ where: { orderId } }: { where: { orderId: string } }) => {
    const forOrder = events
      .filter((event) => event.orderId === orderId)
      .sort((a, b) => b.sequence - a.sequence);
    return forOrder[0] ? { sequence: forOrder[0].sequence } : null;
  });
  const createEvent = vi.fn(async ({ data }: { data: { orderId: string; sequence: number } }) => {
    events.push({ orderId: data.orderId, sequence: data.sequence });
    eventId += 1;
    return { id: `event-${eventId}` };
  });
  const createOutbox = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    outboxCreates.push(data);
    outboxId += 1;
    return { id: `outbox-${outboxId}` };
  });
  const tx = {
    restaurantOrderEvent: { findFirst, create: createEvent },
    restaurantEventOutbox: { create: createOutbox },
  } as unknown as OrderEventOutboxClient;
  return { tx, findFirst, createEvent, createOutbox, outboxCreates };
}

describe('appendOrderEvent — ledger + outbox in one transaction (C2)', () => {
  it('assigns sequence 1 to the first event of an order and writes both rows', async () => {
    const { tx, createEvent, createOutbox } = makeTx();
    const result = await appendOrderEvent(tx, {
      orderId: 'order-1',
      eventType: 'order.opened',
      actorStaffProfileId: 'staff-1',
      actorDeviceId: 'device-1',
      payload: { channel: 'DINE_IN' },
    });

    expect(result).toEqual({ eventId: 'event-1', sequence: 1, outboxId: 'outbox-1' });
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createOutbox).toHaveBeenCalledTimes(1);
    expect(createEvent.mock.calls[0]![0].data).toMatchObject({
      orderId: 'order-1',
      sequence: 1,
      eventType: 'order.opened',
      actorStaffProfileId: 'staff-1',
      actorDeviceId: 'device-1',
      payload: { channel: 'DINE_IN' },
    });
  });

  it('advertises the event on the outbox as PENDING for the order aggregate', async () => {
    const { tx, outboxCreates } = makeTx();
    await appendOrderEvent(tx, {
      orderId: 'order-9',
      eventType: 'item.fired',
      payload: { itemId: 'item-1' },
    });
    expect(outboxCreates[0]).toMatchObject({
      eventType: 'item.fired',
      aggregateType: ORDER_AGGREGATE_TYPE,
      aggregateId: 'order-9',
      payload: { itemId: 'item-1' },
      status: OUTBOX_STATUS.PENDING,
    });
    // organizationId is DB-defaulted from the tenant setting; never sent.
    expect(outboxCreates[0]).not.toHaveProperty('organizationId');
  });

  it('monotonically increases the per-order sequence across appends', async () => {
    const { tx } = makeTx();
    const first = await appendOrderEvent(tx, { orderId: 'o', eventType: 'a', payload: {} });
    const second = await appendOrderEvent(tx, { orderId: 'o', eventType: 'b', payload: {} });
    const third = await appendOrderEvent(tx, { orderId: 'o', eventType: 'c', payload: {} });
    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
  });

  it('keeps per-order sequences independent', async () => {
    const { tx } = makeTx();
    expect(
      (await appendOrderEvent(tx, { orderId: 'A', eventType: 'x', payload: {} })).sequence
    ).toBe(1);
    expect(
      (await appendOrderEvent(tx, { orderId: 'B', eventType: 'x', payload: {} })).sequence
    ).toBe(1);
    expect(
      (await appendOrderEvent(tx, { orderId: 'A', eventType: 'y', payload: {} })).sequence
    ).toBe(2);
  });

  it('defaults actor references to null for a system-originated event', async () => {
    const { tx, createEvent } = makeTx();
    await appendOrderEvent(tx, { orderId: 'o', eventType: 'system.reconciled', payload: {} });
    expect(createEvent.mock.calls[0]![0].data).toMatchObject({
      actorStaffProfileId: null,
      actorDeviceId: null,
    });
  });
});

describe('outbox dispatch retry planning (pure)', () => {
  const at = new Date('2026-08-19T12:00:00.000Z');

  it('a successful dispatch marks the row DISPATCHED and unscheduled', () => {
    const record: OutboxRecord = { id: 'o', status: 'PENDING', attempts: 2, nextAttemptAt: at };
    expect(planDispatchSuccess(record)).toEqual({
      status: OUTBOX_STATUS.DISPATCHED,
      attempts: 3,
      nextAttemptAt: null,
      lastError: null,
    });
  });

  it('a failure reschedules with exponential backoff while attempts remain', () => {
    const record: OutboxRecord = { id: 'o', status: 'PENDING', attempts: 0, nextAttemptAt: null };
    const patch = planDispatchFailure(record, at, 'connection refused');
    expect(patch.status).toBe(OUTBOX_STATUS.PENDING);
    expect(patch.attempts).toBe(1);
    expect(patch.lastError).toBe('connection refused');
    // baseDelay 1000ms before the first retry.
    expect(patch.nextAttemptAt).toEqual(new Date(at.getTime() + 1_000));
  });

  it('backoff grows exponentially and is capped', () => {
    const policy = DEFAULT_OUTBOX_RETRY_POLICY;
    expect(backoffDelayMs(1, policy)).toBe(1_000);
    expect(backoffDelayMs(2, policy)).toBe(2_000);
    expect(backoffDelayMs(3, policy)).toBe(4_000);
    expect(backoffDelayMs(100, policy)).toBe(policy.maxDelayMs);
  });

  it('dead-letters the row once attempts reach the max', () => {
    const record: OutboxRecord = {
      id: 'o',
      status: 'PENDING',
      attempts: DEFAULT_OUTBOX_RETRY_POLICY.maxAttempts - 1,
      nextAttemptAt: at,
    };
    const patch = planDispatchFailure(record, at, 'still failing');
    expect(patch.status).toBe(OUTBOX_STATUS.DEAD);
    expect(patch.attempts).toBe(DEFAULT_OUTBOX_RETRY_POLICY.maxAttempts);
    expect(patch.nextAttemptAt).toBeNull();
  });
});
