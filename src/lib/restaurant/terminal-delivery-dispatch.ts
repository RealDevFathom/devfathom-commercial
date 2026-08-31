import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import { readJson } from '@/lib/api-json';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { DeliveryError, transitionDeliveryFulfillment } from './delivery';
import { requireKdsStation } from './kds';
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

  const unready = items.some((item) => !['PREPARED', 'SERVED', 'VOIDED'].includes(item.status));
  if (items.length === 0 || unready) {
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

    if (parsed.data.status === 'DISPATCHED') {
      const fulfillment = await ctx.db.restaurantDeliveryFulfillment.findFirst({
        where: { id: parsed.data.fulfillmentId, branchId: ctx.device.branchId },
        select: { status: true, orderId: true },
      });
      if (!fulfillment) {
        throw new DeliveryError('Delivery fulfillment does not exist.', 'NOT_FOUND');
      }
      if (fulfillment.status === 'PENDING') {
        // Hold share locks until the surrounding terminal transaction commits, so a
        // concurrent kitchen mutation cannot regress readiness between this gate and
        // the fulfillment row transition.
        const items = await ctx.db.$queryRaw<Array<{ status: string }>>(
          Prisma.sql`SELECT "status" FROM "restaurant_order_items" WHERE "orderId" = ${fulfillment.orderId} ORDER BY "id" FOR SHARE`
        );
        if (
          items.length === 0 ||
          items.some((item) => !['PREPARED', 'SERVED', 'VOIDED'].includes(item.status))
        ) {
          throw new DeliveryError(
            'Kitchen handoff is not ready. Prepare every live item before dispatch.',
            'INVALID_TRANSITION'
          );
        }
      }
    }

    const delivery = await transitionDeliveryFulfillment(ctx.db, {
      organizationId: ctx.organizationId,
      branchId: ctx.device.branchId,
      fulfillmentId: parsed.data.fulfillmentId,
      status: parsed.data.status,
    });
    return NextResponse.json({
      fulfillmentId: delivery.id,
      status: delivery.status,
      paymentMode: delivery.paymentMode,
    });
  },
  { mapError: deliveryErrorResponse }
);
