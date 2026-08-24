import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import { readJson } from '@/lib/api-json';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { CoAuthorizationError } from './co-authorization';
import { KitchenTicketError } from './kitchen-tickets';
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
const CHANNEL = z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']);
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
    channel: CHANNEL,
    publicationId: ID.nullish(),
    tableIds: z.array(ID).optional(),
    coverCount: z.number().int().min(0).nullish(),
    sectionId: ID.nullish(),
    serverStaffProfileId: ID.nullish(),
  })
  .strict();

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

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

/** 400 when the mutating command has no idempotency key. */
export function missingIdempotencyKey(): NextResponse {
  return json({ error: 'Missing Idempotency-Key header.' }, 400);
}

/** 400 with the strict-schema validation issues. */
export function invalidBody(issues: z.ZodIssue[]): NextResponse {
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

/**
 * Authenticate an inline manager co-authorization for a post-prep void / cancel.
 * Mirrors the `/terminal/co-authorize` credential check: a locked credential is a
 * 423 with `Retry-After`, an invalid one a 401. On success returns the approving
 * staff id for the command layer to pin on the co-authorization evidence.
 */
export async function authenticateApprover(
  db: ScopedDb,
  deviceId: string,
  approving: z.infer<typeof APPROVING>,
  now: Date
): Promise<{ ok: true; staffProfileId: string } | { ok: false; response: NextResponse }> {
  const auth: OperatorAuthResult = await authenticateOperator(db, {
    staffProfileId: approving.staffProfileId,
    deviceId,
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
  return withTerminalAuth(
    async (ctx, request) => {
      const operator = requireActingOperator(ctx);
      if (!operator.ok) return operator.response;

      const key = idempotencyKeyFromRequest(request);
      if (!key) return missingIdempotencyKey();

      const parsedJson = await readJson(request);
      if (!parsedJson.ok) return parsedJson.response;
      const parsed = schema.safeParse(parsedJson.data);
      if (!parsed.success) return invalidBody(parsed.error.issues);

      const actor = buildActor(operator.staffProfileId, ctx.device.id, key);
      const result = await run({ ctx, data: parsed.data, actor });
      return NextResponse.json(result as Record<string, unknown>, { status: successStatus });
    },
    { mapError: orderErrorResponse }
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
      err.reason === 'NOTHING_TO_FIRE';
    const notFound = err.reason.endsWith('_NOT_FOUND');
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
      itemCount: order.items.length,
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
    },
  });
  if (!order) return null;

  const activeItems = order.items.filter((i) => i.status !== 'VOIDED');
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
      tax: money(new Prisma.Decimal(0)),
      serviceCharge: money(new Prisma.Decimal(0)),
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

      return {
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        displayName: item.displayName,
        nameLocalized: item.nameLocalized,
        sortOrder: item.sortOrder,
        product: item.product,
        variant: item.variant,
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
