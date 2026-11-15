/**
 * M4-L1 / C3 — the single-authority order & order-item state machines.
 *
 * These are the ONE sanctioned place that decides which order and order-item
 * status transitions are legal, how the kitchen-facing order aggregate is
 * derived from item facts, how item-domain states map onto KDS display statuses,
 * and which §11.1 invariants gate an order reaching a terminal state. The L2
 * command layer is the only writer of the status columns, and it must route
 * every write through these predicates rather than re-deriving the rules per
 * command (C3). Nothing here performs I/O — the primitives take caller-loaded
 * facts and return decisions/patches, so the whole machine is trivially unit
 * testable and lives in exactly one file.
 *
 * The status string unions mirror the Prisma `RestaurantOrderStatus` and
 * `RestaurantOrderItemStatus` enums exactly (§11.1 — no additions, renames, or
 * omissions). They are declared locally so this core stays independent of the
 * generated client, exactly as `effective-dating.ts` does for version status.
 *
 * The high-level order states are §11.1-fixed; the concrete transition *edges*
 * below encode the conservative M4 interpretation (D14 — the detailed
 * order/item invariant + transition table is still an OPEN decision, so this
 * file is the provisional authority and the place a future ADR revises). Each
 * edge is justified by the domain motion it represents (open a check, fire a
 * course, re-fire after adding items, hold for payment, close, cancel).
 */

// ---------------------------------------------------------------------------
// §11.1 — the exact order status domain.
// ---------------------------------------------------------------------------

export type OrderStatus =
  | 'DRAFT'
  | 'OPEN'
  | 'SENT'
  | 'IN_PREPARATION'
  | 'READY'
  | 'SERVED'
  | 'PAYMENT_PENDING'
  | 'CLOSED'
  | 'CANCELLED';

export const ORDER_STATUSES = [
  'DRAFT',
  'OPEN',
  'SENT',
  'IN_PREPARATION',
  'READY',
  'SERVED',
  'PAYMENT_PENDING',
  'CLOSED',
  'CANCELLED',
] as const satisfies readonly OrderStatus[];

// ---------------------------------------------------------------------------
// §11.1 — the exact order-item status domain.
// ---------------------------------------------------------------------------

export type OrderItemStatus =
  'HELD' | 'QUEUED' | 'FIRING' | 'PREPARED' | 'SERVED' | 'REMAKE_REQUESTED' | 'VOIDED';

export const ORDER_ITEM_STATUSES = [
  'HELD',
  'QUEUED',
  'FIRING',
  'PREPARED',
  'SERVED',
  'REMAKE_REQUESTED',
  'VOIDED',
] as const satisfies readonly OrderItemStatus[];

/**
 * The kitchen-facing order aggregate is the subset of order statuses that is
 * DERIVED from item facts (§11.1: aggregates are never editable flags). It is
 * always one of these four (or `null` when nothing has been sent yet).
 */
export type KitchenAggregateStatus = Extract<
  OrderStatus,
  'SENT' | 'IN_PREPARATION' | 'READY' | 'SERVED'
>;

/**
 * A KDS display status is a FIXED mapping onto the item-domain states (§11.1:
 * customer-configurable labels are display strings only and must not create a
 * third authoritative state machine). These keys are the stable domain; a tenant
 * may relabel them for their screens but may never add to or reinterpret them.
 */
export type KdsDisplayStatus =
  'HELD' | 'NEW' | 'COOKING' | 'READY' | 'RECALLED' | 'SERVED' | 'VOIDED';

// ---------------------------------------------------------------------------
// Transition maps — the single authority for legal edges.
// ---------------------------------------------------------------------------

/**
 * Order transitions. The four kitchen states (SENT/IN_PREPARATION/READY/SERVED)
 * can move among one another in both directions because they are re-derived from
 * item facts every time an item changes: adding and firing a new course after an
 * order was READY legitimately pushes the aggregate back to SENT/IN_PREPARATION.
 * PAYMENT_PENDING is reached only from SERVED — in M4 pay-before-fulfilment is
 * disabled (C5/§11.1), and an order is SERVED only once its fired items are all
 * served — and the `all items resolved` gate is enforced separately by
 * {@link assertCanEnterPaymentPending}. CLOSED and CANCELLED are terminal.
 */
export const ORDER_TRANSITIONS = {
  DRAFT: ['OPEN', 'CANCELLED'],
  OPEN: ['SENT', 'CANCELLED'],
  SENT: ['IN_PREPARATION', 'READY', 'SERVED', 'OPEN', 'CANCELLED'],
  IN_PREPARATION: ['SENT', 'READY', 'SERVED', 'CANCELLED'],
  READY: ['SENT', 'IN_PREPARATION', 'SERVED', 'CANCELLED'],
  SERVED: ['SENT', 'IN_PREPARATION', 'READY', 'PAYMENT_PENDING', 'CANCELLED'],
  PAYMENT_PENDING: ['SERVED', 'CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
} as const satisfies Record<OrderStatus, readonly OrderStatus[]>;

/**
 * Order-item transitions. HELD is an unsent course; QUEUED..PREPARED is the
 * kitchen ledger; SERVED is delivered to the guest; REMAKE_REQUESTED is a
 * post-service recall that stays linked to the original and must resolve; VOIDED
 * is the single terminal state (post-preparation voids require co-authorization,
 * enforced by L2, not here). A recall (REMAKE_REQUESTED) resolves by being
 * re-queued for the pass, voided, or accepted back as served.
 */
export const ORDER_ITEM_TRANSITIONS = {
  HELD: ['QUEUED', 'VOIDED'],
  QUEUED: ['FIRING', 'HELD', 'VOIDED'],
  FIRING: ['PREPARED', 'QUEUED', 'VOIDED'],
  PREPARED: ['SERVED', 'FIRING', 'REMAKE_REQUESTED', 'VOIDED'],
  SERVED: ['REMAKE_REQUESTED', 'VOIDED'],
  REMAKE_REQUESTED: ['QUEUED', 'SERVED', 'VOIDED'],
  VOIDED: [],
} as const satisfies Record<OrderItemStatus, readonly OrderItemStatus[]>;

/** Order states from which no transition is legal (§11.1 terminal conditions). */
export const TERMINAL_ORDER_STATUSES = [
  'CLOSED',
  'CANCELLED',
] as const satisfies readonly OrderStatus[];

/** The single terminal item state. */
export const TERMINAL_ITEM_STATUSES = ['VOIDED'] as const satisfies readonly OrderItemStatus[];

// ---------------------------------------------------------------------------
// Fixed item-domain → KDS-display mapping (§11.1).
// ---------------------------------------------------------------------------

export const KDS_DISPLAY_BY_ITEM_STATUS = {
  HELD: 'HELD',
  QUEUED: 'NEW',
  FIRING: 'COOKING',
  PREPARED: 'READY',
  SERVED: 'SERVED',
  REMAKE_REQUESTED: 'RECALLED',
  VOIDED: 'VOIDED',
} as const satisfies Record<OrderItemStatus, KdsDisplayStatus>;

/** Map an item-domain status onto its fixed KDS display status (§11.1). */
export function toKdsDisplayStatus(status: OrderItemStatus): KdsDisplayStatus {
  return KDS_DISPLAY_BY_ITEM_STATUS[status];
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/** Raised on an illegal order or item status transition. */
export class OrderTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderTransitionError';
  }
}

/** Raised when a proposed order state would violate a §11.1 invariant. */
export class OrderInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderInvariantError';
  }
}

// ---------------------------------------------------------------------------
// Transition predicates.
// ---------------------------------------------------------------------------

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return (TERMINAL_ORDER_STATUSES as readonly OrderStatus[]).includes(status);
}

export function isTerminalItemStatus(status: OrderItemStatus): boolean {
  return (TERMINAL_ITEM_STATUSES as readonly OrderItemStatus[]).includes(status);
}

/** Whether `from -> to` is a legal order transition (a no-op self-edge is not
 * a transition and returns false). */
export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] as readonly OrderStatus[]).includes(to);
}

/** Whether `from -> to` is a legal item transition. */
export function canTransitionItem(from: OrderItemStatus, to: OrderItemStatus): boolean {
  return (ORDER_ITEM_TRANSITIONS[from] as readonly OrderItemStatus[]).includes(to);
}

/** Assert a legal order transition; throws {@link OrderTransitionError}. */
export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransitionOrder(from, to)) {
    throw new OrderTransitionError(`Illegal order transition ${from} -> ${to}.`);
  }
}

/** Assert a legal item transition; throws {@link OrderTransitionError}. */
export function assertItemTransition(from: OrderItemStatus, to: OrderItemStatus): void {
  if (!canTransitionItem(from, to)) {
    throw new OrderTransitionError(`Illegal order-item transition ${from} -> ${to}.`);
  }
}

/**
 * The delivery hand-off is a distinct, explicit item transition: when a delivery is
 * marked DELIVERED the guest has the food, so an item the kitchen has received but not
 * yet marked prepared (QUEUED or FIRING) is served directly. Items the kitchen never
 * received (HELD) and recalled items (REMAKE_REQUESTED) never hand off: they must be
 * sent, resolved or voided first. SERVED and VOIDED are already resolved.
 */
export const DELIVERY_HANDOFF_ITEM_TRANSITIONS = {
  HELD: [],
  QUEUED: ['SERVED'],
  FIRING: ['SERVED'],
  PREPARED: ['SERVED'],
  SERVED: [],
  REMAKE_REQUESTED: [],
  VOIDED: [],
} as const satisfies Record<OrderItemStatus, readonly OrderItemStatus[]>;

/** Whether an item in `from` is handed to the guest by a delivery hand-off. */
export function canHandOffItemOnDelivery(from: OrderItemStatus): boolean {
  return (DELIVERY_HANDOFF_ITEM_TRANSITIONS[from] as readonly OrderItemStatus[]).includes('SERVED');
}

// ---------------------------------------------------------------------------
// Item classification helpers (the vocabulary the invariants are built on).
// ---------------------------------------------------------------------------

/** An item is resolved once it has been served to the guest or voided; only
 * resolved items may remain on an order that reaches a terminal state. */
export function isResolvedItem(status: OrderItemStatus): boolean {
  return status === 'SERVED' || status === 'VOIDED';
}

/** An item is active while it is neither served nor voided — i.e. it still owes
 * the guest or the kitchen work (HELD/QUEUED/FIRING/PREPARED/REMAKE_REQUESTED). */
export function isActiveItem(status: OrderItemStatus): boolean {
  return !isResolvedItem(status);
}

/** An item is "sent" once it has left the pass for the kitchen ledger — every
 * state except HELD (unsent) and VOIDED (removed). The kitchen aggregate is
 * derived only from sent items. */
export function isSentItem(status: OrderItemStatus): boolean {
  return status !== 'HELD' && status !== 'VOIDED';
}

// ---------------------------------------------------------------------------
// §11.1 — the single item-facts -> order-aggregate derivation function.
// ---------------------------------------------------------------------------

/** Progress rank of a sent item; the kitchen aggregate follows the LEAST
 * advanced sent item (an expo/pass shows a ticket as done only once every line
 * is done). Non-sent states have no rank and are excluded by the caller. */
const SENT_ITEM_RANK: Record<Exclude<OrderItemStatus, 'HELD' | 'VOIDED'>, number> = {
  QUEUED: 1,
  REMAKE_REQUESTED: 2,
  FIRING: 2,
  PREPARED: 3,
  SERVED: 4,
};

const AGGREGATE_BY_RANK: Record<number, KitchenAggregateStatus> = {
  1: 'SENT',
  2: 'IN_PREPARATION',
  3: 'READY',
  4: 'SERVED',
};

/**
 * Derive the kitchen-facing order aggregate from item facts (§11.1). Only sent,
 * non-voided items count; the aggregate tracks the least-advanced of them so an
 * order reads READY only when every fired line is at least prepared and SERVED
 * only when every fired line is served. Returns `null` when nothing has been
 * sent (the order is still DRAFT/OPEN and has no kitchen aggregate). Voided
 * items never influence the aggregate; held (unsent) items are ignored here and
 * gated instead by the terminal/payment invariants below.
 */
export function deriveKitchenAggregate(
  itemStatuses: readonly OrderItemStatus[]
): KitchenAggregateStatus | null {
  const sent = itemStatuses.filter(isSentItem);
  if (sent.length === 0) return null;
  const minRank = sent.reduce(
    (min, status) =>
      Math.min(min, SENT_ITEM_RANK[status as Exclude<OrderItemStatus, 'HELD' | 'VOIDED'>]),
    Number.POSITIVE_INFINITY
  );
  return AGGREGATE_BY_RANK[minRank]!;
}

// ---------------------------------------------------------------------------
// §11.1 invariant predicates — the gates on reaching a terminal / payment state.
// ---------------------------------------------------------------------------

/**
 * §11.1: "an order cannot enter a terminal state while a non-voided item remains
 * active." Every item on an order moving to CLOSED/CANCELLED must be resolved
 * (SERVED or VOIDED). Throws {@link OrderInvariantError} naming the offending
 * statuses. A no-op when the target is not terminal.
 */
export function assertNoActiveItemsForTerminal(
  targetStatus: OrderStatus,
  itemStatuses: readonly OrderItemStatus[]
): void {
  if (!isTerminalOrderStatus(targetStatus)) return;
  const active = itemStatuses.filter(isActiveItem);
  if (active.length > 0) {
    throw new OrderInvariantError(
      `Order cannot enter terminal state ${targetStatus} while ${active.length} non-voided item(s) remain active (${active.join(', ')}); resolve or void them first.`
    );
  }
}

/**
 * §11.1: "a cancelled order cannot retain a queued/firing/prepared item without
 * an explicit compensating transition." The compensating transition is a void,
 * so a CANCELLED order may hold no item still in QUEUED/FIRING/PREPARED. Throws
 * {@link OrderInvariantError}. A no-op when the target is not CANCELLED.
 */
export function assertCancellationCompensated(
  targetStatus: OrderStatus,
  itemStatuses: readonly OrderItemStatus[]
): void {
  if (targetStatus !== 'CANCELLED') return;
  const uncompensated = itemStatuses.filter(
    (status) => status === 'QUEUED' || status === 'FIRING' || status === 'PREPARED'
  );
  if (uncompensated.length > 0) {
    throw new OrderInvariantError(
      `Cancelled order cannot retain in-flight kitchen item(s) (${uncompensated.join(', ')}) without a compensating void.`
    );
  }
}

/**
 * §11.1: "a remake remains linked to the original item and must resolve before
 * the governing order/check reaches its configured terminal condition." A
 * REMAKE_REQUESTED item is by definition unresolved, so none may remain when the
 * order reaches CLOSED/CANCELLED. Throws {@link OrderInvariantError}. A no-op
 * when the target is not terminal.
 */
export function assertRemakesResolvedForTerminal(
  targetStatus: OrderStatus,
  itemStatuses: readonly OrderItemStatus[]
): void {
  if (!isTerminalOrderStatus(targetStatus)) return;
  const pending = itemStatuses.filter((status) => status === 'REMAKE_REQUESTED');
  if (pending.length > 0) {
    throw new OrderInvariantError(
      `Order cannot reach terminal state ${targetStatus} with ${pending.length} unresolved remake(s); each remake must resolve (served or voided) first.`
    );
  }
}

/** Policy inputs for payment gating. `allowPayBeforeFulfilment` corresponds to
 * the accepted QSR service-mode policy (§11.1); it is DISABLED throughout M4
 * (C5 / BUILD-ASSUMPTIONS), so the default is `false`. */
export type OrderPaymentPolicy = {
  allowPayBeforeFulfilment: boolean;
};

export const DEFAULT_ORDER_PAYMENT_POLICY: OrderPaymentPolicy = {
  allowPayBeforeFulfilment: false,
};

/**
 * §11.1 / C5: gate entry into PAYMENT_PENDING. With pay-before-fulfilment
 * disabled (the M4 default), every non-voided item must be SERVED before an
 * order can move to payment — the "explicit close gated on all items resolved"
 * rule. When a future accepted policy enables pay-before-fulfilment for a
 * service mode, the gate is lifted. Throws {@link OrderInvariantError}.
 */
export function assertCanEnterPaymentPending(
  itemStatuses: readonly OrderItemStatus[],
  policy: OrderPaymentPolicy = DEFAULT_ORDER_PAYMENT_POLICY
): void {
  if (policy.allowPayBeforeFulfilment) return;
  const unfulfilled = itemStatuses.filter((status) => status !== 'SERVED' && status !== 'VOIDED');
  if (unfulfilled.length > 0) {
    throw new OrderInvariantError(
      `Order cannot enter PAYMENT_PENDING while ${unfulfilled.length} item(s) are unfulfilled (${unfulfilled.join(', ')}); pay-before-fulfilment is disabled in M4.`
    );
  }
}

/**
 * The one guard L2 calls before persisting an order status transition: the edge
 * must be legal AND the §11.1 invariants relevant to the target must hold. This
 * composes the transition check with the terminal/cancellation/remake/payment
 * predicates so no command layer can persist a status that violates them.
 */
export function assertOrderStatusChange(
  from: OrderStatus,
  to: OrderStatus,
  itemStatuses: readonly OrderItemStatus[],
  policy: OrderPaymentPolicy = DEFAULT_ORDER_PAYMENT_POLICY
): void {
  assertOrderTransition(from, to);
  assertNoActiveItemsForTerminal(to, itemStatuses);
  assertCancellationCompensated(to, itemStatuses);
  assertRemakesResolvedForTerminal(to, itemStatuses);
  if (to === 'PAYMENT_PENDING') assertCanEnterPaymentPending(itemStatuses, policy);
}
