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

const actor = { staffProfileId: 's', deviceId: 'd' };

describe('serveDeliveredOrderItems', () => {
  beforeEach(() => appendOrderEvent.mockReset());

  it('serves received items the kitchen never marked prepared (normal case)', async () => {
    const { tx, updateMany } = txFor('SENT', [
      { id: 'a', status: 'QUEUED' },
      { id: 'b', status: 'FIRING' },
      { id: 'c', status: 'PREPARED' },
      { id: 'd', status: 'SERVED' },
      { id: 'e', status: 'VOIDED' },
    ]);
    const served = await serveDeliveredOrderItems(tx, 'order-1', actor);
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

  it.each([
    ['an unsent item', 'HELD'],
    ['an item added after dispatch (unsent)', 'HELD'],
    ['a remake-requested item', 'REMAKE_REQUESTED'],
  ])('refuses the hand-off while %s remains and serves nothing', async (_label, status) => {
    const { tx, updateMany } = txFor('SENT', [
      { id: 'a', status: 'PREPARED' },
      { id: 'b', status },
    ]);
    await expect(serveDeliveredOrderItems(tx, 'order-1', actor)).rejects.toMatchObject({
      reason: 'ITEM_STATE',
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(appendOrderEvent).not.toHaveBeenCalled();
  });

  it('leaves a terminal order untouched', async () => {
    const { tx, updateMany } = txFor('CLOSED', [{ id: 'a', status: 'HELD' }]);
    expect(await serveDeliveredOrderItems(tx, 'order-1', actor)).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
