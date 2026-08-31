import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  DeliveryError,
  createDeliveryZone,
  normalizeDeliveryPhone,
  quoteDeliveryZone,
  transitionDeliveryFulfillment,
} from './delivery';

describe('delivery domain validation', () => {
  it('normalizes common E.164 presentation without inventing a country code', () => {
    expect(normalizeDeliveryPhone(' +92 (300) 123-4567 ')).toBe('+923001234567');
    expect(() => normalizeDeliveryPhone('03001234567')).toThrowError(
      expect.objectContaining({ reason: 'INVALID_INPUT' })
    );
  });

  it('validates and persists server-owned zone configuration', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'zone-1' });
    const db = { restaurantDeliveryZone: { create } } as never;
    await createDeliveryZone(db, {
      organizationId: 'org-1',
      branchId: 'branch-1',
      name: ' Central ',
      fixedFee: '250.00',
      minimumSubtotal: '1000.00',
      promisedMinutes: 45,
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        branchId: 'branch-1',
        name: 'Central',
        promisedMinutes: 45,
      }),
    });
    expect(() =>
      createDeliveryZone(db, {
        organizationId: 'org-1',
        branchId: 'branch-1',
        name: 'Invalid',
        fixedFee: '-0.01',
        promisedMinutes: 30,
      })
    ).toThrowError(expect.objectContaining({ reason: 'INVALID_INPUT' }));
  });

  it('quotes only an active same-branch zone and enforces its minimum', async () => {
    const zone = {
      id: 'zone-1',
      name: 'Central',
      areaPostalLabel: 'Zone A',
      fixedFee: '250.00',
      minimumSubtotal: '1000.00',
      promisedMinutes: 45,
    };
    const findFirst = vi.fn().mockResolvedValue(zone);
    const db = { restaurantDeliveryZone: { findFirst } } as never;
    await expect(
      quoteDeliveryZone(db, {
        organizationId: 'org-1',
        branchId: 'branch-1',
        zoneId: 'zone-1',
        subtotal: '999.99',
      })
    ).rejects.toMatchObject({ reason: 'MINIMUM_SUBTOTAL' });
    await expect(
      quoteDeliveryZone(db, {
        organizationId: 'org-1',
        branchId: 'branch-1',
        zoneId: 'zone-1',
        subtotal: '1000.00',
      })
    ).resolves.toMatchObject({ fixedFee: '250.00', promisedMinutes: 45 });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'zone-1', organizationId: 'org-1', branchId: 'branch-1', active: true },
    });
  });
});

describe('delivery fulfillment transitions', () => {
  const dbFor = (currentStatus: string) => {
    const update = vi.fn().mockImplementation(({ data }) => Promise.resolve(data));
    const findFirstOrThrow = vi.fn().mockResolvedValue({ status: currentStatus });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ status: currentStatus }]),
      restaurantDeliveryFulfillment: { update, findFirstOrThrow },
    };
    return {
      db: { $transaction: (work: (value: typeof tx) => unknown) => work(tx) } as never,
      update,
      findFirstOrThrow,
    };
  };

  it('sets one consistent timestamp and accepts an exact replay', async () => {
    const at = new Date('2026-08-31T12:00:00.000Z');
    const pending = dbFor('PENDING');
    await transitionDeliveryFulfillment(pending.db, {
      organizationId: 'org-1',
      branchId: 'branch-1',
      fulfillmentId: 'ful-1',
      status: 'DISPATCHED',
      now: at,
    });
    expect(pending.update).toHaveBeenCalledWith({
      where: { id: 'ful-1' },
      data: { status: 'DISPATCHED', dispatchedAt: at },
    });

    const replay = dbFor('DISPATCHED');
    await transitionDeliveryFulfillment(replay.db, {
      organizationId: 'org-1',
      branchId: 'branch-1',
      fulfillmentId: 'ful-1',
      status: 'DISPATCHED',
      now: new Date(),
    });
    expect(replay.update).not.toHaveBeenCalled();
    expect(replay.findFirstOrThrow).toHaveBeenCalledOnce();
  });

  it.each([
    ['PENDING', 'DELIVERED'],
    ['DELIVERED', 'CANCELLED'],
    ['CANCELLED', 'FAILED'],
    ['FAILED', 'DISPATCHED'],
  ] as const)('rejects %s -> %s', async (from, to) => {
    const state = dbFor(from);
    await expect(
      transitionDeliveryFulfillment(state.db, {
        organizationId: 'org-1',
        branchId: 'branch-1',
        fulfillmentId: 'ful-1',
        status: to,
      })
    ).rejects.toBeInstanceOf(DeliveryError);
    expect(state.update).not.toHaveBeenCalled();
  });
});
