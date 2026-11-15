import { describe, expect, it, vi } from 'vitest';

import { createHash } from 'node:crypto';

vi.mock('server-only', () => ({}));

const { serveDeliveredOrderItems } = vi.hoisted(() => ({
  serveDeliveredOrderItems: vi.fn(),
}));
vi.mock('./orders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./orders')>()),
  serveDeliveredOrderItems,
}));

import { Prisma } from '@/generated/prisma/client';

import { OrderCommandError } from './orders';
import {
  DeliveryError,
  createDeliveryFulfillment,
  createDeliveryZone,
  normalizeDeliveryPhone,
  quoteDeliveryZone,
  reactivateDeliveryZone,
  transitionDeliveryFulfillment,
} from './delivery';

function deliveryAttachCommand(input: {
  orderId: string;
  customerId: string;
  addressId: string;
  zoneId: string;
  instructions?: string | null;
}) {
  const canonicalPayload = JSON.stringify({
    orderId: input.orderId,
    customerId: input.customerId,
    addressId: input.addressId,
    zoneId: input.zoneId,
    instructions: input.instructions?.trim() || null,
  });
  return `delivery.attach:v1:${createHash('sha256').update(canonicalPayload, 'utf8').digest('hex')}`;
}

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

  it('reactivates a zone only within its tenant and branch', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = { restaurantDeliveryZone: { updateMany } } as never;

    await reactivateDeliveryZone(db, {
      organizationId: 'org-1',
      branchId: 'branch-1',
      zoneId: 'zone-1',
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'zone-1', organizationId: 'org-1', branchId: 'branch-1' },
      data: { active: true },
    });
  });
});

describe('delivery payment authority', () => {
  it.each(['COD', 'PREPAID'] as const)(
    'ignores malicious caller-supplied %s and persists unresolved mode at attach',
    async (suppliedMode) => {
      const create = vi.fn().mockImplementation(({ data }) => Promise.resolve(data));
      const createIdempotency = vi.fn().mockResolvedValue({});
      const tx = {
        restaurantOrderIdempotencyKey: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: createIdempotency,
          update: vi.fn().mockResolvedValue({}),
        },
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'order-1' }]),
        restaurantOrder: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'order-1',
            items: [
              {
                unitPrice: new Prisma.Decimal('1250.00'),
                quantity: 1,
                modifiers: [],
              },
            ],
            bills: [],
          }),
        },
        restaurantCustomerAddress: {
          findFirst: vi.fn().mockResolvedValue({
            recipientName: 'Customer',
            normalizedPhone: '+923001234567',
            addressLine1: '1 Main Street',
            addressLine2: null,
            locality: 'Karachi',
            administrativeArea: null,
            postalCode: null,
            countryCode: 'PK',
            latitude: null,
            longitude: null,
          }),
        },
        restaurantDeliveryZone: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'zone-1',
            name: 'Central',
            areaPostalLabel: null,
            fixedFee: new Prisma.Decimal('250.00'),
            minimumSubtotal: new Prisma.Decimal('1000.00'),
            promisedMinutes: 45,
          }),
        },
        restaurantDeliveryFulfillment: { create },
      };
      const db = { $transaction: (work: (value: typeof tx) => unknown) => work(tx) } as never;

      await createDeliveryFulfillment(db, {
        organizationId: 'org-1',
        branchId: 'branch-1',
        customerId: 'customer-1',
        orderId: 'order-1',
        addressId: 'address-1',
        zoneId: 'zone-1',
        deviceId: 'device-1',
        idempotencyKey: 'attach-1',
        paymentMode: suppliedMode,
        now: new Date('2026-08-31T12:00:00.000Z'),
      } as Parameters<typeof createDeliveryFulfillment>[1] & { paymentMode: string });

      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({ paymentMode: null }),
      });
      const durableMetadata = JSON.stringify(createIdempotency.mock.calls[0]?.[0]);
      expect(durableMetadata).toMatch(/delivery\.attach:v1:[0-9a-f]{64}/);
      expect(durableMetadata).not.toContain('customer-1');
      expect(durableMetadata).not.toContain('address-1');
      expect(durableMetadata).not.toContain('zone-1');
    }
  );

  it('returns the committed fulfillment on an exact lost-response retry without creating again', async () => {
    const committed = {
      id: 'fulfillment-1',
      orderId: 'order-1',
      deliveryFeeSnapshot: new Prisma.Decimal('250.00'),
    };
    const findUnique = vi.fn().mockResolvedValue({
      commandType: deliveryAttachCommand({
        orderId: 'order-1',
        customerId: 'customer-1',
        addressId: 'address-1',
        zoneId: 'zone-1',
        instructions: 'Gate 2',
      }),
      resultRef: 'fulfillment-1',
    });
    const findFirst = vi.fn().mockResolvedValue(committed);
    const create = vi.fn();
    const tx = {
      restaurantOrderIdempotencyKey: { findUnique, create },
      restaurantDeliveryFulfillment: { findFirst },
    };
    const db = { $transaction: (work: (value: typeof tx) => unknown) => work(tx) } as never;

    await expect(
      createDeliveryFulfillment(db, {
        organizationId: 'org-1',
        branchId: 'branch-1',
        customerId: 'customer-1',
        orderId: 'order-1',
        addressId: 'address-1',
        zoneId: 'zone-1',
        instructions: ' Gate 2 ',
        deviceId: 'device-1',
        idempotencyKey: 'attach-1',
      })
    ).resolves.toBe(committed);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'fulfillment-1',
        organizationId: 'org-1',
        branchId: 'branch-1',
        orderId: 'order-1',
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a reused key with a different canonical delivery payload', async () => {
    const tx = {
      restaurantOrderIdempotencyKey: {
        findUnique: vi.fn().mockResolvedValue({
          commandType: deliveryAttachCommand({
            orderId: 'order-1',
            customerId: 'customer-1',
            addressId: 'address-1',
            zoneId: 'zone-1',
          }),
          resultRef: 'fulfillment-1',
        }),
        create: vi.fn(),
      },
      restaurantDeliveryFulfillment: { findFirst: vi.fn() },
    };
    const db = { $transaction: (work: (value: typeof tx) => unknown) => work(tx) } as never;

    await expect(
      createDeliveryFulfillment(db, {
        organizationId: 'org-1',
        branchId: 'branch-1',
        customerId: 'customer-1',
        orderId: 'order-1',
        addressId: 'address-2',
        zoneId: 'zone-1',
        deviceId: 'device-1',
        idempotencyKey: 'attach-1',
      })
    ).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
    expect(tx.restaurantDeliveryFulfillment.findFirst).not.toHaveBeenCalled();
    expect(tx.restaurantOrderIdempotencyKey.create).not.toHaveBeenCalled();
  });
});

describe('delivery fulfillment transitions', () => {
  const dbFor = (
    currentStatus: string,
    bills = [
      {
        status: 'SETTLED',
        grandTotal: new Prisma.Decimal('12.00'),
        tenders: [{ amount: new Prisma.Decimal('12.00') }],
      },
    ]
  ) => {
    const update = vi.fn().mockImplementation(({ data }) => Promise.resolve(data));
    const findFirstOrThrow = vi.fn().mockResolvedValue({ status: currentStatus });
    const queryRaw = vi.fn().mockImplementation((query: Prisma.Sql) =>
      Promise.resolve(
        query.sql.startsWith('SELECT "status", "orderId", "paymentMode"')
          ? [
              {
                status: currentStatus,
                orderId: 'order-1',
                paymentMode: currentStatus === 'PENDING' ? null : 'PREPAID',
              },
            ]
          : []
      )
    );
    const tx = {
      $queryRaw: queryRaw,
      restaurantBill: { findMany: vi.fn().mockResolvedValue(bills) },
      restaurantDeliveryFulfillment: { update, findFirstOrThrow },
    };
    return {
      db: { $transaction: (work: (value: typeof tx) => unknown) => work(tx) } as never,
      update,
      findFirstOrThrow,
      queryRaw,
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
    expect(pending.queryRaw).toHaveBeenCalledTimes(2);
    expect(pending.update).toHaveBeenCalledWith({
      where: { id: 'ful-1' },
      data: { status: 'DISPATCHED', paymentMode: 'PREPAID', dispatchedAt: at },
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

  it('derives COD only for all-open zero-tender bills', async () => {
    const at = new Date('2026-08-31T12:00:00.000Z');
    const pending = dbFor('PENDING', [
      { status: 'OPEN', grandTotal: new Prisma.Decimal('5.00'), tenders: [] },
      { status: 'OPEN', grandTotal: new Prisma.Decimal('7.00'), tenders: [] },
    ]);
    await transitionDeliveryFulfillment(pending.db, {
      organizationId: 'org-1',
      branchId: 'branch-1',
      fulfillmentId: 'ful-1',
      status: 'DISPATCHED',
      now: at,
    });
    expect(pending.update).toHaveBeenCalledWith({
      where: { id: 'ful-1' },
      data: { status: 'DISPATCHED', paymentMode: 'COD', dispatchedAt: at },
    });
  });

  it.each([
    { bills: [] },
    {
      bills: [
        {
          status: 'OPEN',
          grandTotal: new Prisma.Decimal('12.00'),
          tenders: [{ amount: new Prisma.Decimal('1.00') }],
        },
      ],
    },
    {
      bills: [
        {
          status: 'SETTLED',
          grandTotal: new Prisma.Decimal('5.00'),
          tenders: [{ amount: new Prisma.Decimal('5.00') }],
        },
        { status: 'OPEN', grandTotal: new Prisma.Decimal('7.00'), tenders: [] },
      ],
    },
    {
      bills: [
        {
          status: 'SETTLED',
          grandTotal: new Prisma.Decimal('12.00'),
          tenders: [{ amount: new Prisma.Decimal('13.00') }],
        },
      ],
    },
  ])('rejects zero, partial, mixed, and over-covered live bill states', async ({ bills }) => {
    const pending = dbFor('PENDING', bills);
    await expect(
      transitionDeliveryFulfillment(pending.db, {
        organizationId: 'org-1',
        branchId: 'branch-1',
        fulfillmentId: 'ful-1',
        status: 'DISPATCHED',
      })
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSITION' });
    expect(pending.update).not.toHaveBeenCalled();
  });

  it('serves the order once, in the same transaction, when the delivery is delivered', async () => {
    serveDeliveredOrderItems.mockReset().mockResolvedValue(['item-1']);
    const at = new Date('2026-08-31T12:30:00.000Z');
    const dispatched = dbFor('DISPATCHED');
    await transitionDeliveryFulfillment(dispatched.db, {
      organizationId: 'org-1',
      branchId: 'branch-1',
      fulfillmentId: 'ful-1',
      status: 'DELIVERED',
      now: at,
      actor: { staffProfileId: 'staff-1', deviceId: 'device-1' },
    });
    const lockOrder = (dispatched.queryRaw.mock.calls[0]![0] as Prisma.Sql).sql;
    expect(lockOrder).toContain('FOR UPDATE OF o');
    expect(serveDeliveredOrderItems).toHaveBeenCalledOnce();
    expect(serveDeliveredOrderItems).toHaveBeenCalledWith(expect.anything(), 'order-1', {
      staffProfileId: 'staff-1',
      deviceId: 'device-1',
    });
    expect(dispatched.update).toHaveBeenCalledWith({
      where: { id: 'ful-1' },
      data: { status: 'DELIVERED', paymentMode: 'PREPAID', deliveredAt: at },
    });

    serveDeliveredOrderItems.mockClear();
    const replay = dbFor('DELIVERED');
    await transitionDeliveryFulfillment(replay.db, {
      organizationId: 'org-1',
      branchId: 'branch-1',
      fulfillmentId: 'ful-1',
      status: 'DELIVERED',
    });
    expect(serveDeliveredOrderItems).not.toHaveBeenCalled();
    expect(replay.update).not.toHaveBeenCalled();
  });

  it('rejects the delivered hand-off while a live item is still in the kitchen', async () => {
    serveDeliveredOrderItems
      .mockReset()
      .mockRejectedValue(new OrderCommandError('Kitchen handoff is not complete.', 'ITEM_STATE'));
    const dispatched = dbFor('DISPATCHED');
    await expect(
      transitionDeliveryFulfillment(dispatched.db, {
        organizationId: 'org-1',
        branchId: 'branch-1',
        fulfillmentId: 'ful-1',
        status: 'DELIVERED',
      })
    ).rejects.toMatchObject({ name: 'DeliveryError', reason: 'INVALID_TRANSITION' });
    expect(dispatched.update).not.toHaveBeenCalled();
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
