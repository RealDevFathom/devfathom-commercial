import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  KDS_DISPLAY_BY_ITEM_STATUS,
  toKdsDisplayStatus,
  type KdsDisplayStatus,
  type OrderItemStatus,
} from './order-state-machine';

/**
 * M4-L4 — the KDS read-model projection + the fixed KDS action mapping.
 *
 * The kitchen display is derived ENTIRELY from durable rows (kitchen tickets +
 * their linked order items' current item-domain status), never from process-local
 * emission (C2). There is NO SSE/websocket/external channel in M4: the KDS transport
 * is BOUNDED POLLING with a sequence cursor + gap detection (§12.5). This file owns
 * two pure, DB-free cores plus the thin loads that feed them:
 *
 *  1. `projectStationQueue` — turns the station's tickets (with each line's current
 *     item status) into the level-triggered open queue a screen renders, mapping
 *     every item onto its FIXED L1 KDS display status (never a third state machine,
 *     C3). It is LEVEL-TRIGGERED: the returned queue is always the authoritative
 *     current open set, so a display is correct regardless of the client's cursor.
 *     The cursor + gap flag exist only so a client that missed a window knows to
 *     fully reconcile any derived/incremental state it kept.
 *
 *  2. `kdsActionToStatus` — the FIXED map from a KDS action (ack/bump/recall) onto
 *     the item-domain target status. A KDS action is only ever a request to move an
 *     item along the L1 line; the L2 command layer (`advanceItem`) is the single
 *     writer and rejects any illegal edge, so an out-of-order bump fails there
 *     rather than corrupting state.
 *
 * Cursor semantics (documented in BUILD-ASSUMPTIONS): the cursor is the station's
 * ticket-number high-water mark for the business date — `RestaurantKitchenTicket.
 * ticketNumber` is sequential per (station, businessDate), so it is the natural
 * per-station sequence. A gap (full-reconcile signal) is raised when either (a) the
 * client's `sinceCursor` exceeds the current max — the sequence regressed, e.g. the
 * screen was offline across the business-day cutoff and its cursor is stale — or
 * (b) the open queue is larger than the poll's `limit`, so bounded polling cannot
 * convey it in one window.
 */

// ── Fixed KDS action → item-domain transition mapping ────────────────────────

/** The three KDS-originated actions. `ack` starts a queued line cooking, `bump`
 * marks a cooking line ready, `recall` pulls a ready line back to the range. Each
 * is a request to move ONE item along the L1 line; the display distinction between
 * ack and recall is UX only — both request the FIRING state, from different (L1-
 * validated) source states. */
export type KdsAction = 'ACK' | 'BUMP' | 'RECALL';

export const KDS_ACTIONS = ['ACK', 'BUMP', 'RECALL'] as const satisfies readonly KdsAction[];

/** The FIXED target item status each KDS action requests. The source state is not
 * asserted here — the L2 command layer routes the move through the L1 state machine
 * (`assertItemTransition`), so an illegal edge (e.g. a BUMP of a still-QUEUED line)
 * is rejected there. */
export const KDS_ACTION_TRANSITIONS = {
  ACK: 'FIRING',
  BUMP: 'PREPARED',
  RECALL: 'FIRING',
} as const satisfies Record<KdsAction, Extract<OrderItemStatus, 'FIRING' | 'PREPARED'>>;

export function kdsActionToStatus(action: KdsAction): 'FIRING' | 'PREPARED' {
  return KDS_ACTION_TRANSITIONS[action];
}

// ── Station-queue projection (pure) ──────────────────────────────────────────

/** One kitchen-ticket line as loaded from durable rows: its identity, snapshot
 * name, course/seat, fired quantity, and the linked order item's CURRENT status. */
export type StationQueueItemInput = {
  orderItemId: string;
  name: string;
  course: number;
  seatNumber: number | null;
  quantity: number;
  itemStatus: OrderItemStatus;
};

/** One kitchen ticket routed to the station, with its lines' current states. */
export type StationTicketInput = {
  ticketId: string;
  ticketNumber: number;
  orderId: string;
  orderNumber: number;
  createdAt: Date;
  items: StationQueueItemInput[];
};

export type ProjectStationQueueInput = {
  stationId: string;
  businessDate: Date;
  /** The client's last high-water ticket number; absent on a first poll. */
  sinceCursor?: number | null;
  /** Bounded-polling page size — the max open tickets returned in one window. */
  limit: number;
  /** ALL of the station's tickets for the business date (open and closed). */
  tickets: readonly StationTicketInput[];
};

export type StationQueueItem = StationQueueItemInput & { displayStatus: KdsDisplayStatus };

export type StationQueueTicket = {
  ticketId: string;
  ticketNumber: number;
  orderId: string;
  orderNumber: number;
  createdAt: Date;
  /** The ticket's rolled-up KDS display: the least-advanced open line. */
  displayStatus: KdsDisplayStatus;
  items: StationQueueItem[];
};

export type StationQueue = {
  stationId: string;
  businessDate: Date;
  tickets: StationQueueTicket[];
  /** The station's current ticket-number high-water mark (the new cursor). */
  cursor: number;
  /** True when the client should fully reconcile: sequence regressed, or the open
   * queue overflowed the poll window. */
  gap: boolean;
  /** True when the open queue is larger than `limit` (only `limit` returned). */
  hasMore: boolean;
  /** The fixed item-status → display-status mapping, so the console renders labels
   * against the authoritative L1 domain without re-deriving it (C10 payload). */
  displayMapping: typeof KDS_DISPLAY_BY_ITEM_STATUS;
};

/** An item is off the kitchen display once it is served to the guest or voided. */
function isClearedItem(status: OrderItemStatus): boolean {
  return status === 'SERVED' || status === 'VOIDED';
}

/** Least-advanced-open-line rank; the ticket rolls up to this line's display, so a
 * ticket reads READY only once every open line is at least prepared. A recalled
 * line outranks (shows before) a plain cooking line so it draws attention. */
const OPEN_ITEM_RANK: Partial<Record<OrderItemStatus, number>> = {
  QUEUED: 1,
  REMAKE_REQUESTED: 2,
  FIRING: 3,
  PREPARED: 4,
};

function ticketDisplayStatus(items: readonly StationQueueItemInput[]): KdsDisplayStatus {
  const open = items.filter((i) => !isClearedItem(i.itemStatus));
  // A ticket in the queue always has an open line (closed tickets are filtered out
  // before this is called), so `least` is always assigned.
  let least: StationQueueItemInput = open[0]!;
  let leastRank = OPEN_ITEM_RANK[least.itemStatus] ?? Number.POSITIVE_INFINITY;
  for (const item of open.slice(1)) {
    const rank = OPEN_ITEM_RANK[item.itemStatus] ?? Number.POSITIVE_INFINITY;
    if (rank < leastRank) {
      least = item;
      leastRank = rank;
    }
  }
  return toKdsDisplayStatus(least.itemStatus);
}

/**
 * Project a station's tickets into the level-triggered open KDS queue with the
 * bounded-polling cursor + gap flag. Pure: no I/O, so the cursor/gap/mapping logic
 * is unit-tested without a database. Open tickets (any non-cleared line) are
 * returned oldest-first (FIFO by ticket number), bounded to `limit`.
 */
export function projectStationQueue(input: ProjectStationQueueInput): StationQueue {
  const maxPresent = input.tickets.reduce((max, t) => Math.max(max, t.ticketNumber), 0);

  const open = input.tickets
    .filter((t) => t.items.some((i) => !isClearedItem(i.itemStatus)))
    .slice()
    .sort((a, b) => a.ticketNumber - b.ticketNumber);

  const hasMore = open.length > input.limit;
  const page = hasMore ? open.slice(0, input.limit) : open;

  const regressed = input.sinceCursor != null && input.sinceCursor > maxPresent;
  const gap = regressed || hasMore;

  return {
    stationId: input.stationId,
    businessDate: input.businessDate,
    tickets: page.map((ticket) => ({
      ticketId: ticket.ticketId,
      ticketNumber: ticket.ticketNumber,
      orderId: ticket.orderId,
      orderNumber: ticket.orderNumber,
      createdAt: ticket.createdAt,
      displayStatus: ticketDisplayStatus(ticket.items),
      items: ticket.items.map((item) => ({
        ...item,
        displayStatus: toKdsDisplayStatus(item.itemStatus),
      })),
    })),
    cursor: maxPresent,
    gap,
    hasMore,
    displayMapping: KDS_DISPLAY_BY_ITEM_STATUS,
  };
}

// ── Thin durable loads (glue over the pure core) ─────────────────────────────

export type ReadStationQueueInput = {
  stationId: string;
  businessDate: Date;
  sinceCursor?: number | null;
  limit: number;
};

/**
 * Load the station's tickets for the business date (with each line's current
 * order-item status) and project the queue. The read is scoped by RLS to the
 * device's organization (C1); `stationId` is the device's bound station.
 */
export async function readStationQueue(
  db: ScopedDb,
  input: ReadStationQueueInput
): Promise<StationQueue> {
  const tickets = await db.restaurantKitchenTicket.findMany({
    where: { stationId: input.stationId, businessDate: input.businessDate },
    orderBy: { ticketNumber: 'asc' },
    select: {
      id: true,
      ticketNumber: true,
      orderId: true,
      createdAt: true,
      order: { select: { orderNumber: true } },
      items: {
        select: {
          orderItemId: true,
          quantity: true,
          orderItem: {
            select: { name: true, course: true, seatNumber: true, status: true },
          },
        },
      },
    },
  });

  return projectStationQueue({
    stationId: input.stationId,
    businessDate: input.businessDate,
    sinceCursor: input.sinceCursor,
    limit: input.limit,
    tickets: tickets.map((ticket) => ({
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      orderId: ticket.orderId,
      orderNumber: ticket.order.orderNumber,
      createdAt: ticket.createdAt,
      items: ticket.items.map((line) => ({
        orderItemId: line.orderItemId,
        name: line.orderItem.name,
        course: line.orderItem.course,
        seatNumber: line.orderItem.seatNumber,
        quantity: line.quantity,
        itemStatus: line.orderItem.status as OrderItemStatus,
      })),
    })),
  });
}

/**
 * Whether an order item is fired to a given station — i.e. it has a kitchen-ticket
 * line on a ticket routed to that station. A KDS device may only act on lines for
 * its own bound station, so its bump/ack/recall routes gate on this (C8). RLS
 * already scopes the read to the device's organization.
 */
export async function isOrderItemOnStation(
  db: ScopedDb,
  orderItemId: string,
  stationId: string
): Promise<boolean> {
  const line = await db.restaurantKitchenTicketItem.findFirst({
    where: { orderItemId, ticket: { stationId } },
    select: { id: true },
  });
  return line !== null;
}
