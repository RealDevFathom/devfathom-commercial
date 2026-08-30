import { z } from 'zod';

/** Stored/readable values include DELIVERY for historical compatibility. */
export const ORDER_CHANNELS = ['DINE_IN', 'TAKEAWAY', 'DELIVERY'] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];
export const orderChannelSchema = z.enum(ORDER_CHANNELS);

/** D06 is unresolved, so only these channels may drive operational reads/writes. */
export const OPERATIONAL_ORDER_CHANNELS = ['DINE_IN', 'TAKEAWAY'] as const;
export type OperationalOrderChannel = (typeof OPERATIONAL_ORDER_CHANNELS)[number];
export const DELIVERY_CHANNEL_UNAVAILABLE_MESSAGE =
  'Delivery is not configured. Use dine-in or takeaway.';
export const operationalOrderChannelSchema = z.enum(OPERATIONAL_ORDER_CHANNELS, {
  error: DELIVERY_CHANNEL_UNAVAILABLE_MESSAGE,
});

export function isOperationalOrderChannel(
  channel: OrderChannel
): channel is OperationalOrderChannel {
  return (OPERATIONAL_ORDER_CHANNELS as readonly OrderChannel[]).includes(channel);
}
