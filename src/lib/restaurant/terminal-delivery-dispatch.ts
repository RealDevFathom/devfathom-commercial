import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import { readJson } from '@/lib/api-json';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { DeliveryError, transitionDeliveryFulfillment } from './delivery';
import { requireKdsStation } from './kds';
import { lockRestaurantOrder } from './orders';
import { withTerminalAuth } from './terminal-auth';
import {
  idempotencyKeyFromRequest,
  invalidBody,
  missingIdempotencyKey,
  requireActingOperator,
} from './terminal-orders';

type BillFact = {
  status: 'OPEN' | 'SETTLED' | 'VOID';
  grandTotal: Prisma.Decimal;
  tenders: readonly { amount: Prisma.Decimal }[];
};

type ItemFact = { status: string };

export type DispatchAssessment = {
  paymentMode: 'PREPAID' | 'COD' | null;
  dispatchable: boolean;
  rejection: string | null;
};

/** Pure projection used by the queue. The command re-derives payment under locks. */
export function assessDeliveryDispatch(
  status: 'PENDING' | 'DISPATCHED' | 'DELIVERED' | 'CANCELLED' | 'FAILED',
  storedPaymentMode: 'PREPAID' | 'COD' | null,
  items: readonly ItemFact[],
  bills: readonly BillFact[]
): DispatchAssessment {
  if (status !== 'PENDING') {
    return { paymentMode: storedPaymentMode, dispatchable: false, rejection: null };
  }

  const liveItems = items.filter((item) => item.status !== 'VOIDED');
  const unready = liveItems.some((item) => !['PREPARED', 'SERVED'].includes(item.status));
  if (liveItems.length === 0 || unready) {
    return {
      paymentMode: null,
      dispatchable: false,
      rejection: 'Kitchen handoff is not ready. Prepare every live item before dispatch.',
    };
  }

  const live = bills.filter((bill) => bill.status !== 'VOID');
  if (live.length === 0) {
    return {
      paymentMode: null,
      dispatchable: false,
      rejection: 'Create a live bill before dispatch.',
    };
  }
  const prepaid = live.every(
    (bill) =>
      bill.status === 'SETTLED' &&
      bill.tenders.length > 0 &&
      bill.tenders
        .reduce((sum, tender) => sum.plus(tender.amount), new Prisma.Decimal(0))
        .equals(bill.grandTotal)
  );
  if (prepaid) return { paymentMode: 'PREPAID', dispatchable: true, rejection: null };

  const cod = live.every((bill) => bill.status === 'OPEN' && bill.tenders.length === 0);
  if (cod) return { paymentMode: 'COD', dispatchable: true, rejection: null };

  return {
    paymentMode: null,
    dispatchable: false,
    rejection:
      'Resolve partial or mixed payment: settle every live bill with exact tender coverage, or leave every live bill open and untendered for COD.',
  };
}

export async function readDeliveryHandoffQueue(db: ScopedDb, branchId: string) {
  const rows = await db.restaurantDeliveryFulfillment.findMany({
    where: { branchId, status: { in: ['PENDING', 'DISPATCHED'] } },
    orderBy: [{ promisedAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      status: true,
      paymentMode: true,
      recipientNameSnapshot: true,
      localitySnapshot: true,
      zoneAreaPostalLabelSnapshot: true,
      zoneNameSnapshot: true,
      deliveryFeeSnapshot: true,
      promisedAt: true,
      updatedAt: true,
      order: {
        select: {
          orderNumber: true,
          items: { select: { status: true } },
          bills: {
            select: {
              status: true,
              grandTotal: true,
              tenders: { select: { amount: true } },
            },
          },
        },
      },
    },
  });

  return rows.map((row) => ({
    fulfillmentId: row.id,
    orderNumber: row.order.orderNumber,
    status: row.status,
    customerName: row.recipientNameSnapshot,
    addressLabel: row.zoneAreaPostalLabelSnapshot ?? row.zoneNameSnapshot,
    locality: row.localitySnapshot,
    promisedAt: row.promisedAt,
    deliveryFee: row.deliveryFeeSnapshot.toString(),
    updatedAt: row.updatedAt,
    ...assessDeliveryDispatch(row.status, row.paymentMode, row.order.items, row.order.bills),
  }));
}

export const deliveryTransitionBody = z
  .object({
    fulfillmentId: z.string().min(1),
    status: z.enum(['DISPATCHED', 'DELIVERED']),
    operatorStaffProfileId: z.string().min(1),
  })
  .strict();

export function deliveryErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof DeliveryError)) return null;
  const status = error.reason === 'NOT_FOUND' ? 404 : error.reason === 'INVALID_INPUT' ? 400 : 409;
  return NextResponse.json({ error: error.message }, { status });
}

type DeliveryTransitionResult = {
  fulfillmentId: string;
  status: 'DISPATCHED' | 'DELIVERED';
  paymentMode: 'PREPAID' | 'COD' | null;
};

function transaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

/** Device-scoped, payload-bound KDS transition with an immutable replay result. */
export function transitionDeliveryFromKds(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    deviceId: string;
    idempotencyKey: string;
    fulfillmentId: string;
    status: 'DISPATCHED' | 'DELIVERED';
    /** The acting operator recorded on the order events a DELIVERED hand-off writes. */
    staffProfileId?: string;
  }
): Promise<DeliveryTransitionResult> {
  return transaction(db, async (tx) => {
    const commandType = `delivery.transition:${input.fulfillmentId}:${input.status}`;
    await tx.restaurantOrderIdempotencyKey.createMany({
      data: [{ deviceId: input.deviceId, key: input.idempotencyKey, commandType }],
      skipDuplicates: true,
    });
    const [claim] = await tx.$queryRaw<Array<{ commandType: string; resultRef: string | null }>>(
      Prisma.sql`SELECT "commandType", "resultRef" FROM "restaurant_order_idempotency_keys" WHERE "deviceId" = ${input.deviceId} AND "key" = ${input.idempotencyKey} FOR UPDATE`
    );
    if (!claim || claim.commandType !== commandType) {
      throw new DeliveryError(
        'This idempotency key is already bound to a different delivery transition.',
        'INVALID_TRANSITION'
      );
    }
    if (claim.resultRef) return JSON.parse(claim.resultRef) as DeliveryTransitionResult;

    const fulfillment = await tx.restaurantDeliveryFulfillment.findFirst({
      where: { id: input.fulfillmentId, branchId: input.branchId },
      select: { orderId: true },
    });
    if (!fulfillment) throw new DeliveryError('Delivery fulfillment does not exist.', 'NOT_FOUND');

    await lockRestaurantOrder(tx, fulfillment.orderId);
    const current = await tx.restaurantDeliveryFulfillment.findFirst({
      where: { id: input.fulfillmentId, branchId: input.branchId },
      select: { status: true, orderId: true },
    });
    if (!current) throw new DeliveryError('Delivery fulfillment does not exist.', 'NOT_FOUND');

    if (input.status === 'DISPATCHED' && current.status === 'PENDING') {
      const items = await tx.restaurantOrderItem.findMany({
        where: { orderId: current.orderId, status: { not: 'VOIDED' } },
        orderBy: { id: 'asc' },
        select: { status: true },
      });
      if (
        items.length === 0 ||
        items.some((item) => !['PREPARED', 'SERVED'].includes(item.status))
      ) {
        throw new DeliveryError(
          'Kitchen handoff is not ready. Prepare every live item before dispatch.',
          'INVALID_TRANSITION'
        );
      }
    }

    const delivery = await transitionDeliveryFulfillment(tx, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      fulfillmentId: input.fulfillmentId,
      status: input.status,
      actor: input.staffProfileId
        ? { staffProfileId: input.staffProfileId, deviceId: input.deviceId }
        : null,
    });
    const result: DeliveryTransitionResult = {
      fulfillmentId: delivery.id,
      status: delivery.status as DeliveryTransitionResult['status'],
      paymentMode: delivery.paymentMode,
    };
    await tx.restaurantOrderIdempotencyKey.update({
      where: { deviceId_key: { deviceId: input.deviceId, key: input.idempotencyKey } },
      data: { resultRef: JSON.stringify(result) },
    });
    return result;
  });
}

export const deliveryQueueRoute = withTerminalAuth(async (ctx) => {
  const station = requireKdsStation(ctx.device);
  if (!station.ok) return station.response;
  const operator = requireActingOperator(ctx);
  if (!operator.ok) return operator.response;

  const deliveries = await readDeliveryHandoffQueue(ctx.db, ctx.device.branchId);
  return NextResponse.json({ serverTime: new Date().toISOString(), deliveries });
});

export const deliveryTransitionRoute = withTerminalAuth(
  async (ctx, request) => {
    const station = requireKdsStation(ctx.device);
    if (!station.ok) return station.response;
    const operator = requireActingOperator(ctx);
    if (!operator.ok) return operator.response;

    const key = idempotencyKeyFromRequest(request);
    if (!key) return missingIdempotencyKey();
    const parsedJson = await readJson(request);
    if (!parsedJson.ok) return parsedJson.response;
    const parsed = deliveryTransitionBody.safeParse(parsedJson.data);
    if (!parsed.success) return invalidBody(parsed.error.issues);
    if (parsed.data.operatorStaffProfileId !== operator.staffProfileId) {
      return NextResponse.json(
        { error: 'Acting operator does not match the session.' },
        { status: 403 }
      );
    }

    const delivery = await transitionDeliveryFromKds(ctx.db, {
      organizationId: ctx.organizationId,
      branchId: ctx.device.branchId,
      deviceId: ctx.device.id,
      idempotencyKey: key,
      fulfillmentId: parsed.data.fulfillmentId,
      status: parsed.data.status,
      staffProfileId: operator.staffProfileId,
    });
    return NextResponse.json(delivery);
  },
  { mapError: deliveryErrorResponse }
);
