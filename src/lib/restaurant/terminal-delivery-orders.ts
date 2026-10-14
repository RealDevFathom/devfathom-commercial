import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  createDeliveryFulfillment,
  DeliveryError,
  listDeliveryAddresses,
  listDeliveryZones,
} from './delivery';
import { connectedMutationRoute, connectedReadRoute } from './terminal-customers';
import { invalidBody } from './terminal-orders';

const ID = z.string().min(1);

export const deliveryAddressesQuery = z.object({ customerId: ID }).strict();
export const attachDeliveryBody = z
  .object({
    orderId: ID,
    customerId: ID,
    addressId: ID,
    zoneId: ID,
    instructions: z.string().trim().max(500).optional(),
  })
  .strict();

export function deliveryErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof DeliveryError)) return null;
  const status =
    error.reason === 'NOT_FOUND'
      ? 404
      : error.reason === 'INACTIVE_ZONE' ||
          error.reason === 'MINIMUM_SUBTOTAL' ||
          error.reason === 'INCONSISTENT_SCOPE' ||
          error.reason === 'ALREADY_EXISTS' ||
          error.reason === 'INVALID_TRANSITION'
        ? 409
        : 400;
  return NextResponse.json({ error: error.message, reason: error.reason }, { status });
}

export const deliveryZonesRoute = connectedReadRoute({
  capability: 'customers:read',
  run: async (ctx) => {
    const zones = await listDeliveryZones(ctx.db, ctx.organizationId, ctx.device.branchId);
    return NextResponse.json({
      zones: zones
        .filter((zone) => zone.active)
        .map((zone) => ({
          id: zone.id,
          name: zone.name,
          areaPostalLabel: zone.areaPostalLabel,
          fee: zone.fixedFee.toString(),
          minimumSubtotal: zone.minimumSubtotal.toString(),
          promisedMinutes: zone.promisedMinutes,
        })),
    });
  },
});

export const deliveryAddressesRoute = connectedReadRoute({
  capability: 'customers:read',
  mapError: deliveryErrorResponse,
  run: async (ctx, request) => {
    const parsed = deliveryAddressesQuery.safeParse(
      Object.fromEntries(new URL(request.url).searchParams)
    );
    if (!parsed.success) return invalidBody(parsed.error.issues);
    const addresses = await listDeliveryAddresses(
      ctx.db,
      ctx.organizationId,
      parsed.data.customerId
    );
    return NextResponse.json({
      addresses: addresses.map((address) => ({
        id: address.id,
        label: address.label,
        recipientName: address.recipientName,
        isDefault: address.isDefault,
      })),
    });
  },
});

export const attachDeliveryRoute = connectedMutationRoute({
  schema: attachDeliveryBody,
  capability: 'customers:read',
  additionalCapabilities: ['orders:take'],
  requireIdempotencyKey: true,
  mapError: deliveryErrorResponse,
  run: async ({ ctx, data, idempotencyKey, now }) => {
    const fulfillment = await createDeliveryFulfillment(ctx.db, {
      organizationId: ctx.organizationId,
      branchId: ctx.device.branchId,
      customerId: data.customerId,
      orderId: data.orderId,
      addressId: data.addressId,
      zoneId: data.zoneId,
      instructions: data.instructions,
      deviceId: ctx.device.id,
      idempotencyKey,
      now,
    });
    return {
      fulfillmentId: fulfillment.id,
      deliveryFee: fulfillment.deliveryFeeSnapshot.toString(),
      deliveryTax: fulfillment.deliveryTaxSnapshot.toString(),
      promisedAt: fulfillment.promisedAt.toISOString(),
    };
  },
  successStatus: 201,
});
