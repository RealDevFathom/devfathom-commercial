import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { resolveStation, type StationMatchLevel, type StationRoutingRule } from './station-routing';

/**
 * M4-L2 (KOT) — kitchen-ticket generation at fire time.
 *
 * When a course fires, each fired item routes to a kitchen station via the L1
 * most-specific-wins rules (`station-routing.ts`), and the items sharing a station
 * are grouped onto one `RestaurantKitchenTicket` with per-line
 * `RestaurantKitchenTicketItem` rows. Everything here runs INSIDE the caller's
 * fire transaction (the same transaction that flips the item statuses and appends
 * the ledger event, C2) so a ticket never exists without its durable item facts.
 *
 * Ticket numbering is sequential per `(station, businessDate)`. There is no
 * dedicated sequence row (unlike order numbers), so the next number is the current
 * per-(station, businessDate) maximum + 1; the unique `(stationId, businessDate,
 * ticketNumber)` index is the backstop — two concurrent fires to the same station
 * that pick the same number collide and the loser's whole transaction rolls back
 * (fail-closed), exactly like the event-sequence guard. Numbers are unique and
 * monotone, not gap-free (BUILD-ASSUMPTIONS).
 */

export class KitchenTicketError extends Error {
  constructor(
    message: string,
    readonly reason: 'NO_STATION'
  ) {
    super(message);
    this.name = 'KitchenTicketError';
  }
}

/** One item being fired: its identity, its product/category (for routing) and the
 * quantity fired to the station. */
export type FiredItem = {
  orderItemId: string;
  productId: string;
  categoryId: string | null;
  quantity: number;
};

export type GeneratedTicket = {
  ticketId: string;
  stationId: string;
  ticketNumber: number;
  matchedBy: StationMatchLevel;
  items: Array<{ orderItemId: string; quantity: number }>;
};

export type GenerateKitchenTicketsInput = {
  orderId: string;
  branchId: string;
  /** The order's stamped business date (a UTC-midnight `@db.Date`). */
  businessDate: Date;
  items: readonly FiredItem[];
};

/**
 * Generate the kitchen tickets for a set of fired items inside the caller's
 * transaction. Loads the branch's active stations, routing rules and default
 * station once, routes every item, groups by station, allocates a per-(station,
 * businessDate) ticket number, and creates the ticket + its line rows. Returns the
 * created tickets (grouped, deterministic by station id) for the caller to record
 * on the ledger event. Throws {@link KitchenTicketError} if any item cannot be
 * routed and no default station is configured — the caller then aborts the fire
 * rather than silently dropping the item.
 */
export async function generateKitchenTickets(
  tx: ScopedDb,
  input: GenerateKitchenTicketsInput
): Promise<GeneratedTicket[]> {
  if (input.items.length === 0) return [];

  const stations = await tx.restaurantKitchenStation.findMany({
    where: { branchId: input.branchId, active: true },
    select: { id: true, isDefault: true },
  });
  const activeStationIds = new Set(stations.map((s) => s.id));
  const defaultStationId = stations.find((s) => s.isDefault)?.id ?? null;

  const ruleRows = await tx.restaurantStationRoutingRule.findMany({
    where: { station: { branchId: input.branchId, active: true } },
    select: { stationId: true, productId: true, categoryId: true, priority: true },
  });
  const rules: StationRoutingRule[] = ruleRows.filter((r) => activeStationIds.has(r.stationId));

  // Route every item, grouping order items (preserving order) per station.
  const byStation = new Map<string, { matchedBy: StationMatchLevel; items: FiredItem[] }>();
  const stationOrder: string[] = [];
  for (const item of input.items) {
    const resolution = resolveStation(
      { productId: item.productId, categoryId: item.categoryId },
      rules,
      defaultStationId
    );
    if (!resolution) {
      throw new KitchenTicketError(
        `Order item ${item.orderItemId} could not be routed to a kitchen station and the branch has no default station.`,
        'NO_STATION'
      );
    }
    const group = byStation.get(resolution.stationId);
    if (group) {
      group.items.push(item);
    } else {
      byStation.set(resolution.stationId, { matchedBy: resolution.matchedBy, items: [item] });
      stationOrder.push(resolution.stationId);
    }
  }

  const generated: GeneratedTicket[] = [];
  for (const stationId of stationOrder) {
    const group = byStation.get(stationId)!;
    const ticketNumber = await allocateTicketNumber(tx, stationId, input.businessDate);
    const ticket = await tx.restaurantKitchenTicket.create({
      data: { orderId: input.orderId, stationId, businessDate: input.businessDate, ticketNumber },
      select: { id: true },
    });
    const items: Array<{ orderItemId: string; quantity: number }> = [];
    for (const item of group.items) {
      await tx.restaurantKitchenTicketItem.create({
        data: { ticketId: ticket.id, orderItemId: item.orderItemId, quantity: item.quantity },
        select: { id: true },
      });
      items.push({ orderItemId: item.orderItemId, quantity: item.quantity });
    }
    generated.push({
      ticketId: ticket.id,
      stationId,
      ticketNumber,
      matchedBy: group.matchedBy,
      items,
    });
  }
  return generated;
}

/** Next ticket number for `(station, businessDate)` = current max + 1. The unique
 * index is the concurrency backstop (see module doc). */
async function allocateTicketNumber(
  tx: ScopedDb,
  stationId: string,
  businessDate: Date
): Promise<number> {
  const latest = await tx.restaurantKitchenTicket.findFirst({
    where: { stationId, businessDate },
    orderBy: { ticketNumber: 'desc' },
    select: { ticketNumber: true },
  });
  return (latest?.ticketNumber ?? 0) + 1;
}
