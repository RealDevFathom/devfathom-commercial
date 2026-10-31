import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { PrintDocumentType, PrintJob, PrintRoute } from './printing/contract';
import { PrintBridgeService } from './printing/service';

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
  createdAt: Date;
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
 * Pure hand-off from the durable KOT fact to the vendor-neutral print boundary.
 * Labels are supplied by the caller's already-authorized order read; this module
 * deliberately does not perform I/O or send to hardware inside the owning transaction.
 */
export function kitchenTicketPrintJob(
  ticket: GeneratedTicket,
  input: {
    branchId: string;
    orderReference: string;
    createdAt: string;
    documentType?: Extract<PrintDocumentType, 'KITCHEN_TICKET' | 'BAR_TICKET'>;
    labelsByOrderItemId: Readonly<Record<string, string>>;
  }
): PrintJob {
  return {
    branchId: input.branchId,
    stationId: ticket.stationId,
    idempotencyKey: `kitchen-ticket:${ticket.ticketId}:v1`,
    document: {
      type: input.documentType ?? 'KITCHEN_TICKET',
      reference: input.orderReference,
      title: input.documentType === 'BAR_TICKET' ? 'BAR' : 'KITCHEN',
      createdAt: input.createdAt,
      lines: ticket.items.map((item) => ({
        quantity: item.quantity,
        label: input.labelsByOrderItemId[item.orderItemId] ?? 'Unlabelled item',
      })),
    },
  };
}

function routeTypeForTicket(
  routes: readonly PrintRoute[],
  stationId: string
): Extract<PrintDocumentType, 'KITCHEN_TICKET' | 'BAR_TICKET'> | null {
  const eligible = routes.filter(
    (route) =>
      route.enabled &&
      (route.documentType === 'KITCHEN_TICKET' || route.documentType === 'BAR_TICKET')
  );
  const exact = eligible.find((route) => route.stationId === stationId);
  const fallback = eligible.find((route) => route.stationId === null);
  const selected = exact ?? fallback;
  return selected?.documentType === 'KITCHEN_TICKET' || selected?.documentType === 'BAR_TICKET'
    ? selected.documentType
    : null;
}

/** Persist one routed print intent per generated KOT; hardware delivery is bridge-owned. */
export async function enqueueKitchenTicketPrintJobs(
  tx: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    orderReference: string;
    tickets: readonly GeneratedTicket[];
    labelsByOrderItemId: Readonly<Record<string, string>>;
  }
): Promise<number> {
  if (input.tickets.length === 0) return 0;
  const routes = await tx.restaurantPrintRoute.findMany({
    where: {
      branchId: input.branchId,
      enabled: true,
      documentType: { in: ['KITCHEN_TICKET', 'BAR_TICKET'] },
    },
    orderBy: [{ stationId: 'desc' }, { documentType: 'desc' }],
    select: {
      documentType: true,
      stationId: true,
      printerId: true,
      registeredPrinterId: true,
      enabled: true,
    },
  });
  const service = new PrintBridgeService(tx);
  let enqueued = 0;
  for (const ticket of input.tickets) {
    const documentType = routeTypeForTicket(routes, ticket.stationId);
    if (!documentType) continue;
    const result = await service.enqueue(
      input.organizationId,
      { branchId: input.branchId, routes },
      kitchenTicketPrintJob(ticket, {
        branchId: input.branchId,
        orderReference: input.orderReference,
        createdAt: ticket.createdAt.toISOString(),
        documentType,
        labelsByOrderItemId: input.labelsByOrderItemId,
      })
    );
    if (result.status !== 'NO_PRINTER') enqueued += 1;
  }
  return enqueued;
}

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
      select: { id: true, createdAt: true },
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
      createdAt: ticket.createdAt,
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
