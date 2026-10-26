import 'server-only';

import { createHash } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { POS_MONTHLY_ORDERS_LIMIT, resolveEntitlementLimit } from '@/lib/entitlement-limits';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { evaluateOrderSettlement } from './bills';
import { businessDateToUtcDate, resolveBusinessDate } from './business-date';
import { buildCoAuthorizationRecord } from './co-authorization';
import { postOrderRecipeConsumption } from './inventory';
import {
  enqueueKitchenTicketPrintJobs,
  generateKitchenTickets,
  type FiredItem,
  type GeneratedTicket,
} from './kitchen-tickets';
import { earnLoyaltyForClosedOrder } from './loyalty';
import {
  DELIVERY_CHANNEL_UNAVAILABLE_MESSAGE,
  isOperationalOrderChannel,
  type OrderChannel,
} from './order-channels';
import { allocateOrderNumber } from './order-numbers';
import {
  resolveItemSnapshot,
  resolveModifierSnapshots,
  resolveOrderPricingRefs,
} from './order-pricing';
import {
  assertItemTransition,
  assertOrderStatusChange,
  canTransitionOrder,
  deriveKitchenAggregate,
  isResolvedItem,
  type OrderItemStatus,
  type OrderStatus,
} from './order-state-machine';
import { appendOrderEvent } from './outbox';

/**
 * M4-L2 / C3 — the single order & order-item command layer.
 *
 * This is the ONLY writer of the order/order-item status columns (C3). Every
 * command runs inside one tenant-scoped interactive transaction and, for every
 * state change, (a) routes the transition through the L1 state machine
 * (`order-state-machine.ts`) so an illegal edge or a violated §11.1 invariant is
 * rejected here rather than persisted, (b) appends a `RestaurantOrderEvent` +
 * `RestaurantEventOutbox` row in that same transaction (C2, via `outbox.ts`), and
 * (c) for terminal-submitted commands, enforces device-scoped idempotency (C7).
 * The kitchen-facing order aggregate (SENT/IN_PREPARATION/READY/SERVED) is never
 * an editable flag — after any item change it is re-derived from item facts by the
 * single derivation function and written back (C3). Snapshots are frozen at add
 * time through the M3 effective-menu read model (C4, `order-pricing.ts`); catalog
 * or price edits after the fact never rewrite an order's history.
 *
 * Server time is authoritative (C6): callers pass the server instant as `now`
 * (defaulting to `new Date()` in the router); client time is never trusted. Inputs
 * are typed here; the router applies the strict Zod schemas (C7).
 *
 * The provisional command/transition vocabulary (D14 is an OPEN decision — this
 * file is the interim authority, see BUILD-ASSUMPTIONS):
 *   open → add/adjust/remove (while HELD) → send (fire whole order) OR
 *   fireCourse (fire one course) → advance (FIRING/PREPARED/SERVED) → close.
 * send and fireCourse both move HELD→QUEUED and print KOTs (kitchen-tickets.ts);
 * holdCourse recalls QUEUED→HELD; remake/void/cancel are the reasoned exits.
 */

export type OrderCommandErrorReason =
  | 'ORDER_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'ORDER_TERMINAL'
  | 'NO_PUBLICATION'
  | 'INVALID'
  | 'ITEM_STATE'
  | 'NOTHING_TO_SEND'
  | 'NOTHING_TO_FIRE'
  | 'CO_AUTH_REQUIRED'
  | 'DISPOSITION_REQUIRED'
  | 'REASON_REQUIRED'
  | 'BRANCH_NOT_FOUND'
  | 'TABLE_NOT_FOUND'
  | 'TABLE_LINK_NOT_FOUND'
  | 'CHANNEL_UNAVAILABLE'
  | 'CHANNEL_TABLE'
  | 'BILL_ALREADY_CUT'
  | 'NOT_CLOSABLE'
  | 'NOT_SETTLED'
  | 'LIMIT_REACHED'
  | 'LIMIT_UNAVAILABLE'
  | 'PRINT_ROUTE_NOT_FOUND'
  | 'TICKET_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT';

export class OrderCommandError extends Error {
  constructor(
    message: string,
    readonly reason: OrderCommandErrorReason
  ) {
    super(message);
    this.name = 'OrderCommandError';
  }
}

export type WastageDisposition = 'WASTE' | 'RESTOCK' | 'NONE';

/** Who/what is issuing the command + the device-scoped idempotency key (C6/C7). */
export type CommandActor = {
  staffProfileId: string;
  deviceId: string;
  /** Device-scoped idempotency key; a replay of the same (deviceId, key) returns
   * the original result and creates nothing (§12.1). */
  idempotencyKey: string;
};

/** Item states that count as "post preparation" — a void of one requires
 * co-authorization + a wastage disposition (C6). */
const POST_PREP_STATUSES: readonly OrderItemStatus[] = [
  'FIRING',
  'PREPARED',
  'SERVED',
  'REMAKE_REQUESTED',
];

/** Order states in which the derived kitchen aggregate is maintained. */
const OPEN_OR_KITCHEN: readonly OrderStatus[] = [
  'OPEN',
  'SENT',
  'IN_PREPARATION',
  'READY',
  'SERVED',
];

function isPostPrep(status: OrderItemStatus): boolean {
  return POST_PREP_STATUSES.includes(status);
}

function requireReason(reason: string | null | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length === 0) {
    throw new OrderCommandError('This command requires a non-empty reason.', 'REASON_REQUIRED');
  }
  return trimmed;
}

/**
 * Open one tenant-scoped interactive transaction. `db` is the request's
 * `createTenantDb` proxy; its `$transaction` routes through `withTenantDb`, which
 * sets the RLS tenant GUC and hands the callback a nested `ScopedDb` (see
 * `scoped-db.ts`). Prisma's own `$transaction` overload types the callback param
 * as the interactive-transaction client, so we retype it to the `ScopedDb` the
 * proxy actually passes at runtime — every command below then runs against a
 * tenant-scoped client with the full model surface the L1 primitives expect.
 */
function runInTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

/** Serialize mutations whose validity depends on the order's child-row set. */
export async function lockRestaurantOrder(tx: ScopedDb, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "restaurant_orders" WHERE "id" = ${orderId} FOR UPDATE`;
}

// ── Idempotency (C7) ───────────────────────────────────────────────────────────

type IdempotencyOutcome = { replay: false } | { replay: true; resultRef: string | null };

/**
 * Begin an idempotent command. If this (deviceId, key) has already run, returns a
 * replay with the stored result reference (the caller then re-reads and returns
 * the original result, creating nothing). Otherwise records the key and proceeds.
 * A concurrent duplicate that loses the unique-index race rolls the whole
 * transaction back (fail-closed); the client's retry then observes the committed
 * key and replays.
 */
async function beginIdempotent(
  tx: ScopedDb,
  actor: CommandActor,
  commandType: string,
  payload: unknown
): Promise<IdempotencyOutcome> {
  const canonicalPayloadHash = createHash('sha256')
    .update(canonicalOrderPayload(payload))
    .digest('hex');
  const existing = await tx.restaurantOrderIdempotencyKey.findUnique({
    where: { deviceId_key: { deviceId: actor.deviceId, key: actor.idempotencyKey } },
    select: { commandType: true, canonicalPayloadHash: true, resultRef: true },
  });
  if (existing) {
    if (
      existing.commandType !== commandType ||
      existing.canonicalPayloadHash === null ||
      existing.canonicalPayloadHash !== canonicalPayloadHash
    ) {
      throw new OrderCommandError(
        'This idempotency key is already bound to a different order command payload.',
        'IDEMPOTENCY_CONFLICT'
      );
    }
    return { replay: true, resultRef: existing.resultRef };
  }
  await tx.restaurantOrderIdempotencyKey.create({
    data: {
      deviceId: actor.deviceId,
      key: actor.idempotencyKey,
      commandType,
      canonicalPayloadHash,
    },
  });
  return { replay: false };
}

/** Stable command bytes, excluding retry metadata and server-generated timestamps. */
function canonicalOrderPayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalOrderPayload).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => key !== 'idempotencyKey' && key !== 'now' && item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalOrderPayload(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Record what a first-run command produced, so a later replay can return it. */
async function recordIdempotentResult(
  tx: ScopedDb,
  actor: CommandActor,
  resultRef: string
): Promise<void> {
  await tx.restaurantOrderIdempotencyKey.update({
    where: { deviceId_key: { deviceId: actor.deviceId, key: actor.idempotencyKey } },
    data: { resultRef },
  });
}

// ── Shared loads / helpers ───────────────────────────────────────────────────

type LoadedItem = {
  id: string;
  status: OrderItemStatus;
  course: number;
  quantity: number;
  productId: string;
  variantId: string | null;
  name: string;
  unitPrice: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  serviceChargeAmount: Prisma.Decimal;
  seatNumber: number | null;
  wastageDisposition: string | null;
  product: { categoryId: string | null };
};

type LoadedOrder = {
  id: string;
  organizationId: string;
  branchId: string;
  orderNumber: number;
  status: OrderStatus;
  channel: OrderChannel;
  businessDate: Date;
  publicationId: string | null;
  items: LoadedItem[];
};

async function loadOrder(tx: ScopedDb, orderId: string): Promise<LoadedOrder> {
  const order = await tx.restaurantOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      organizationId: true,
      branchId: true,
      orderNumber: true,
      status: true,
      channel: true,
      businessDate: true,
      publicationId: true,
      items: {
        select: {
          id: true,
          status: true,
          course: true,
          quantity: true,
          productId: true,
          variantId: true,
          name: true,
          unitPrice: true,
          taxAmount: true,
          serviceChargeAmount: true,
          seatNumber: true,
          wastageDisposition: true,
          product: { select: { categoryId: true } },
        },
      },
    },
  });
  if (!order) {
    throw new OrderCommandError('The order does not exist.', 'ORDER_NOT_FOUND');
  }
  return order as LoadedOrder;
}

function assertMutable(order: LoadedOrder): void {
  if (order.status === 'CLOSED' || order.status === 'CANCELLED') {
    throw new OrderCommandError(
      `The order is ${order.status} and can no longer be modified.`,
      'ORDER_TERMINAL'
    );
  }
}

function findItem(order: LoadedOrder, itemId: string): LoadedItem {
  const item = order.items.find((i) => i.id === itemId);
  if (!item) {
    throw new OrderCommandError('The order item does not exist on this order.', 'ITEM_NOT_FOUND');
  }
  return item;
}

/** Append a ledger event + outbox row for a state change (C2). */
async function record(
  tx: ScopedDb,
  order: Pick<LoadedOrder, 'id'>,
  actor: CommandActor,
  eventType: string,
  payload: Prisma.InputJsonValue
): Promise<void> {
  await appendOrderEvent(tx, {
    orderId: order.id,
    eventType,
    actorStaffProfileId: actor.staffProfileId,
    actorDeviceId: actor.deviceId,
    payload,
  });
}

/**
 * Re-derive the kitchen aggregate from the current item facts and persist it onto
 * the order when it legally changes (C3). The aggregate is never set directly by a
 * command — it always follows the least-advanced sent item. Terminal/payment
 * moves are handled by their own commands, so this only walks the reversible
 * kitchen/open states.
 */
async function syncAggregate(
  tx: ScopedDb,
  orderId: string,
  currentStatus: OrderStatus
): Promise<OrderStatus> {
  if (!OPEN_OR_KITCHEN.includes(currentStatus)) return currentStatus;
  const items = await tx.restaurantOrderItem.findMany({
    where: { orderId },
    select: { status: true },
  });
  const derived = deriveKitchenAggregate(items.map((i) => i.status));
  const target: OrderStatus = derived ?? 'OPEN';
  if (target === currentStatus || !canTransitionOrder(currentStatus, target)) {
    return currentStatus;
  }
  await tx.restaurantOrder.update({ where: { id: orderId }, data: { status: target } });
  return target;
}

/** Validate a table belongs to the order's branch (via its floor). */
async function assertTablesInBranch(
  tx: ScopedDb,
  branchId: string,
  tableIds: readonly string[]
): Promise<void> {
  if (tableIds.length === 0) return;
  const tables = await tx.restaurantTable.findMany({
    where: { id: { in: [...tableIds] } },
    select: { id: true, floor: { select: { branchId: true } } },
  });
  const byId = new Map(tables.map((t) => [t.id, t]));
  for (const tableId of tableIds) {
    const table = byId.get(tableId);
    if (!table || table.floor.branchId !== branchId) {
      throw new OrderCommandError(
        `Table ${tableId} does not belong to this branch.`,
        'TABLE_NOT_FOUND'
      );
    }
  }
}

// ── Open ─────────────────────────────────────────────────────────────────────

export type OpenOrderInput = {
  organizationId: string;
  entitlementLimits: Readonly<Record<string, number>>;
  branchId: string;
  channel: OrderChannel;
  /** Trusted customer identity. Required for DELIVERY orders. */
  customerId?: string | null;
  /** The effective-menu publication the order is taken from (required to add menu
   * items later; C4). */
  publicationId?: string | null;
  tableIds?: readonly string[];
  coverCount?: number | null;
  sectionId?: string | null;
  serverStaffProfileId?: string | null;
  actor: CommandActor;
  /** Authoritative server instant (C6). Defaults to now. */
  now?: Date;
};

export type OpenOrderResult = {
  orderId: string;
  orderNumber: number;
  businessDate: Date;
  replayed: boolean;
};

export async function enforceMonthlyOrderLimit(
  tx: ScopedDb,
  input: Pick<OpenOrderInput, 'organizationId' | 'entitlementLimits'>,
  businessDate: Date
): Promise<void> {
  const limit = resolveEntitlementLimit(input.entitlementLimits, POS_MONTHLY_ORDERS_LIMIT);
  if (limit.status !== 'configured') {
    throw new OrderCommandError(
      'The monthly order limit is not configured correctly.',
      'LIMIT_UNAVAILABLE'
    );
  }
  if (limit.value === 0) {
    throw new OrderCommandError('Monthly order creation is disabled.', 'LIMIT_REACHED');
  }
  const monthStart = new Date(
    Date.UTC(businessDate.getUTCFullYear(), businessDate.getUTCMonth(), 1)
  );
  const nextMonth = new Date(
    Date.UTC(businessDate.getUTCFullYear(), businessDate.getUTCMonth() + 1, 1)
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pos-orders-monthly:${input.organizationId}:${monthStart.toISOString().slice(0, 10)}`}, 0))`
  );
  const monthlyOrders = await tx.restaurantOrder.count({
    where: {
      organizationId: input.organizationId,
      businessDate: { gte: monthStart, lt: nextMonth },
    },
  });
  if (monthlyOrders >= limit.value) {
    throw new OrderCommandError(
      `Monthly order limit reached (${monthlyOrders}/${limit.value}).`,
      'LIMIT_REACHED'
    );
  }
}

export async function openOrder(db: ScopedDb, input: OpenOrderInput): Promise<OpenOrderResult> {
  if (!isOperationalOrderChannel(input.channel) && input.channel !== 'DELIVERY') {
    throw new OrderCommandError(DELIVERY_CHANNEL_UNAVAILABLE_MESSAGE, 'CHANNEL_UNAVAILABLE');
  }
  if (input.channel === 'DELIVERY' && !input.customerId) {
    throw new OrderCommandError(
      'Delivery orders require a trusted customer.',
      'CHANNEL_UNAVAILABLE'
    );
  }
  const at = input.now ?? new Date();
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'order.open', input);
    if (idem.replay) {
      const order = await requireOrderSummary(tx, idem.resultRef);
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        businessDate: order.businessDate,
        replayed: true,
      };
    }

    const branch = await tx.restaurantBranch.findUnique({
      where: { id: input.branchId },
      select: { id: true, timezone: true, businessDayCutoff: true },
    });
    if (!branch) {
      throw new OrderCommandError('The branch does not exist.', 'BRANCH_NOT_FOUND');
    }

    const tableIds = input.tableIds ?? [];
    if (tableIds.length > 0 && input.channel !== 'DINE_IN') {
      throw new OrderCommandError(
        'Tables can only be attached to a dine-in order.',
        'CHANNEL_TABLE'
      );
    }
    await assertTablesInBranch(tx, branch.id, tableIds);

    const businessDate = businessDateToUtcDate(
      resolveBusinessDate(at, branch.timezone, branch.businessDayCutoff)
    );
    await enforceMonthlyOrderLimit(tx, input, businessDate);
    const orderNumber = await allocateOrderNumber(tx, { branchId: branch.id, businessDate });

    const serviceChargePolicy =
      input.channel === 'DINE_IN'
        ? await tx.restaurantServiceChargePolicyVersion.findFirst({
            where: {
              branchId: branch.id,
              effectiveFrom: { lte: at },
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
            },
            orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
            select: { id: true },
          })
        : null;

    let priceListVersionId: string | null = null;
    if (input.publicationId) {
      const refs = await resolveOrderPricingRefs(tx, {
        publicationId: input.publicationId,
        channel: input.channel,
        at,
      });
      priceListVersionId = refs.priceListVersionId;
    }

    const order = await tx.restaurantOrder.create({
      data: {
        branchId: branch.id,
        orderNumber,
        businessDate,
        status: 'OPEN',
        channel: input.channel,
        customerId: input.customerId ?? null,
        coverCount: input.coverCount ?? null,
        sectionId: input.sectionId ?? null,
        serverStaffProfileId: input.serverStaffProfileId ?? null,
        staffProfileId: input.actor.staffProfileId,
        deviceId: input.actor.deviceId,
        publicationId: input.publicationId ?? null,
        priceListVersionId,
        serviceChargePolicyVersionId: serviceChargePolicy?.id ?? null,
        openedAt: at,
      },
      select: { id: true },
    });

    for (const tableId of tableIds) {
      await tx.restaurantOrderTable.create({
        data: { orderId: order.id, tableId, active: true, linkReason: 'SEATED', linkedAt: at },
        select: { id: true },
      });
    }

    await record(tx, order, input.actor, 'order.opened', {
      orderNumber,
      channel: input.channel,
      tableIds,
      coverCount: input.coverCount ?? null,
      sectionId: input.sectionId ?? null,
      serverStaffProfileId: input.serverStaffProfileId ?? null,
      publicationId: input.publicationId ?? null,
      serviceChargePolicyVersionId: serviceChargePolicy?.id ?? null,
    });
    await recordIdempotentResult(tx, input.actor, order.id);

    return { orderId: order.id, orderNumber, businessDate, replayed: false };
  });
}

async function requireOrderSummary(tx: ScopedDb, orderId: string | null) {
  if (!orderId) {
    throw new OrderCommandError('The idempotent result reference is missing.', 'INVALID');
  }
  const order = await tx.restaurantOrder.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, businessDate: true },
  });
  if (!order) {
    throw new OrderCommandError('The order does not exist.', 'ORDER_NOT_FOUND');
  }
  return order;
}

// ── Add / adjust / remove (pre-send edits) ───────────────────────────────────

export type AddItemInput = {
  orderId: string;
  menuItemId: string;
  quantity?: number;
  course?: number;
  seatNumber?: number | null;
  modifierOptionIds?: readonly string[];
  actor: CommandActor;
  now?: Date;
};

export type ItemResult = { itemId: string; replayed: boolean };

export async function addItem(db: ScopedDb, input: AddItemInput): Promise<ItemResult> {
  const at = input.now ?? new Date();
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'item.add', input);
    if (idem.replay) return { itemId: idem.resultRef ?? '', replayed: true };

    await lockRestaurantOrder(tx, input.orderId);
    const order = await loadOrder(tx, input.orderId);
    assertMutable(order);
    if (order.channel === 'DELIVERY') {
      const fulfillment = await tx.restaurantDeliveryFulfillment.findFirst({
        where: { orderId: order.id },
        select: { status: true },
      });
      if (fulfillment && fulfillment.status !== 'PENDING') {
        throw new OrderCommandError(
          'Items cannot be added after a delivery has left pending fulfillment.',
          'ITEM_STATE'
        );
      }
    }
    if (!order.publicationId) {
      throw new OrderCommandError(
        'The order has no menu publication; items cannot be resolved.',
        'NO_PUBLICATION'
      );
    }

    const snapshot = await resolveItemSnapshot(tx, {
      publicationId: order.publicationId,
      channel: order.channel,
      menuItemId: input.menuItemId,
      modifierOptionIds: input.modifierOptionIds ?? [],
      at,
    });

    const item = await tx.restaurantOrderItem.create({
      data: {
        orderId: order.id,
        course: input.course ?? 1,
        seatNumber: input.seatNumber ?? null,
        productId: snapshot.productId,
        variantId: snapshot.variantId,
        name: snapshot.name,
        unitPrice: snapshot.unitPrice,
        quantity: input.quantity ?? 1,
        taxAmount: snapshot.taxAmount,
        serviceChargeAmount: snapshot.serviceChargeAmount,
        status: 'HELD',
        modifiers: {
          create: snapshot.modifiers.map((m) => ({
            modifierOptionId: m.modifierOptionId,
            name: m.name,
            priceDelta: m.priceDelta,
          })),
        },
      },
      select: { id: true },
    });

    await record(tx, order, input.actor, 'item.added', {
      itemId: item.id,
      menuItemId: input.menuItemId,
      productId: snapshot.productId,
      variantId: snapshot.variantId,
      name: snapshot.name,
      unitPrice: snapshot.unitPrice.toString(),
      quantity: input.quantity ?? 1,
      course: input.course ?? 1,
      priceSource: snapshot.priceSource,
      modifiers: snapshot.modifiers.map((m) => ({
        modifierOptionId: m.modifierOptionId,
        name: m.name,
        priceDelta: m.priceDelta.toString(),
      })),
    });
    await recordIdempotentResult(tx, input.actor, item.id);
    return { itemId: item.id, replayed: false };
  });
}

export type AdjustItemInput = {
  orderId: string;
  itemId: string;
  quantity?: number;
  course?: number;
  seatNumber?: number | null;
  modifierOptionIds?: readonly string[];
  actor: CommandActor;
};

export async function adjustItem(db: ScopedDb, input: AdjustItemInput): Promise<ItemResult> {
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'item.adjust', input);
    if (idem.replay) return { itemId: idem.resultRef ?? input.itemId, replayed: true };

    const order = await loadOrder(tx, input.orderId);
    assertMutable(order);
    const item = findItem(order, input.itemId);
    if (item.status !== 'HELD') {
      throw new OrderCommandError(
        'Only an unsent (HELD) item can be adjusted; void and re-add a sent item instead.',
        'ITEM_STATE'
      );
    }

    const data: Prisma.RestaurantOrderItemUncheckedUpdateInput = {};
    if (input.quantity !== undefined) data.quantity = input.quantity;
    if (input.course !== undefined) data.course = input.course;
    if (input.seatNumber !== undefined) data.seatNumber = input.seatNumber;

    let modifiers: { modifierOptionId: string; name: string; priceDelta: Prisma.Decimal }[] | null =
      null;
    if (input.modifierOptionIds !== undefined) {
      modifiers = await resolveModifierSnapshots(tx, item.productId, input.modifierOptionIds);
      await tx.restaurantOrderItemModifier.deleteMany({ where: { orderItemId: item.id } });
      for (const m of modifiers) {
        await tx.restaurantOrderItemModifier.create({
          data: {
            orderItemId: item.id,
            modifierOptionId: m.modifierOptionId,
            name: m.name,
            priceDelta: m.priceDelta,
          },
          select: { id: true },
        });
      }
    }

    if (Object.keys(data).length > 0) {
      await tx.restaurantOrderItem.update({ where: { id: item.id }, data });
    }

    await record(tx, order, input.actor, 'item.adjusted', {
      itemId: item.id,
      quantity: input.quantity ?? item.quantity,
      course: input.course ?? item.course,
      seatNumber: input.seatNumber ?? item.seatNumber,
      modifiers: modifiers?.map((m) => ({
        modifierOptionId: m.modifierOptionId,
        name: m.name,
        priceDelta: m.priceDelta.toString(),
      })),
    });
    await recordIdempotentResult(tx, input.actor, item.id);
    return { itemId: item.id, replayed: false };
  });
}

export type RemoveItemInput = {
  orderId: string;
  itemId: string;
  reason?: string | null;
  actor: CommandActor;
};

/** Remove an unsent item (pre-send). The item was never sent to the kitchen, so
 * no co-authorization is required; it moves HELD→VOIDED and its history is kept. */
export async function removeItem(db: ScopedDb, input: RemoveItemInput): Promise<ItemResult> {
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'item.remove', input);
    if (idem.replay) return { itemId: idem.resultRef ?? input.itemId, replayed: true };

    const order = await loadOrder(tx, input.orderId);
    assertMutable(order);
    const item = findItem(order, input.itemId);
    if (item.status !== 'HELD') {
      throw new OrderCommandError(
        'Only an unsent (HELD) item can be removed; use void for a sent item.',
        'ITEM_STATE'
      );
    }
    assertItemTransition(item.status, 'VOIDED');
    await tx.restaurantOrderItem.update({
      where: { id: item.id },
      data: {
        status: 'VOIDED',
        voidedPostPrep: false,
        wastageDisposition: 'NONE',
        voidReason: input.reason?.trim() || null,
      },
    });
    await record(tx, order, input.actor, 'item.removed', { itemId: item.id });
    await recordIdempotentResult(tx, input.actor, item.id);
    return { itemId: item.id, replayed: false };
  });
}

// ── Send / fire / hold ───────────────────────────────────────────────────────

export type SendOrderInput = { orderId: string; actor: CommandActor };
export type FireResult = {
  orderId: string;
  itemIds: string[];
  tickets: GeneratedTicket[];
  replayed: boolean;
};

/** Send the whole order to the kitchen: every HELD item across all courses moves
 * HELD→QUEUED and KOTs are generated. Order aggregate follows (→SENT). */
export async function sendOrder(db: ScopedDb, input: SendOrderInput): Promise<FireResult> {
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'order.send', input);
    if (idem.replay) {
      return { orderId: input.orderId, itemIds: [], tickets: [], replayed: true };
    }
    const order = await loadOrder(tx, input.orderId);
    assertMutable(order);
    const held = order.items.filter((i) => i.status === 'HELD');
    if (held.length === 0) {
      throw new OrderCommandError('The order has no held items to send.', 'NOTHING_TO_SEND');
    }
    const result = await fireItems(tx, order, held, input.actor, 'order.sent', null);
    await recordIdempotentResult(tx, input.actor, order.id);
    return result;
  });
}

export type FireCourseInput = { orderId: string; course: number; actor: CommandActor };

/** Fire one course: only that course's HELD items move HELD→QUEUED, and only they
 * get KOTs (§11.1 — unrelated courses are untouched). */
export async function fireCourse(db: ScopedDb, input: FireCourseInput): Promise<FireResult> {
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'course.fire', input);
    if (idem.replay) {
      return { orderId: input.orderId, itemIds: [], tickets: [], replayed: true };
    }
    const order = await loadOrder(tx, input.orderId);
    assertMutable(order);
    const held = order.items.filter((i) => i.status === 'HELD' && i.course === input.course);
    if (held.length === 0) {
      throw new OrderCommandError(
        `Course ${input.course} has no held items to fire.`,
        'NOTHING_TO_FIRE'
      );
    }
    const result = await fireItems(tx, order, held, input.actor, 'course.fired', input.course);
    await recordIdempotentResult(tx, input.actor, order.id);
    return result;
  });
}

/** Shared HELD→QUEUED + KOT-generation core used by send and fireCourse. */
async function fireItems(
  tx: ScopedDb,
  order: LoadedOrder,
  items: readonly LoadedItem[],
  actor: CommandActor,
  eventType: string,
  course: number | null
): Promise<FireResult> {
  for (const item of items) {
    assertItemTransition(item.status, 'QUEUED');
    await tx.restaurantOrderItem.update({ where: { id: item.id }, data: { status: 'QUEUED' } });
  }
  const fired: FiredItem[] = items.map((i) => ({
    orderItemId: i.id,
    productId: i.productId,
    categoryId: i.product.categoryId,
    quantity: i.quantity,
  }));
  const tickets = await generateKitchenTickets(tx, {
    orderId: order.id,
    branchId: order.branchId,
    businessDate: order.businessDate,
    items: fired,
  });
  await enqueueKitchenTicketPrintJobs(tx, {
    organizationId: order.organizationId,
    branchId: order.branchId,
    orderReference: `Order ${order.orderNumber}`,
    tickets,
    labelsByOrderItemId: Object.fromEntries(items.map((item) => [item.id, item.name])),
  });
  await record(tx, order, actor, eventType, {
    course,
    itemIds: items.map((i) => i.id),
    tickets: tickets.map((t) => ({
      ticketId: t.ticketId,
      stationId: t.stationId,
      ticketNumber: t.ticketNumber,
      matchedBy: t.matchedBy,
    })),
  });
  await syncAggregate(tx, order.id, order.status);
  return { orderId: order.id, itemIds: items.map((i) => i.id), tickets, replayed: false };
}

export type ReprintKitchenTicketInput = {
  orderId: string;
  ticketId: string;
  actor: CommandActor;
};

/** Queue a fresh KOT copy while making transport retries idempotent. */
export async function reprintKitchenTicket(
  db: ScopedDb,
  input: ReprintKitchenTicketInput
): Promise<{ orderId: string; ticketId: string; replayed: boolean }> {
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'kot.reprint', input);
    if (idem.replay) {
      return { orderId: input.orderId, ticketId: idem.resultRef ?? input.ticketId, replayed: true };
    }
    const order = await loadOrder(tx, input.orderId);
    const ticket = await tx.restaurantKitchenTicket.findFirst({
      where: { id: input.ticketId, orderId: order.id },
      select: {
        id: true,
        stationId: true,
        ticketNumber: true,
        createdAt: true,
        items: { select: { orderItemId: true, quantity: true } },
      },
    });
    if (!ticket) {
      throw new OrderCommandError(
        'The kitchen ticket does not exist on this order.',
        'TICKET_NOT_FOUND'
      );
    }
    const reprintKey = createHash('sha256')
      .update(`${ticket.id}:${input.actor.deviceId}:${input.actor.idempotencyKey}`)
      .digest('hex');
    const reprintTicket: GeneratedTicket = {
      ticketId: `reprint-${reprintKey}`,
      stationId: ticket.stationId,
      ticketNumber: ticket.ticketNumber,
      createdAt: new Date(),
      matchedBy: 'default',
      items: ticket.items,
    };
    const enqueued = await enqueueKitchenTicketPrintJobs(tx, {
      organizationId: order.organizationId,
      branchId: order.branchId,
      orderReference: `Order ${order.orderNumber} - KOT ${ticket.ticketNumber} - REPRINT`,
      tickets: [reprintTicket],
      labelsByOrderItemId: Object.fromEntries(order.items.map((item) => [item.id, item.name])),
    });
    if (enqueued === 0) {
      throw new OrderCommandError(
        'No enabled kitchen printer route matches this ticket station.',
        'PRINT_ROUTE_NOT_FOUND'
      );
    }
    await record(tx, order, input.actor, 'kot.reprinted', {
      ticketId: ticket.id,
      stationId: ticket.stationId,
      ticketNumber: ticket.ticketNumber,
    });
    await recordIdempotentResult(tx, input.actor, ticket.id);
    return { orderId: order.id, ticketId: ticket.id, replayed: false };
  });
}

export type HoldCourseInput = { orderId: string; course: number; actor: CommandActor };

/** Recall a course that was sent to the kitchen but has not started cooking:
 * its QUEUED items move QUEUED→HELD. FIRING/PREPARED items are not recalled. */
export async function holdCourse(
  db: ScopedDb,
  input: HoldCourseInput
): Promise<{ orderId: string; itemIds: string[]; replayed: boolean }> {
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'course.hold', input);
    if (idem.replay) return { orderId: input.orderId, itemIds: [], replayed: true };

    const order = await loadOrder(tx, input.orderId);
    assertMutable(order);
    const queued = order.items.filter((i) => i.status === 'QUEUED' && i.course === input.course);
    if (queued.length === 0) {
      throw new OrderCommandError(
        `Course ${input.course} has no queued items to hold.`,
        'ITEM_STATE'
      );
    }
    for (const item of queued) {
      assertItemTransition(item.status, 'HELD');
      await tx.restaurantOrderItem.update({ where: { id: item.id }, data: { status: 'HELD' } });
    }
    await record(tx, order, input.actor, 'course.held', {
      course: input.course,
      itemIds: queued.map((i) => i.id),
    });
    await syncAggregate(tx, order.id, order.status);
    await recordIdempotentResult(tx, input.actor, order.id);
    return { orderId: order.id, itemIds: queued.map((i) => i.id), replayed: false };
  });
}

// ── Forward item transitions (kitchen / service) ─────────────────────────────

export type AdvanceItemInput = {
  orderId: string;
  itemId: string;
  toStatus: 'FIRING' | 'PREPARED' | 'SERVED';
  actor: CommandActor;
};

/** Advance an item along the kitchen/service line (QUEUED→FIRING→PREPARED→SERVED,
 * and REMAKE_REQUESTED→SERVED to accept a remake back). Validated by the L1 state
 * machine; the order aggregate is re-derived afterwards. */
export async function advanceItem(db: ScopedDb, input: AdvanceItemInput): Promise<ItemResult> {
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'item.advance', input);
    if (idem.replay) return { itemId: idem.resultRef ?? input.itemId, replayed: true };

    const order = await loadOrder(tx, input.orderId);
    assertMutable(order);
    const item = findItem(order, input.itemId);
    assertItemTransition(item.status, input.toStatus);
    await tx.restaurantOrderItem.update({
      where: { id: item.id },
      data: { status: input.toStatus },
    });
    await record(tx, order, input.actor, 'item.advanced', {
      itemId: item.id,
      from: item.status,
      to: input.toStatus,
    });
    await syncAggregate(tx, order.id, order.status);
    await recordIdempotentResult(tx, input.actor, item.id);
    return { itemId: item.id, replayed: false };
  });
}

// ── Remake ───────────────────────────────────────────────────────────────────

export type RequestRemakeInput = {
  orderId: string;
  itemId: string;
  reason: string;
  actor: CommandActor;
};

export type RemakeResult = { itemId: string; remakeItemId: string; replayed: boolean };

/** Request a remake of a prepared/served item. The original moves to
 * REMAKE_REQUESTED (it must resolve — served or voided — before the order can
 * close, §11.1), and a new HELD item is created that clones the original's frozen
 * snapshot and stays linked to it via `remakeOfItemId`. */
export async function requestRemake(
  db: ScopedDb,
  input: RequestRemakeInput
): Promise<RemakeResult> {
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'item.remake', input);
    if (idem.replay) {
      return { itemId: input.itemId, remakeItemId: idem.resultRef ?? '', replayed: true };
    }
    const reason = requireReason(input.reason);
    const order = await loadOrder(tx, input.orderId);
    assertMutable(order);
    const item = findItem(order, input.itemId);
    assertItemTransition(item.status, 'REMAKE_REQUESTED');

    await tx.restaurantOrderItem.update({
      where: { id: item.id },
      data: { status: 'REMAKE_REQUESTED', voidReason: reason },
    });

    const originalModifiers = await tx.restaurantOrderItemModifier.findMany({
      where: { orderItemId: item.id },
      select: { modifierOptionId: true, name: true, priceDelta: true },
    });
    const remake = await tx.restaurantOrderItem.create({
      data: {
        orderId: order.id,
        course: item.course,
        seatNumber: item.seatNumber,
        productId: item.productId,
        variantId: item.variantId,
        name: item.name,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        taxAmount: item.taxAmount,
        serviceChargeAmount: item.serviceChargeAmount,
        status: 'HELD',
        remakeOfItemId: item.id,
        modifiers: {
          create: originalModifiers.map((m) => ({
            modifierOptionId: m.modifierOptionId,
            name: m.name,
            priceDelta: m.priceDelta,
          })),
        },
      },
      select: { id: true },
    });

    await record(tx, order, input.actor, 'item.remake_requested', {
      originalItemId: item.id,
      remakeItemId: remake.id,
      reason,
    });
    await syncAggregate(tx, order.id, order.status);
    await recordIdempotentResult(tx, input.actor, remake.id);
    return { itemId: item.id, remakeItemId: remake.id, replayed: false };
  });
}

// ── Void (pre-prep and post-prep) ────────────────────────────────────────────

export type VoidItemInput = {
  orderId: string;
  itemId: string;
  reason: string;
  wastageDisposition?: WastageDisposition;
  /** Required for a post-preparation void: the approving manager (C6). */
  approvingStaffProfileId?: string | null;
  actor: CommandActor;
};

/** Void an item. A pre-preparation void (HELD/QUEUED) needs only a reason; a
 * post-preparation void (FIRING/PREPARED/SERVED/REMAKE_REQUESTED) additionally
 * requires a co-authorization and a recorded wastage disposition — the disposition
 * is recorded but no inventory mutation exists until the inventory milestone (C6 /
 * BUILD-ASSUMPTIONS). Item + event history is preserved. */
export async function voidItem(db: ScopedDb, input: VoidItemInput): Promise<ItemResult> {
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'item.void', input);
    if (idem.replay) return { itemId: idem.resultRef ?? input.itemId, replayed: true };

    const reason = requireReason(input.reason);
    // A bill is an immutable snapshot of the active order items. Serialize with
    // bill cutting on the parent row, then reject a void that would otherwise
    // leave the kitchen aggregate and the amount payable disagreeing. The guest
    // must void-and-recut the open bill before changing the item set.
    await lockRestaurantOrder(tx, input.orderId);
    const order = await loadOrder(tx, input.orderId);
    assertMutable(order);
    const item = findItem(order, input.itemId);
    assertItemTransition(item.status, 'VOIDED');

    const liveBill = await tx.restaurantBill.findFirst({
      where: { orderId: order.id, status: { not: 'VOID' } },
      select: { id: true },
    });
    if (liveBill) {
      throw new OrderCommandError(
        'An item cannot be voided after a bill is cut; void and recut the bill first.',
        'BILL_ALREADY_CUT'
      );
    }

    const postPrep = isPostPrep(item.status);
    let voidCoAuthorizationId: string | null = null;
    let disposition: WastageDisposition = 'NONE';

    if (postPrep) {
      if (!input.approvingStaffProfileId) {
        throw new OrderCommandError(
          'A post-preparation void requires a co-authorizing manager.',
          'CO_AUTH_REQUIRED'
        );
      }
      if (!input.wastageDisposition) {
        throw new OrderCommandError(
          'A post-preparation void requires a wastage disposition (WASTE, RESTOCK or NONE).',
          'DISPOSITION_REQUIRED'
        );
      }
      disposition = input.wastageDisposition;
      voidCoAuthorizationId = await persistCoAuth(tx, {
        actingStaffProfileId: input.actor.staffProfileId,
        approvingStaffProfileId: input.approvingStaffProfileId,
        capability: 'orders:void',
        reason,
        targetType: 'RestaurantOrderItem',
        targetId: item.id,
        deviceId: input.actor.deviceId,
      });
    }

    await tx.restaurantOrderItem.update({
      where: { id: item.id },
      data: {
        status: 'VOIDED',
        voidedPostPrep: postPrep,
        wastageDisposition: disposition,
        voidCoAuthorizationId,
        voidReason: reason,
      },
    });
    await record(tx, order, input.actor, 'item.voided', {
      itemId: item.id,
      postPrep,
      wastageDisposition: disposition,
      coAuthorizationId: voidCoAuthorizationId,
      reason,
    });
    await syncAggregate(tx, order.id, order.status);
    await recordIdempotentResult(tx, input.actor, item.id);
    return { itemId: item.id, replayed: false };
  });
}

async function persistCoAuth(
  tx: ScopedDb,
  request: Parameters<typeof buildCoAuthorizationRecord>[0]
): Promise<string> {
  const record = buildCoAuthorizationRecord(request);
  const row = await tx.restaurantCoAuthorization.create({ data: record, select: { id: true } });
  return row.id;
}

// ── Cancel / close ───────────────────────────────────────────────────────────

export type CancelOrderInput = {
  orderId: string;
  reason: string;
  wastageDisposition?: WastageDisposition;
  approvingStaffProfileId?: string | null;
  actor: CommandActor;
};

/** Cancel an order. Every still-active item is voided with a compensating
 * transition first (§11.1 — a cancelled order may retain no in-flight kitchen
 * item); if any active item is post-preparation, a co-authorization is required
 * (C6). */
export async function cancelOrder(
  db: ScopedDb,
  input: CancelOrderInput
): Promise<{ orderId: string; replayed: boolean }> {
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'order.cancel', input);
    if (idem.replay) return { orderId: input.orderId, replayed: true };

    const reason = requireReason(input.reason);
    await tx.$queryRaw`SELECT "id" FROM "restaurant_orders" WHERE "id" = ${input.orderId} FOR UPDATE`;
    const order = await loadOrder(tx, input.orderId);
    assertMutable(order);

    if (order.channel === 'DELIVERY') {
      const fulfillments = await tx.$queryRaw<Array<{ id: string; status: string }>>(
        Prisma.sql`SELECT "id", "status" FROM "restaurant_delivery_fulfillments" WHERE "orderId" = ${order.id} ORDER BY "id" FOR UPDATE`
      );
      const bills = await tx.$queryRaw<Array<{ id: string; status: string }>>(
        Prisma.sql`SELECT "id", "status" FROM "restaurant_bills" WHERE "orderId" = ${order.id} ORDER BY "id" FOR UPDATE`
      );
      const tenders = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT t."id" FROM "restaurant_tenders" t JOIN "restaurant_bills" b ON b."id" = t."billId" WHERE b."orderId" = ${order.id} ORDER BY t."id" FOR UPDATE OF t`
      );
      if (
        tenders.length > 0 ||
        bills.some((bill) => bill.status !== 'OPEN' && bill.status !== 'VOID') ||
        fulfillments.some((fulfillment) => ['DISPATCHED', 'DELIVERED'].includes(fulfillment.status))
      ) {
        throw new OrderCommandError(
          'A tendered, dispatched, or delivered delivery order cannot be cancelled.',
          'NOT_CLOSABLE'
        );
      }
      await tx.restaurantBill.updateMany({
        where: { orderId: order.id, status: 'OPEN' },
        data: { status: 'VOID', voidReason: reason },
      });
      await tx.restaurantDeliveryFulfillment.updateMany({
        where: { orderId: order.id, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
    }

    const active = order.items.filter((i) => !isResolvedItem(i.status));
    const anyPostPrep = active.some((i) => isPostPrep(i.status));
    let coAuthId: string | null = null;
    let disposition: WastageDisposition = 'NONE';
    if (anyPostPrep) {
      if (!input.approvingStaffProfileId) {
        throw new OrderCommandError(
          'Cancelling an order with prepared items requires a co-authorizing manager.',
          'CO_AUTH_REQUIRED'
        );
      }
      disposition = input.wastageDisposition ?? 'NONE';
      coAuthId = await persistCoAuth(tx, {
        actingStaffProfileId: input.actor.staffProfileId,
        approvingStaffProfileId: input.approvingStaffProfileId,
        capability: 'orders:cancel',
        reason,
        targetType: 'RestaurantOrder',
        targetId: order.id,
        deviceId: input.actor.deviceId,
      });
    }

    for (const item of active) {
      assertItemTransition(item.status, 'VOIDED');
      const post = isPostPrep(item.status);
      await tx.restaurantOrderItem.update({
        where: { id: item.id },
        data: {
          status: 'VOIDED',
          voidedPostPrep: post,
          wastageDisposition: post ? disposition : 'NONE',
          voidCoAuthorizationId: post ? coAuthId : null,
          voidReason: reason,
        },
      });
      await record(tx, order, input.actor, 'item.voided', {
        itemId: item.id,
        postPrep: post,
        wastageDisposition: post ? disposition : 'NONE',
        coAuthorizationId: post ? coAuthId : null,
        reason,
        viaCancel: true,
      });
    }

    const finalStatuses = order.items.map((i) =>
      active.some((a) => a.id === i.id) ? 'VOIDED' : i.status
    ) as OrderItemStatus[];
    assertOrderStatusChange(order.status, 'CANCELLED', finalStatuses);
    const cancelledAt = new Date();
    await tx.restaurantOrder.update({
      where: { id: order.id },
      data: { status: 'CANCELLED', cancelledAt },
    });
    await tx.restaurantOrderTable.updateMany({
      where: { orderId: order.id, active: true },
      data: { active: false, unlinkedAt: cancelledAt },
    });
    await record(tx, order, input.actor, 'order.cancelled', {
      reason,
      voidedItemIds: active.map((i) => i.id),
      coAuthorizationId: coAuthId,
    });
    await recordIdempotentResult(tx, input.actor, order.id);
    return { orderId: order.id, replayed: false };
  });
}

export type CloseOrderInput = { orderId: string; actor: CommandActor; now?: Date };

/** Close an order. Guarded: every item must be resolved (served or voided) and no
 * remake may remain unresolved (§11.1). Walks SERVED→PAYMENT_PENDING→CLOSED
 * (pay-before-fulfilment is disabled in M4, C5); an order not yet fully served is
 * not closable — void or serve its items, or cancel the order, first. */
export async function closeOrder(
  db: ScopedDb,
  input: CloseOrderInput
): Promise<{ orderId: string; replayed: boolean }> {
  const closedAt = input.now ?? new Date();
  if (!(closedAt instanceof Date) || !Number.isFinite(closedAt.getTime())) {
    throw new OrderCommandError('The close timestamp is invalid.', 'INVALID');
  }
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'order.close', input);
    if (idem.replay) return { orderId: input.orderId, replayed: true };

    await tx.$queryRaw`SELECT "id" FROM "restaurant_orders" WHERE "id" = ${input.orderId} FOR UPDATE`;
    const order = await loadOrder(tx, input.orderId);
    if (order.status === 'CANCELLED') {
      throw new OrderCommandError('A cancelled order cannot be closed.', 'ORDER_TERMINAL');
    }
    if (order.channel === 'DELIVERY') {
      const [fulfillment] = await tx.$queryRaw<Array<{ status: string }>>(
        Prisma.sql`SELECT "status" FROM "restaurant_delivery_fulfillments" WHERE "orderId" = ${order.id} FOR UPDATE`
      );
      if (fulfillment?.status !== 'DELIVERED') {
        throw new OrderCommandError(
          'A delivery order cannot close before fulfillment is delivered.',
          'NOT_CLOSABLE'
        );
      }
    }
    const itemStatuses = order.items.map((i) => i.status);

    let status = order.status;
    const wasServed = status === 'SERVED';
    if (wasServed) {
      assertOrderStatusChange(status, 'PAYMENT_PENDING', itemStatuses);
      await tx.restaurantOrder.update({
        where: { id: order.id },
        data: { status: 'PAYMENT_PENDING' },
      });
      await record(tx, order, input.actor, 'order.payment_pending', {});
      status = 'PAYMENT_PENDING';
    }
    if (status !== 'PAYMENT_PENDING') {
      throw new OrderCommandError(
        'The order is not ready to close; every item must be served or voided first.',
        'NOT_CLOSABLE'
      );
    }
    // M5-L2 settlement guard (C12): before PAYMENT_PENDING → CLOSED the money must be
    // fully accounted — every non-voided item allocated to a bill (or the total
    // fractionally allocated), every bill SETTLED or VOID, and Σ (bill grand totals +
    // comps + discounts − exclusive tax) ≡ the derived order total. The §11.1 state machine is unchanged; this is
    // a pre-transition guard. An order that has just moved SERVED → PAYMENT_PENDING and
    // is not yet settled is PARKED there awaiting tender (a later close finalizes it,
    // no error); an already-pending order asked to close while unsettled is rejected.
    const settlement = await evaluateOrderSettlement(tx, order.id);
    if (!settlement.settled) {
      if (wasServed) {
        await recordIdempotentResult(tx, input.actor, order.id);
        return { orderId: order.id, replayed: false };
      }
      throw new OrderCommandError(
        `The order cannot close until it is fully settled (${settlement.blocker}).`,
        'NOT_SETTLED'
      );
    }
    assertOrderStatusChange(status, 'CLOSED', itemStatuses);
    await tx.restaurantOrder.update({
      where: { id: order.id },
      data: { status: 'CLOSED', closedAt },
    });
    await tx.restaurantOrderTable.updateMany({
      where: { orderId: order.id, active: true },
      data: { active: false, unlinkedAt: closedAt },
    });
    await record(tx, order, input.actor, 'order.closed', {});
    await earnLoyaltyForClosedOrder(tx, order.id, closedAt);
    // M6-L2: recipe consumption at order close (C6 disposition applied per item).
    await postOrderRecipeConsumption(
      tx,
      order.id,
      order.branchId,
      order.items,
      { staffProfileId: input.actor.staffProfileId, deviceId: input.actor.deviceId },
      closedAt
    );
    await recordIdempotentResult(tx, input.actor, order.id);
    return { orderId: order.id, replayed: false };
  });
}

// ── Table move / merge / unlink ──────────────────────────────────────────────

export type MoveTableInput = {
  orderId: string;
  fromTableId: string;
  toTableId: string;
  actor: CommandActor;
};

export async function moveTable(
  db: ScopedDb,
  input: MoveTableInput
): Promise<{ orderId: string; replayed: boolean }> {
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'table.move', input);
    if (idem.replay) return { orderId: input.orderId, replayed: true };

    const order = await loadOrder(tx, input.orderId);
    assertMutable(order);
    await assertTablesInBranch(tx, order.branchId, [input.toTableId]);

    const link = await tx.restaurantOrderTable.findFirst({
      where: { orderId: order.id, tableId: input.fromTableId, active: true },
      select: { id: true },
    });
    if (!link) {
      throw new OrderCommandError(
        'The order is not actively linked to the source table.',
        'TABLE_LINK_NOT_FOUND'
      );
    }
    const now = new Date();
    await tx.restaurantOrderTable.update({
      where: { id: link.id },
      data: { active: false, unlinkedAt: now },
    });
    await tx.restaurantOrderTable.create({
      data: {
        orderId: order.id,
        tableId: input.toTableId,
        active: true,
        linkReason: 'MOVE',
        linkedAt: now,
      },
      select: { id: true },
    });
    await record(tx, order, input.actor, 'table.moved', {
      fromTableId: input.fromTableId,
      toTableId: input.toTableId,
    });
    await recordIdempotentResult(tx, input.actor, order.id);
    return { orderId: order.id, replayed: false };
  });
}

export type MergeTablesInput = {
  orderId: string;
  tableIds: readonly string[];
  actor: CommandActor;
};

/** Merge additional tables under one order: each becomes an active MERGE link
 * (already-active tables are skipped). Combining two OPEN orders into one is
 * deferred (BUILD-ASSUMPTIONS). */
export async function mergeTables(
  db: ScopedDb,
  input: MergeTablesInput
): Promise<{ orderId: string; addedTableIds: string[]; replayed: boolean }> {
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'table.merge', input);
    if (idem.replay) return { orderId: input.orderId, addedTableIds: [], replayed: true };

    const order = await loadOrder(tx, input.orderId);
    assertMutable(order);
    if (input.tableIds.length === 0) {
      throw new OrderCommandError('No tables to merge.', 'INVALID');
    }
    await assertTablesInBranch(tx, order.branchId, input.tableIds);

    const activeLinks = await tx.restaurantOrderTable.findMany({
      where: { orderId: order.id, active: true },
      select: { tableId: true },
    });
    const alreadyActive = new Set(activeLinks.map((l) => l.tableId));
    const now = new Date();
    const added: string[] = [];
    for (const tableId of input.tableIds) {
      if (alreadyActive.has(tableId)) continue;
      await tx.restaurantOrderTable.create({
        data: { orderId: order.id, tableId, active: true, linkReason: 'MERGE', linkedAt: now },
        select: { id: true },
      });
      added.push(tableId);
    }
    await record(tx, order, input.actor, 'tables.merged', { addedTableIds: added });
    await recordIdempotentResult(tx, input.actor, order.id);
    return { orderId: order.id, addedTableIds: added, replayed: false };
  });
}

export type UnlinkTableInput = { orderId: string; tableId: string; actor: CommandActor };

export async function unlinkTable(
  db: ScopedDb,
  input: UnlinkTableInput
): Promise<{ orderId: string; replayed: boolean }> {
  return runInTransaction(db, async (tx) => {
    const idem = await beginIdempotent(tx, input.actor, 'table.unlink', input);
    if (idem.replay) return { orderId: input.orderId, replayed: true };

    const order = await loadOrder(tx, input.orderId);
    assertMutable(order);
    const link = await tx.restaurantOrderTable.findFirst({
      where: { orderId: order.id, tableId: input.tableId, active: true },
      select: { id: true },
    });
    if (!link) {
      throw new OrderCommandError(
        'The order is not actively linked to that table.',
        'TABLE_LINK_NOT_FOUND'
      );
    }
    await tx.restaurantOrderTable.update({
      where: { id: link.id },
      data: { active: false, unlinkedAt: new Date() },
    });
    await record(tx, order, input.actor, 'table.unlinked', { tableId: input.tableId });
    await recordIdempotentResult(tx, input.actor, order.id);
    return { orderId: order.id, replayed: false };
  });
}
