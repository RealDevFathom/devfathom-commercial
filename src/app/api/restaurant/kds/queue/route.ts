import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  readStationQueue,
  requireKdsStation,
  resolveStationBusinessDate,
} from '@/lib/restaurant/kds';
import { withKdsReadAuth } from '@/lib/restaurant/terminal-auth';

const query = z.object({
  businessDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  sinceCursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * GET /api/restaurant/kds/queue?businessDate?=…&sinceCursor?=…&limit?=…
 *
 * The bound station's queue for the KDS device (C10, consumed by L5c): the durable
 * open tickets + their lines' display statuses, a ticket-number sequence cursor, and
 * a gap flag for bounded polling (§12.5). `withKdsReadAuth` rejects a revoked device
 * on every call; `requireKdsStation` enforces `kind = KDS` + a station binding (C8).
 * The business date defaults to the branch's current one (server-time, DST-safe, C5).
 */
export const GET = withKdsReadAuth(async (ctx, request) => {
  const station = requireKdsStation(ctx.device);
  if (!station.ok) return station.response;

  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid query', details: parsed.error.issues },
      { status: 400 }
    );
  }

  const businessDate = await resolveStationBusinessDate(
    ctx.db,
    ctx.device.branchId,
    parsed.data.businessDate,
    new Date()
  );
  const limit = parsed.data.limit ?? 50;
  let queue = await readStationQueue(ctx.db, {
    stationId: station.stationId,
    businessDate,
    sinceCursor: parsed.data.sinceCursor ?? null,
    limit,
  });
  if (
    ctx.demoActor?.organization.isDemo === true &&
    parsed.data.businessDate === undefined &&
    queue.tickets.length === 0
  ) {
    const previousQueueDate = await ctx.db.restaurantKitchenTicket.findFirst({
      where: {
        stationId: station.stationId,
        businessDate: { lt: businessDate },
        items: {
          some: { orderItem: { status: { notIn: ['SERVED', 'VOIDED'] } } },
        },
      },
      orderBy: { businessDate: 'desc' },
      select: { businessDate: true },
    });
    if (previousQueueDate) {
      queue = await readStationQueue(ctx.db, {
        stationId: station.stationId,
        businessDate: previousQueueDate.businessDate,
        sinceCursor: null,
        limit,
      });
    }
  }
  return NextResponse.json({
    ...queue,
    businessDate: queue.businessDate.toISOString().slice(0, 10),
  });
});
