import 'server-only';

import { createHash } from 'node:crypto';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import { readJson } from '@/lib/api-json';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { loadBranchCommercialTerms } from './branch-commercial-terms';
import { reviveCommercialTerms } from './commercial-terms';
import { CoAuthorizationError } from './co-authorization';
import { quoteDraftCheckBreakdown } from './draft-check-total';
import { operatorHasCapability } from './checkout-routes';
import { KitchenTicketError } from './kitchen-tickets';
import { DELIVERY_CHANNEL_UNAVAILABLE_MESSAGE, orderChannelSchema } from './order-channels';
import {
  channelPublished,
  isItemAvailableAt,
  partitionWindows,
  type AvailabilityException,
  type AvailabilityWindow,
  type OrderChannel,
} from './menu-availability';
import { OrderCommandError, type CommandActor } from './orders';
import { OrderPricingError } from './order-pricing';
import { OrderInvariantError, OrderTransitionError } from './order-state-machine';
import { pickEntry, resolveEffectiveEntries, type ResolvedPriceList } from './price-lists';
import {
  authenticateOperator,
  withTerminalAuth,
  type OperatorAuthResult,
  type TerminalContext,
} from './terminal-auth';

/**
 * M4-L4 — the POS-terminal transport glue over the L2 order command layer.
 *
 * Routes stay THIN (the M2 terminal pattern): they authenticate the device +
 * operator, parse a STRICT body (C7 — `.strict()`, unknown fields rejected, never
 * stripped), build the attribution + idempotency envelope from the trusted
 * transport (operator = the session's active staff, terminal = the authenticated
 * device, key = the `Idempotency-Key` header — never the untrusted body), dispatch
 * to the single command layer, and shape any domain error into a clean HTTP status
 * WITHOUT leaking internals. No order/kitchen domain logic lives here — the command
 * layer owns the state machine, the ledger append and the idempotency record (C2/
 * C3/C7).
 *
 * The device-scoped read model this lane owns (C10, consumed by L5b): the terminal's
 * open-orders list, one order's detail, and the device-authed effective-menu read.
 * A POS pad has no web session, so it cannot reach the M3 `effectiveMenu` tRPC read;
 * `resolveTerminalEffectiveMenu` reaches the SAME resolution by composing the same
 * exported M3 primitives the back-office read uses (the `order-pricing.ts`
 * precedent), never by modifying an M3 file (C9).
 */

// ── Strict input schemas (C7) ────────────────────────────────────────────────

const ID = z.string().min(1);
const DISPOSITION = z.enum(['WASTE', 'RESTOCK', 'NONE']);

/** A manager co-authorization presented inline for a post-preparation void or a
 * cancel-with-prepared-items (C6). The manager proves their own credential at the
 * terminal; the command layer records the co-authorization evidence. */
const APPROVING = z
  .object({
    staffProfileId: ID,
    type: z.enum(['PIN', 'BADGE']),
    secret: z.string().min(1),
  })
  .strict();

export const openOrderBody = z
  .object({
    // branchId is the terminal's bound branch (from the device), never the body.
    channel: orderChannelSchema,
    customerId: ID.optional(),
    publicationId: ID.nullish(),
    tableIds: z.array(ID).optional(),
    coverCount: z.number().int().min(0).nullish(),
    sectionId: ID.nullish(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.channel === 'DELIVERY' && !value.customerId) {
      ctx.addIssue({
        code: 'custom',
        path: ['customerId'],
        message: 'Select a customer for delivery.',
      });
    }
    if (value.channel === 'DELIVERY' && value.tableIds?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['tableIds'],
        message: 'Delivery orders cannot have tables.',
      });
    }
  });

export const addItemBody = z
  .object({
    orderId: ID,
    menuItemId: ID,
    quantity: z.number().int().min(1).optional(),
    course: z.number().int().min(1).optional(),
    seatNumber: z.number().int().min(1).nullish(),
    modifierOptionIds: z.array(ID).optional(),
  })
  .strict();

export const holdBody = z.object({ orderId: ID, course: z.number().int().min(1) }).strict();

/** Fire the whole order (no `course`) or a single course. */
export const fireBody = z
  .object({ orderId: ID, course: z.number().int().min(1).optional() })
  .strict();

export const reprintKotBody = z.object({ orderId: ID, ticketId: ID }).strict();

export const markServedBody = z.object({ orderId: ID, itemId: ID }).strict();

export const remakeBody = z.object({ orderId: ID, itemId: ID, reason: z.string().min(1) }).strict();

export const voidBody = z
  .object({
    orderId: ID,
    itemId: ID,
    reason: z.string().min(1),
    wastageDisposition: DISPOSITION.optional(),
    approving: APPROVING.optional(),
  })
  .strict();

export const cancelBody = z
  .object({
    orderId: ID,
    reason: z.string().min(1),
    wastageDisposition: DISPOSITION.optional(),
    approving: APPROVING.optional(),
  })
  .strict();

export const closeBody = z.object({ orderId: ID }).strict();

export const moveTableBody = z.object({ orderId: ID, fromTableId: ID, toTableId: ID }).strict();

export const mergeTablesBody = z.object({ orderId: ID, tableIds: z.array(ID).min(1) }).strict();

// ── Transport helpers ────────────────────────────────────────────────────────

const IDEMPOTENCY_HEADER = 'idempotency-key';

/** The device-scoped idempotency key every mutating terminal command must carry
 * (C7). Returns null when absent/blank so the route can reject with a 400. */
export function idempotencyKeyFromRequest(request: Request): string | null {
  const raw = request.headers.get(IDEMPOTENCY_HEADER)?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** Build the command attribution envelope from trusted transport values only. */
export function buildActor(
  staffProfileId: string,
  deviceId: string,
  idempotencyKey: string
): CommandActor {
  return { staffProfileId, deviceId, idempotencyKey };
}

/**
 * Object-level authorization for terminal order mutations. Organization RLS remains
 * the outer boundary; this pins an untrusted order id to the authenticated device's
 * branch before any command, co-authorization, or other side effect can run.
 */
export async function requireOrderInDeviceBranch(
  db: ScopedDb,
  orderId: string,
  branchId: string
): Promise<void> {
  const order = await db.restaurantOrder.findFirst({
    where: { id: orderId, branchId },
    select: { id: true },
  });
  if (!order) throw new OrderCommandError('The order does not exist.', 'ORDER_NOT_FOUND');
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

/** 400 when the mutating command has no idempotency key. */
export function missingIdempotencyKey(): NextResponse {
  return json({ error: 'Missing Idempotency-Key header.' }, 400);
}

/** 400 with the strict-schema validation issues. */
export function invalidBody(issues: z.ZodIssue[]): NextResponse {
  if (issues.some((issue) => issue.message === DELIVERY_CHANNEL_UNAVAILABLE_MESSAGE)) {
    return json({ error: DELIVERY_CHANNEL_UNAVAILABLE_MESSAGE }, 400);
  }
  return json({ error: 'Invalid input', details: issues }, 400);
}

/**
 * The POS terminal's acting operator: the session's active staff on an UNLOCKED
 * terminal. A LOCKED terminal (no operator bound) cannot issue an attributable
 * order command (C6), so it is a 409 telling the pad to unlock first.
 */
export function requireActingOperator(
  ctx: TerminalContext
): { ok: true; staffProfileId: string } | { ok: false; response: NextResponse } {
  if (ctx.state !== 'UNLOCKED' || !ctx.session.activeStaffProfileId) {
    return {
      ok: false,
      response: json(
        { error: 'No acting operator: unlock the terminal before issuing order commands.' },
        409
      ),
    };
  }
  return { ok: true, staffProfileId: ctx.session.activeStaffProfileId };
}

export async function requireOrderTakingCapability(
  ctx: TerminalContext,
  staffProfileId: string,
  requireCustomerRead = false
): Promise<NextResponse | null> {
  const now = new Date();
  const branchId = ctx.device.branchId;
  if (!(await operatorHasCapability(ctx.db, staffProfileId, 'orders:take', now, branchId))) {
    return json({ error: 'This operator lacks the "orders:take" capability.' }, 403);
  }
  if (
    requireCustomerRead &&
    !(await operatorHasCapability(ctx.db, staffProfileId, 'customers:read', now, branchId))
  ) {
    return json({ error: 'This operator lacks the "customers:read" capability.' }, 403);
  }
  return null;
}

/**
 * Authenticate an inline manager co-authorization for a post-prep void / cancel.
 * Mirrors the `/terminal/co-authorize` credential check: a locked credential is a
 * 423 with `Retry-After`, an invalid one a 401. On success returns the approving
 * staff id for the command layer to pin on the co-authorization evidence.
 */
export async function authenticateApprover(
  db: ScopedDb,
  deviceId: string,
  branchId: string,
  approving: z.infer<typeof APPROVING>,
  now: Date
): Promise<{ ok: true; staffProfileId: string } | { ok: false; response: NextResponse }> {
  const auth: OperatorAuthResult = await authenticateOperator(db, {
    staffProfileId: approving.staffProfileId,
    deviceId,
    branchId,
    type: approving.type,
    secret: approving.secret,
    now,
  });
  if (!auth.ok) {
    if (auth.reason === 'LOCKED') {
      return {
        ok: false,
        response: json(
          { error: "Approving manager's credential is temporarily locked." },
          423
        ) as NextResponse,
      };
    }
    return { ok: false, response: json({ error: 'Invalid approving credential.' }, 401) };
  }
  return { ok: true, staffProfileId: auth.staffProfileId };
}

/**
 * The shared shape of a POS terminal command route: authenticate device + session
 * (via `withTerminalAuth`), require an acting operator (C6) and an idempotency key
 * (C7), parse the STRICT body, build the attribution envelope, dispatch to the
 * command layer, and shape any domain error. `run` receives the trusted context,
 * the parsed body and the actor, and returns the command result to serialise. A
 * non-domain throw is rethrown so the transport wrapper answers a generic 500
 * (no internals leaked). Commands with their own pre-dispatch handshake (a post-
 * prep void / cancel co-authorization) are written out longhand instead.
 */
export function terminalCommandRoute<S extends z.ZodTypeAny>(
  schema: S,
  run: (args: { ctx: TerminalContext; data: z.infer<S>; actor: CommandActor }) => Promise<unknown>,
  successStatus = 200
) {
  const parseBody = async (request: Request) => {
    const parsedJson = await readJson(request);
    if (!parsedJson.ok) return { ok: false as const, response: parsedJson.response };
    const parsed = schema.safeParse(parsedJson.data);
    if (!parsed.success) {
      return { ok: false as const, response: invalidBody(parsed.error.issues) };
    }
    return { ok: true as const, data: parsed.data };
  };

  return withTerminalAuth(
    async (ctx, request) => {
      const operator = requireActingOperator(ctx);
      if (!operator.ok) return operator.response;

      const key = idempotencyKeyFromRequest(request);
      if (!key) return missingIdempotencyKey();

      const parsed = await parseBody(request);
      if (!parsed.ok) return parsed.response;

      const data = parsed.data as unknown;
      const capabilityError = await requireOrderTakingCapability(
        ctx,
        operator.staffProfileId,
        typeof data === 'object' &&
          data !== null &&
          'channel' in data &&
          data.channel === 'DELIVERY'
      );
      if (capabilityError) return capabilityError;
      if (
        typeof data === 'object' &&
        data !== null &&
        'orderId' in data &&
        typeof data.orderId === 'string'
      ) {
        await requireOrderInDeviceBranch(ctx.db, data.orderId, ctx.device.branchId);
      }

      const actor = buildActor(operator.staffProfileId, ctx.device.id, key);
      const result = await run({ ctx, data: parsed.data, actor });
      return NextResponse.json(result as Record<string, unknown>, { status: successStatus });
    },
    {
      mapError: orderErrorResponse,
      preflight: async (request) => {
        const parsed = await parseBody(request.clone());
        return parsed.ok ? null : parsed.response;
      },
    }
  );
}

// ── Domain-error → HTTP shaping (no internals leaked) ─────────────────────────

/**
 * Map an order-domain error onto the right HTTP response, mirroring the L2 tRPC
 * mapping (`restaurant-orders.ts`): NOT_FOUND → 404, a state/precondition conflict
 * → 409, everything else a 400. The messages are authored domain strings (no
 * secrets, no internals). Returns null for a non-domain error so the route can
 * rethrow it and let the transport wrapper return a generic 500.
 */
export function orderErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof OrderCommandError) {
    const conflict =
      err.reason === 'ORDER_TERMINAL' ||
      err.reason === 'ITEM_STATE' ||
      err.reason === 'NOT_CLOSABLE' ||
      err.reason === 'NOTHING_TO_SEND' ||
      err.reason === 'NOTHING_TO_FIRE' ||
      err.reason === 'PRINT_ROUTE_NOT_FOUND';
    const notFound = err.reason.endsWith('_NOT_FOUND') && err.reason !== 'PRINT_ROUTE_NOT_FOUND';
    const status = notFound ? 404 : conflict ? 409 : 400;
    return json({ error: err.message }, status);
  }
  if (err instanceof OrderPricingError) {
    const notFound =
      err.reason === 'PUBLICATION_NOT_FOUND' ||
      err.reason === 'ITEM_NOT_ON_MENU' ||
      err.reason === 'MODIFIER_NOT_FOUND';
    const status = notFound ? 404 : err.reason === 'ITEM_UNAVAILABLE' ? 409 : 400;
    return json({ error: err.message }, status);
  }
  if (err instanceof OrderTransitionError || err instanceof OrderInvariantError) {
    return json({ error: err.message }, 409);
  }
  if (err instanceof KitchenTicketError) {
    return json({ error: err.message }, 409);
  }
  if (err instanceof CoAuthorizationError) {
    return json({ error: err.message }, 400);
  }
  return null;
}

// ── Device-scoped read model (C10) ───────────────────────────────────────────

const money = (value: Prisma.Decimal): string => value.toString();

type PricedItem = {
  unitPrice: Prisma.Decimal;
  quantity: number;
  modifiers: { priceDelta: Prisma.Decimal }[];
};

/** Derived subtotal over non-voided items (there is no stored total, C3). */
function deriveSubtotal(items: readonly PricedItem[]): Prisma.Decimal {
  return items.reduce((sum, item) => {
    const modifiers = item.modifiers.reduce(
      (acc, m) => acc.plus(m.priceDelta),
      new Prisma.Decimal(0)
    );
    return sum.plus(item.unitPrice.plus(modifiers).times(item.quantity));
  }, new Prisma.Decimal(0));
}

/** Order statuses that are still "open on the floor" — everything but the two
 * terminal states. The terminal's open-orders list shows exactly these. */
const OPEN_ORDER_STATUSES = [
  'DRAFT',
  'OPEN',
  'SENT',
  'IN_PREPARATION',
  'READY',
  'SERVED',
  'PAYMENT_PENDING',
] as const;

/**
 * The terminal's open-orders list for its bound branch (C10, consumed by L5b).
 * Branch-scoped to the device's branch; RLS scopes it to the device's organization.
 */
export async function listOpenOrdersForBranch(db: ScopedDb, branchId: string) {
  const rows = await db.restaurantOrder.findMany({
    where: { branchId, status: { in: [...OPEN_ORDER_STATUSES] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      orderNumber: true,
      businessDate: true,
      status: true,
      channel: true,
      coverCount: true,
      sectionId: true,
      serverStaffProfileId: true,
      openedAt: true,
      items: {
        where: { status: { not: 'VOIDED' } },
        select: { unitPrice: true, quantity: true, modifiers: { select: { priceDelta: true } } },
      },
      orderTables: { where: { active: true }, select: { tableId: true } },
    },
  });
  return {
    orders: rows.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      businessDate: order.businessDate.toISOString().slice(0, 10),
      status: order.status,
      channel: order.channel,
      coverCount: order.coverCount,
      sectionId: order.sectionId,
      serverStaffProfileId: order.serverStaffProfileId,
      openedAt: order.openedAt,
      activeTableIds: order.orderTables.map((t) => t.tableId),
      itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
      subtotal: money(deriveSubtotal(order.items)),
    })),
  };
}

/**
 * One order's detail for the terminal, branch-scoped (C10, consumed by L5b).
 * Returns null when the order does not exist in the device's branch (the route
 * then answers 404 — a cross-branch or cross-tenant id is indistinguishable from
 * "not found", which is exactly the isolation we want).
 */
export async function getOrderForBranch(db: ScopedDb, orderId: string, branchId: string) {
  const order = await db.restaurantOrder.findFirst({
    where: { id: orderId, branchId },
    select: {
      id: true,
      branchId: true,
      orderNumber: true,
      businessDate: true,
      status: true,
      channel: true,
      coverCount: true,
      sectionId: true,
      serverStaffProfileId: true,
      staffProfileId: true,
      deviceId: true,
      publicationId: true,
      openedAt: true,
      closedAt: true,
      cancelledAt: true,
      items: {
        orderBy: [{ course: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          course: true,
          seatNumber: true,
          productId: true,
          variantId: true,
          name: true,
          unitPrice: true,
          quantity: true,
          taxAmount: true,
          serviceChargeAmount: true,
          status: true,
          remakeOfItemId: true,
          voidedPostPrep: true,
          wastageDisposition: true,
          voidReason: true,
          modifiers: { select: { id: true, modifierOptionId: true, name: true, priceDelta: true } },
        },
      },
      orderTables: {
        orderBy: { linkedAt: 'asc' },
        select: {
          id: true,
          tableId: true,
          active: true,
          linkReason: true,
          linkedAt: true,
          unlinkedAt: true,
        },
      },
      kitchenTickets: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          stationId: true,
          ticketNumber: true,
          createdAt: true,
          items: { select: { orderItemId: true, quantity: true } },
        },
      },
      deliveryFulfillment: { select: { deliveryFeeSnapshot: true } },
    },
  });
  if (!order) return null;

  const activeItems = order.items.filter((i) => i.status !== 'VOIDED');
  const at = new Date();
  const terms = reviveCommercialTerms(await loadBranchCommercialTerms(db, order.branchId, at));
  const quoted = quoteDraftCheckBreakdown({
    at,
    lines: activeItems.map((item) => ({
      id: item.id,
      unitPrice: item.unitPrice.toString(),
      quantity: item.quantity,
      modifierDeltas: item.modifiers.map((modifier) => modifier.priceDelta.toString()),
    })),
    serviceChargeRate: order.channel === 'DINE_IN' ? (terms.serviceChargeRate ?? '0') : '0',
    deliveryFee: (
      order.deliveryFulfillment?.deliveryFeeSnapshot ?? new Prisma.Decimal(0)
    ).toString(),
    ...(terms.profiles.length > 0 ? { profiles: terms.profiles, rules: terms.rules } : {}),
  });
  return {
    id: order.id,
    branchId: order.branchId,
    orderNumber: order.orderNumber,
    businessDate: order.businessDate.toISOString().slice(0, 10),
    status: order.status,
    channel: order.channel,
    coverCount: order.coverCount,
    sectionId: order.sectionId,
    serverStaffProfileId: order.serverStaffProfileId,
    staffProfileId: order.staffProfileId,
    deviceId: order.deviceId,
    publicationId: order.publicationId,
    openedAt: order.openedAt,
    closedAt: order.closedAt,
    cancelledAt: order.cancelledAt,
    items: order.items.map((item) => ({
      id: item.id,
      course: item.course,
      seatNumber: item.seatNumber,
      productId: item.productId,
      variantId: item.variantId,
      name: item.name,
      unitPrice: money(item.unitPrice),
      quantity: item.quantity,
      taxAmount: money(item.taxAmount),
      serviceChargeAmount: money(item.serviceChargeAmount),
      status: item.status,
      remakeOfItemId: item.remakeOfItemId,
      voidedPostPrep: item.voidedPostPrep,
      wastageDisposition: item.wastageDisposition,
      voidReason: item.voidReason,
      modifiers: item.modifiers.map((m) => ({
        id: m.id,
        modifierOptionId: m.modifierOptionId,
        name: m.name,
        priceDelta: money(m.priceDelta),
      })),
    })),
    tables: order.orderTables,
    kitchenTickets: order.kitchenTickets.map((ticket) => ({
      id: ticket.id,
      stationId: ticket.stationId,
      ticketNumber: ticket.ticketNumber,
      createdAt: ticket.createdAt,
      items: ticket.items,
    })),
    totals: {
      subtotal: money(deriveSubtotal(activeItems)),
      tax: quoted.tax,
      serviceCharge: quoted.serviceCharge,
      deliveryFee: money(order.deliveryFulfillment?.deliveryFeeSnapshot ?? new Prisma.Decimal(0)),
    },
  };
}

// ── Device-authed effective-menu read (C10, consumed by L5b) ─────────────────

export type EffectiveMenuItem = {
  id: string;
  productId: string;
  variantId: string | null;
  displayName: string | null;
  nameLocalized: Prisma.JsonValue | null;
  sortOrder: number;
  product: {
    id: string;
    name: string;
    type: string;
    status: string;
    nameLocalized: Prisma.JsonValue | null;
    descriptionLocalized: Prisma.JsonValue | null;
  };
  variant: { id: string; name: string; nameLocalized: Prisma.JsonValue | null } | null;
  modifierGroups: Array<{
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number | null;
    options: Array<{ id: string; name: string; priceDelta: string }>;
  }>;
  price: string | null;
  priceSource: 'OVERRIDE' | 'PUBLICATION_LIST' | 'BASE_LIST' | 'NONE';
  available: boolean;
};

export type ResolveTerminalEffectiveMenuInput = {
  branchId: string;
  channel: OrderChannel;
  /** An explicit publication; absent = the branch's live PUBLISHED publication for
   * the channel. */
  publicationId?: string | null;
  /** Server evaluation instant (availability is server-time only, C5). */
  at: Date;
};

/**
 * The terminal's effective-menu read for its branch/channel. Resolves the target
 * publication (explicit, or the branch's live one), then composes the winning
 * price (item override > publication list > base list) and branch-timezone
 * availability from the SAME exported M3 primitives the back-office `effectiveMenu`
 * read uses. Returns null when no publication is resolvable (route → 404).
 */
export async function resolveTerminalEffectiveMenu(
  db: ScopedDb,
  input: ResolveTerminalEffectiveMenuInput
) {
  const publication = input.publicationId
    ? await db.restaurantBranchMenuPublication.findFirst({
        where: { id: input.publicationId, branchId: input.branchId },
        select: publicationSelect,
      })
    : await db.restaurantBranchMenuPublication.findFirst({
        where: {
          branchId: input.branchId,
          status: 'PUBLISHED',
          channels: { has: input.channel },
        },
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        select: publicationSelect,
      });
  if (!publication) return null;

  const channelOpen = channelPublished(publication.channels as OrderChannel[], input.channel);

  const publicationList: ResolvedPriceList | null = publication.priceListId
    ? await resolveEffectiveEntries(db, publication.priceListId, input.at)
    : null;
  const defaultList = await db.restaurantPriceList.findFirst({
    where: { isDefault: true },
    select: { id: true },
  });
  let baseList: ResolvedPriceList | null = null;
  if (defaultList) {
    baseList =
      defaultList.id === publication.priceListId
        ? publicationList
        : await resolveEffectiveEntries(db, defaultList.id, input.at);
  }

  const overrideByItem = new Map(publication.itemOverrides.map((o) => [o.menuItemId, o]));
  const allWindows: AvailabilityWindow[] = publication.windows.map((w) => ({
    menuItemId: w.menuItemId,
    daysOfWeek: w.daysOfWeek,
    startMinutes: w.startMinutes,
    endMinutes: w.endMinutes,
  }));
  const exceptions: AvailabilityException[] = publication.exceptions.map((e) => ({
    date: e.date,
    isClosed: e.isClosed,
  }));

  const sections = publication.menu.sections.map((section) => ({
    id: section.id,
    name: section.name,
    nameLocalized: section.nameLocalized,
    sortOrder: section.sortOrder,
    items: section.items.map((item): EffectiveMenuItem => {
      const override = overrideByItem.get(item.id) ?? null;
      const { publicationWindows, itemWindows } = partitionWindows(allWindows, item.id);

      let price: string | null = null;
      let priceSource: EffectiveMenuItem['priceSource'] = 'NONE';
      if (override?.priceOverride != null) {
        price = override.priceOverride.toString();
        priceSource = 'OVERRIDE';
      } else {
        const pub = publicationList
          ? pickEntry(publicationList.entries, item.productId, item.variantId)
          : null;
        if (pub) {
          price = pub.price.toString();
          priceSource = 'PUBLICATION_LIST';
        } else {
          const base = baseList
            ? pickEntry(baseList.entries, item.productId, item.variantId)
            : null;
          if (base) {
            price = base.price.toString();
            priceSource = 'BASE_LIST';
          }
        }
      }

      const overrideAvailable = override ? override.isAvailable : true;
      const available =
        channelOpen &&
        overrideAvailable &&
        isItemAvailableAt({
          timezone: publication.branch.timezone,
          at: input.at,
          publicationWindows,
          itemWindows,
          exceptions,
        });

      const { modifierGroups, ...product } = item.product;
      return {
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        displayName: item.displayName,
        nameLocalized: item.nameLocalized,
        sortOrder: item.sortOrder,
        product,
        variant: item.variant,
        modifierGroups: modifierGroups.map(({ modifierGroup }) => ({
          ...modifierGroup,
          options: modifierGroup.options.map((option) => ({
            ...option,
            priceDelta: option.priceDelta.toString(),
          })),
        })),
        price,
        priceSource,
        available,
      };
    }),
  }));

  return {
    publicationId: publication.id,
    branchId: input.branchId,
    channel: input.channel,
    channelOpen,
    menu: {
      id: publication.menu.id,
      name: publication.menu.name,
      nameLocalized: publication.menu.nameLocalized,
    },
    sections,
  };
}

// ── Effective-menu version / ETag (M9-L1, criterion 5) ───────────────────────

/**
 * The device-authed effective-menu query. STRICT like every other terminal input
 * (C7): an unknown search parameter is a 400, never silently ignored, so a client
 * cannot believe it asked for something the server never read.
 */
export const effectiveMenuQuery = z
  .object({
    channel: orderChannelSchema,
    publicationId: ID.optional(),
    at: z.string().datetime().optional(),
  })
  .strict();

export type TerminalEffectiveMenu = NonNullable<
  Awaited<ReturnType<typeof resolveTerminalEffectiveMenu>>
>;

/** The version algorithm; bumping it invalidates every cached catalog at once. */
const EFFECTIVE_MENU_VERSION_PREFIX = 'v1';

/**
 * Serialize a JSON value with object keys in a stable order, so two structurally
 * identical payloads always produce the same bytes. Property order out of Prisma is
 * stable for our own literals, but the localized-name blobs are free-form JSON whose
 * key order is not guaranteed — without this, an identical menu could hash twice.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
  return `{${entries.join(',')}}`;
}

/**
 * A deterministic version for one resolved effective menu (M9 §3.6). It is derived
 * from the COMPLETE resolved payload — publication, channel openness, every section,
 * item, winning price, price source and availability flag — because a publication's
 * children and its time windows change without any single row version to watch. Two
 * identical payloads therefore always produce the same version, and any price, tax,
 * publication, channel or 86 change produces a different one.
 */
export function effectiveMenuVersion(menu: TerminalEffectiveMenu): string {
  const digest = createHash('sha256').update(canonicalJson(menu)).digest('hex').slice(0, 32);
  return `${EFFECTIVE_MENU_VERSION_PREFIX}:${digest}`;
}

/** The strong entity tag for a version. */
export function effectiveMenuETag(version: string): string {
  return `"${version}"`;
}

/**
 * Whether an `If-None-Match` request matches the current entity tag (so the route
 * can answer 304 and the terminal can keep the catalog it already has). Handles the
 * comma-separated list form and the `W/` weak prefix; `*` matches any existing
 * entity, per RFC 9110.
 */
export function ifNoneMatchSatisfied(header: string | null, etag: string): boolean {
  if (!header) return false;
  const normalize = (tag: string) => tag.trim().replace(/^W\//, '');
  const target = normalize(etag);
  return header
    .split(',')
    .map(normalize)
    .some((candidate) => candidate === '*' || candidate === target);
}

/** The publication shape the effective-menu resolver loads (mirrors the M3 read). */
const publicationSelect = {
  id: true,
  channels: true,
  priceListId: true,
  branch: { select: { id: true, timezone: true } },
  windows: {
    select: { menuItemId: true, daysOfWeek: true, startMinutes: true, endMinutes: true },
  },
  exceptions: { select: { date: true, isClosed: true } },
  itemOverrides: { select: { menuItemId: true, isAvailable: true, priceOverride: true } },
  menu: {
    select: {
      id: true,
      name: true,
      nameLocalized: true,
      sections: {
        orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }],
        select: {
          id: true,
          name: true,
          nameLocalized: true,
          sortOrder: true,
          items: {
            orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }],
            select: {
              id: true,
              productId: true,
              variantId: true,
              displayName: true,
              nameLocalized: true,
              sortOrder: true,
              product: {
                select: {
                  id: true,
                  name: true,
                  type: true,
                  status: true,
                  nameLocalized: true,
                  descriptionLocalized: true,
                  modifierGroups: {
                    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
                    select: {
                      modifierGroup: {
                        select: {
                          id: true,
                          name: true,
                          minSelect: true,
                          maxSelect: true,
                          options: {
                            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
                            select: { id: true, name: true, priceDelta: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
              variant: { select: { id: true, name: true, nameLocalized: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.RestaurantBranchMenuPublicationSelect;
