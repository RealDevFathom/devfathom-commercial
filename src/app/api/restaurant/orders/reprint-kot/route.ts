import { OrderCommandError, reprintKitchenTicket } from '@/lib/restaurant/orders';
import { reprintKotBody, terminalCommandRoute } from '@/lib/restaurant/terminal-orders';

/** Queue a fresh copy of one durable KOT from a POS or its station-bound KDS. */
export const POST = terminalCommandRoute(
  reprintKotBody,
  async ({ ctx, data, actor }) => {
    if (ctx.device.kind === 'KDS') {
      const ticket = await ctx.db.restaurantKitchenTicket.findFirst({
        where: { id: data.ticketId, orderId: data.orderId, stationId: ctx.device.stationId ?? '' },
        select: { id: true },
      });
      if (!ticket) {
        throw new OrderCommandError(
          'The kitchen ticket is not available to this display station.',
          'TICKET_NOT_FOUND'
        );
      }
    }
    return reprintKitchenTicket(ctx.db, { ...data, actor });
  },
  200,
  // KDS commands are always online, station-scoped, and attributed to the active
  // operator. The POS-only proof exists to protect persisted offline composition.
  { composerProof: 'POS_ONLY' }
);
