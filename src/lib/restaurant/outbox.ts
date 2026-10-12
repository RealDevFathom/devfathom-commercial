import 'server-only';

import type { Prisma } from '@/generated/prisma/client';
import { OUTBOX_STATUS } from '@/lib/retail-terminal/outbox-retry';
import type { OutboxRecord } from '@/lib/retail-terminal/outbox-retry';

/**
 * M4-L1 / C2 — the ledger-first order event append + transactional outbox seam.
 *
 * Every order/order-item state change must append a `RestaurantOrderEvent` (an
 * append-only row with a per-order monotonically increasing `sequence`) AND a
 * `RestaurantEventOutbox` row in the SAME transaction as the change (§12.1). The
 * KOT/KDS read models derive from these durable rows — never from process-local
 * emission. Realtime is only ever a nudge to read durable state; NO SSE/websocket/
 * external channel is built or claimed in M4. The outbox dispatcher is a seam: an
 * interface plus PENDING/DISPATCHED/DEAD states and attempt/backoff fields. No
 * external consumer ships in M4, and no scheduler/worker exists yet to drive it
 * (§12.2 debt — flagged, not silently claimed).
 *
 * `appendOrderEvent` runs inside the caller's transaction. The per-order
 * `sequence` is derived from the current maximum and guarded by the unique
 * (orderId, sequence) index: if two appends for the same order race, the loser
 * hits a unique violation and its whole transaction rolls back (fail-closed) —
 * the ledger never gains two rows at the same sequence. The retry-planning
 * helpers below are pure so the dispatch state machine is testable without a DB.
 */

/**
 * The status vocabulary and the pure retry planners now live in the neutral
 * retail-terminal seam (PRD §11), shared with the Pharmacy counter's offline
 * command outbox. They are re-exported here unchanged, so every M4 importer of
 * this module keeps its existing import.
 */
export {
  OUTBOX_STATUS,
  DEFAULT_OUTBOX_RETRY_POLICY,
  backoffDelayMs,
  planDispatchSuccess,
  planDispatchFailure,
} from '@/lib/retail-terminal/outbox-retry';
export type {
  OutboxStatus,
  OutboxRecord,
  OutboxDispatchPatch,
  OutboxRetryPolicy,
} from '@/lib/retail-terminal/outbox-retry';

/** The aggregate kind the M4 order ledger writes. The outbox is generic
 * (aggregateType + aggregateId) so later milestones append other kinds. */
export const ORDER_AGGREGATE_TYPE = 'restaurant.order';

// ---------------------------------------------------------------------------
// Transactional append.
// ---------------------------------------------------------------------------

/** The minimal transaction-client surface the append needs. The Prisma
 * interactive transaction client satisfies it. */
export type OrderEventOutboxClient = Pick<
  Prisma.TransactionClient,
  'restaurantOrderEvent' | 'restaurantEventOutbox'
>;

export type AppendOrderEventInput = {
  orderId: string;
  /** A stable event-type string (e.g. "order.opened", "item.fired"). */
  eventType: string;
  /** The acting operator + terminal (C6). Null for a system-originated event. */
  actorStaffProfileId?: string | null;
  actorDeviceId?: string | null;
  /** The durable payload for both the ledger row and the outbox advertisement. */
  payload: Prisma.InputJsonValue;
};

export type AppendOrderEventResult = {
  eventId: string;
  sequence: number;
  outboxId: string;
};

/**
 * Append one order event + its outbox row inside the caller's transaction, and
 * return their identifiers. Must be called within `withTenantDb(...tx)` so the
 * RLS tenant scope is set and both writes commit atomically with the state
 * change. `organizationId` is DB-defaulted from the tenant setting (never sent).
 */
export async function appendOrderEvent(
  tx: OrderEventOutboxClient,
  input: AppendOrderEventInput
): Promise<AppendOrderEventResult> {
  const latest = await tx.restaurantOrderEvent.findFirst({
    where: { orderId: input.orderId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  const sequence = (latest?.sequence ?? 0) + 1;

  const event = await tx.restaurantOrderEvent.create({
    data: {
      orderId: input.orderId,
      sequence,
      eventType: input.eventType,
      actorStaffProfileId: input.actorStaffProfileId ?? null,
      actorDeviceId: input.actorDeviceId ?? null,
      payload: input.payload,
    },
    select: { id: true },
  });

  const outbox = await tx.restaurantEventOutbox.create({
    data: {
      eventType: input.eventType,
      aggregateType: ORDER_AGGREGATE_TYPE,
      aggregateId: input.orderId,
      payload: input.payload,
      status: OUTBOX_STATUS.PENDING,
    },
    select: { id: true },
  });

  return { eventId: event.id, sequence, outboxId: outbox.id };
}

// ---------------------------------------------------------------------------
// Dispatcher seam (no external consumer in M4).
// ---------------------------------------------------------------------------

/**
 * The dispatcher seam. A future worker (§12.2) reads PENDING rows whose
 * `nextAttemptAt` is due and calls `dispatch`; it then persists the patch from
 * {@link planDispatchSuccess} / {@link planDispatchFailure}. No implementation
 * ships in M4 — this is the contract the worker milestone fills.
 */
export interface OutboxDispatcher {
  dispatch(record: OutboxRecord & { eventType: string; payload: unknown }): Promise<void>;
}
