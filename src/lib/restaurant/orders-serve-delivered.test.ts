import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const appendOrderEvent = vi.hoisted(() => vi.fn());
vi.mock('./outbox', () => ({ appendOrderEvent }));

import { serveDeliveredOrderItems } from './orders';

function txFor(status: string, items: Array<{ id: string; status: string }>) {
  const updateMany = vi.fn().mockResolvedValue({ count: items.length });
  const tx = {
    restaurantOrder: {
      findUnique: vi.fn().mockResolvedValue({ id: 'order-1', status, items }),
      update: vi.fn(),
    },
    restaurantOrderItem: {
      updateMany,
      findMany: vi.fn().mockResolvedValue(items.map(() => ({ status: 'SERVED' }))),
    },
  };
  return { tx: tx as never, updateMany };
}

describe('serveDeliveredOrderItems', () => {
  beforeEach(() => appendOrderEvent.mockReset());

  it('serves live items the kitchen never marked prepared', async () => {
    const { tx, updateMany } = txFor('SENT', [
      { id: 'a', status: 'QUEUED' },
      { id: 'b', status: 'FIRING' },
      { id: 'c', status: 'PREPARED' },
      { id: 'd', status: 'SERVED' },
      { id: 'e', status: 'VOIDED' },
    ]);
    const served = await serveDeliveredOrderItems(tx, 'order-1', {
      staffProfileId: 's',
      deviceId: 'd',
    });
    expect(served).toEqual(['a', 'b', 'c']);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'SERVED' } })
    );
    expect(appendOrderEvent).toHaveBeenCalledTimes(3);
    expect(appendOrderEvent.mock.calls[0]![1].payload).toMatchObject({
      itemId: 'a',
      from: 'QUEUED',
      to: 'SERVED',
    });
  });

  it('leaves a terminal order untouched', async () => {
    const { tx, updateMany } = txFor('CLOSED', [{ id: 'a', status: 'QUEUED' }]);
    expect(
      await serveDeliveredOrderItems(tx, 'order-1', { staffProfileId: null, deviceId: null })
    ).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
