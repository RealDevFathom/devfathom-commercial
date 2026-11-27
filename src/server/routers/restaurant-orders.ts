import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { router, capabilityProcedure, type TRPCContext } from '../trpc';
import { assertInOrganization } from '../org-refs';
import { annotateAudit } from '../audit';
import { requireRestaurantBranchScope } from '../restaurant-branch-scope';
import { businessDateToUtcDate } from '@/lib/restaurant/business-date';
import { add, multiply, roundMoney, sum as sumMoney } from '@/lib/restaurant/money-arithmetic';
import { CoAuthorizationError } from '@/lib/restaurant/co-authorization';
import {
  APPROVER_REFUSED_MESSAGE,
  verifyBackOfficeApprover,
  withBackOfficeApprovalScope,
  type ApprovalMode,
} from '@/lib/restaurant/back-office-approval';
import { requireSessionStaffProfileId } from '@/lib/restaurant/session-staff';
import { KitchenTicketError } from '@/lib/restaurant/kitchen-tickets';
import { OrderPricingError } from '@/lib/restaurant/order-pricing';
import { operationalOrderChannelSchema, orderChannelSchema } from '@/lib/restaurant/order-channels';
import { OrderInvariantError, OrderTransitionError } from '@/lib/restaurant/order-state-machine';
import {
  OrderCommandError,
  addItem,
  adjustItem,
  advanceItem,
  cancelOrder,
  closeOrder,
  fireCourse,
  holdCourse,
  mergeTables,
  moveTable,
  openOrder,
  removeItem,
  requestRemake,
  sendOrder,
  unlinkTable,
  voidItem,
  type CommandActor,
} from '@/lib/restaurant/orders';

/**
 * M4-L2 — the back-office order server surface: the order/kitchen-ticket read
 * model (C10, consumed by L5a) and the manager-level order mutations.
 *
 * Reads are gated by `capabilityProcedure('orders:read')`; mutations by
 * `capabilityProcedure('orders:manage')`, except the maker-checker void/cancel
 * commands, which gate on the narrower `capabilityProcedure('orders:void')` the
 * manager role templates grant — all org-role-driven through the ABAC
 * engine (no static policy, see `abac/policies.ts`), the licensed `restaurant-pos`
 * module (`module-catalog.ts`) and the audit middleware. Tenant scoping is the
 * RLS-forced `organizationId` default on every row (C1).
 *
 * Mutations are thin: every one delegates to the single command layer
 * (`@/lib/restaurant/orders`) — the only writer of the status columns (C3) — which
 * runs one transaction that appends the ledger event + outbox row (C2), enforces
 * the §11.1 state machine and invariants, and honours the device-scoped
 * idempotency key (C7). The router only validates input (`.strict()`, house style
 * — unknown fields rejected, never stripped) and serialises money. Server time is
 * authoritative (C6): commands stamp `new Date()`, never a client timestamp.
 *
 * Money crosses the tRPC boundary as a STRING (C4): superjson does not carry a
 * Prisma `Decimal`, and no monetary value may round-trip through a float, so every
 * price/delta/derived total in a response is serialised with `Decimal.toString()`.
 * There is no stored order total — totals are DERIVED here from the frozen item
 * snapshots (C3/C4), so governance can re-compute them from durable rows.
 *
 * **Read contract (C10, consumed by L5a):** `listOrders` (branch/businessDate/
 * status/channel filters + pagination), `getOrder` (items incl. modifiers +
 * snapshots, event history, tickets, table links, derived totals) and
 * `listKitchenTickets` (branch/station/businessDate). A console lane missing a read
 * routes the defect back through the Chief of Staff to this lane — it never adds
 * its own server query.
 */

const ORDER_STATUS = z.enum([
  'DRAFT',
  'OPEN',
  'SENT',
  'IN_PREPARATION',
  'READY',
  'SERVED',
  'PAYMENT_PENDING',
  'CLOSED',
  'CANCELLED',
]);
const DISPOSITION = z.enum(['WASTE', 'RESTOCK', 'NONE']);
const BUSINESS_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a "YYYY-MM-DD" business date.');
const ID = z.string().min(1);

/** The idempotency envelope every mutating command carries (C6/C7). DEV-1055: who
 * acted is never taken from the request. The acting staff member is the caller's
 * own session staff profile at the order's branch, so the legacy `staffProfileId`
 * is accepted for older clients and never used. The session has no terminal of its
 * own, so `deviceId` only names which registered terminal the back office is
 * acting for; the server accepts it only when it is an ACTIVE, unrevoked device of
 * the order's own branch (see `resolveSessionActor`). A replay of the same
 * (deviceId, key) creates nothing. */
const SESSION_ACTOR = z.object({
  staffProfileId: ID.optional(),
  deviceId: ID,
  idempotencyKey: ID,
});

/**
 * DEV-1055: build the command actor from the signed-in session. The caller must be
 * in scope for the branch (primary branch, explicit assignment, or the org-wide
 * `restaurant:configure`), acts as their own ACTIVE staff profile for that branch,
 * and may only name a terminal that is registered, ACTIVE and unrevoked at that
 * same branch. Nothing in the request can attribute the action to another person,
 * another branch's terminal or a revoked one.
 */
async function resolveSessionActor(
  ctx: TRPCContext,
  branchId: string,
  actor: z.infer<typeof SESSION_ACTOR>
): Promise<CommandActor> {
  await requireRestaurantBranchScope(ctx, branchId);
  const staffProfileId = await requireSessionStaffProfileId(ctx, { branchId });
  const deviceId = await requireBranchDevice(ctx, branchId, actor.deviceId);
  return { staffProfileId, deviceId, idempotencyKey: actor.idempotencyKey };
}

/** The named terminal must be a registered, ACTIVE, unrevoked device of this branch. */
async function requireBranchDevice(
  ctx: TRPCContext,
  branchId: string,
  deviceId: string
): Promise<string> {
  const device = await ctx.db.restaurantRegisteredDevice.findFirst({
    where: { id: deviceId, branchId, status: 'ACTIVE', revokedAt: null },
    select: { id: true },
  });
  if (!device) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'That terminal is not an active device at this branch.',
    });
  }
  return device.id;
}

/** `resolveSessionActor` for a command on an existing order: the branch is the
 * order's own, read server-side inside the tenant. */
async function resolveOrderSessionActor(
  ctx: TRPCContext,
  orderId: string,
  actor: z.infer<typeof SESSION_ACTOR>
): Promise<CommandActor> {
  const order = await ctx.db.restaurantOrder.findUnique({
    where: { id: orderId },
    select: { branchId: true },
  });
  if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'Order not found.' });
  return resolveSessionActor(ctx, order.branchId, actor);
}

/** The approving staff member's own credential, re-verified on the server. */
const APPROVING_CREDENTIAL = z
  .object({
    type: z.enum(['PIN', 'BADGE']),
    secret: z.string().min(1).max(256),
  })
  .strict();

type ApproverInput = {
  orderId: string;
  approvingStaffProfileId?: string | null;
  approvingCredential?: z.infer<typeof APPROVING_CREDENTIAL> | null;
  actor: z.infer<typeof SESSION_ACTOR>;
};

/**
 * Back-office maker-checker for a void / cancel (H5 / C6). The acting staff is
 * the caller's own session staff profile — the `actor.staffProfileId` in the
 * input is ignored, so a caller cannot attribute the action to someone else —
 * and the caller must be in scope for the order's branch.
 * A named approver must prove who they are with their own PIN or badge, checked
 * server-side with durable lockout, and must hold `coauth:approve` at the
 * order's branch. A sole owner may approve their own request only after a
 * fresh PIN (see `verifyBackOfficeApprover`). `work` runs inside the approval
 * scope, so the co-authorization record written by the command carries the
 * verified approver and, for the solo case, the owner-reauthentication stamp.
 */
async function withApprovedOrderCommand<T>(
  ctx: TRPCContext,
  input: ApproverInput,
  work: (args: { actor: CommandActor; approvingStaffProfileId: string | null }) => Promise<T>
): Promise<{ result: T; approvalMode: ApprovalMode | null }> {
  const order = await ctx.db.restaurantOrder.findUnique({
    where: { id: input.orderId },
    select: { branchId: true },
  });
  // Branch boundary above tenant RLS (#638): `orders:void` is granted to
  // branch-bound roles (Branch Manager), so the caller must also be scoped to the
  // order's branch — primary branch, explicit assignment, or the org-wide
  // `restaurant:configure`. A missing order is reported by the command itself.
  if (order) await requireRestaurantBranchScope(ctx, order.branchId);
  // Resolved against the order's branch, so a multi-branch employee acts as their
  // profile for that branch.
  const actingStaffProfileId = await requireSessionStaffProfileId(ctx, {
    branchId: order?.branchId,
  });
  const actor: CommandActor = {
    staffProfileId: actingStaffProfileId,
    // A missing order is reported by the command; an existing one only accepts a
    // terminal of its own branch (DEV-1055).
    deviceId: order
      ? await requireBranchDevice(ctx, order.branchId, input.actor.deviceId)
      : input.actor.deviceId,
    idempotencyKey: input.actor.idempotencyKey,
  };
  const approvingStaffProfileId = input.approvingStaffProfileId?.trim() || null;
  if (!approvingStaffProfileId) {
    if (input.approvingCredential) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'An approving credential requires an approving staff member.',
      });
    }
    return { result: await work({ actor, approvingStaffProfileId: null }), approvalMode: null };
  }
  if (!input.approvingCredential) {
    // An approver id alone is not proof of approval.
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: "The approving staff member's PIN or badge is required.",
    });
  }
  const credential = input.approvingCredential;
  if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'Order not found.' });

  return withBackOfficeApprovalScope(
    { actingStaffProfileId, deviceId: actor.deviceId },
    async () => {
      const approval = await verifyBackOfficeApprover(ctx.db, {
        organizationId: ctx.entitlements.organizationId!,
        actingStaffProfileId,
        approvingStaffProfileId,
        type: credential.type,
        secret: credential.secret,
        capability: 'coauth:approve',
        branchId: order.branchId,
        deviceId: actor.deviceId,
      });
      if (!approval.ok) {
        throw new TRPCError({ code: 'FORBIDDEN', message: APPROVER_REFUSED_MESSAGE });
      }
      return {
        result: await work({ actor, approvingStaffProfileId: approval.staffProfileId }),
        approvalMode: approval.mode,
      };
    }
  );
}

const money = (value: Prisma.Decimal): string => value.toString();

/** Translate an order-domain error into the right tRPC status; rethrow the rest. */
function mapDomainError(err: unknown): never {
  if (err instanceof OrderCommandError) {
    const conflict =
      err.reason === 'ORDER_TERMINAL' ||
      err.reason === 'ITEM_STATE' ||
      err.reason === 'NOT_CLOSABLE' ||
      err.reason === 'NOTHING_TO_SEND' ||
      err.reason === 'NOTHING_TO_FIRE' ||
      err.reason === 'BILL_ALREADY_CUT' ||
      err.reason === 'DAY_CLOSED' ||
      err.reason === 'LIMIT_REACHED' ||
      err.reason === 'LIMIT_UNAVAILABLE' ||
      err.reason === 'IDEMPOTENCY_CONFLICT';
    const notFound = err.reason.endsWith('_NOT_FOUND');
    const code = notFound ? 'NOT_FOUND' : conflict ? 'CONFLICT' : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  if (err instanceof OrderPricingError) {
    const notFound =
      err.reason === 'PUBLICATION_NOT_FOUND' ||
      err.reason === 'ITEM_NOT_ON_MENU' ||
      err.reason === 'MODIFIER_NOT_FOUND';
    const code = notFound
      ? 'NOT_FOUND'
      : err.reason === 'ITEM_UNAVAILABLE'
        ? 'CONFLICT'
        : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  if (err instanceof OrderTransitionError || err instanceof OrderInvariantError) {
    throw new TRPCError({ code: 'CONFLICT', message: err.message });
  }
  if (err instanceof KitchenTicketError) {
    throw new TRPCError({ code: 'CONFLICT', message: err.message });
  }
  if (err instanceof CoAuthorizationError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  }
  throw err;
}

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    mapDomainError(err);
  }
}

const readProcedure = capabilityProcedure('orders:read');
const manageProcedure = capabilityProcedure('orders:manage');
const voidProcedure = capabilityProcedure('orders:void');

export const restaurantOrdersRouter = router({
  // ── Read model (C10) ─────────────────────────────────────────────────────────
  listOrders: readProcedure
    .input(
      z
        .object({
          branchId: ID,
          businessDate: BUSINESS_DATE.optional(),
          status: ORDER_STATUS.optional(),
          channel: orderChannelSchema.optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: ID.optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => listOrders(ctx.db, input)),

  getOrder: readProcedure
    .input(z.object({ orderId: ID }).strict())
    .query(async ({ ctx, input }) => getOrder(ctx.db, input.orderId)),

  listKitchenTickets: readProcedure
    .input(
      z
        .object({
          branchId: ID,
          businessDate: BUSINESS_DATE.optional(),
          stationId: ID.optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => listKitchenTickets(ctx.db, input)),

  // ── Order lifecycle (orders:manage) ───────────────────────────────────────────
  open: manageProcedure
    .input(
      z
        .object({
          branchId: ID,
          channel: operationalOrderChannelSchema,
          publicationId: ID.nullish(),
          tableIds: z.array(ID).optional(),
          coverCount: z.number().int().min(0).nullish(),
          sectionId: ID.nullish(),
          serverStaffProfileId: ID.nullish(),
          actor: SESSION_ACTOR,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements.organizationId;
      if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
      await assertInOrganization(ctx.db.restaurantBranch, organizationId, [input.branchId], {
        active: true,
      });
      const actor = await resolveSessionActor(ctx, input.branchId, input.actor);
      const result = await run(() =>
        openOrder(ctx.db, {
          organizationId: ctx.entitlements.organizationId,
          entitlementLimits: ctx.entitlements.limits,
          branchId: input.branchId,
          channel: input.channel,
          publicationId: input.publicationId ?? null,
          tableIds: input.tableIds,
          coverCount: input.coverCount ?? null,
          sectionId: input.sectionId ?? null,
          serverStaffProfileId: input.serverStaffProfileId ?? null,
          actor,
        })
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: result.orderId,
        description: 'Opened an order',
        metadata: { orderNumber: result.orderNumber, replayed: result.replayed },
      });
      return { ...result, businessDate: result.businessDate.toISOString().slice(0, 10) };
    }),

  addItem: manageProcedure
    .input(
      z
        .object({
          orderId: ID,
          menuItemId: ID,
          quantity: z.number().int().min(1).optional(),
          course: z.number().int().min(1).optional(),
          seatNumber: z.number().int().min(1).nullish(),
          modifierOptionIds: z.array(ID).optional(),
          actor: SESSION_ACTOR,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveOrderSessionActor(ctx, input.orderId, input.actor);
      const result = await run(() =>
        addItem(ctx.db, {
          orderId: input.orderId,
          menuItemId: input.menuItemId,
          quantity: input.quantity,
          course: input.course,
          seatNumber: input.seatNumber ?? null,
          modifierOptionIds: input.modifierOptionIds,
          actor,
        })
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Added an order item',
        metadata: { itemId: result.itemId, replayed: result.replayed },
      });
      return result;
    }),

  adjustItem: manageProcedure
    .input(
      z
        .object({
          orderId: ID,
          itemId: ID,
          quantity: z.number().int().min(1).optional(),
          course: z.number().int().min(1).optional(),
          seatNumber: z.number().int().min(1).nullish(),
          modifierOptionIds: z.array(ID).optional(),
          actor: SESSION_ACTOR,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveOrderSessionActor(ctx, input.orderId, input.actor);
      const result = await run(() =>
        adjustItem(ctx.db, {
          orderId: input.orderId,
          itemId: input.itemId,
          quantity: input.quantity,
          course: input.course,
          seatNumber: input.seatNumber ?? null,
          modifierOptionIds: input.modifierOptionIds,
          actor,
        })
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Adjusted an order item',
        metadata: { itemId: input.itemId, replayed: result.replayed },
      });
      return result;
    }),

  removeItem: manageProcedure
    .input(
      z
        .object({ orderId: ID, itemId: ID, reason: z.string().nullish(), actor: SESSION_ACTOR })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveOrderSessionActor(ctx, input.orderId, input.actor);
      const result = await run(() =>
        removeItem(ctx.db, {
          orderId: input.orderId,
          itemId: input.itemId,
          reason: input.reason ?? null,
          actor,
        })
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Removed an unsent order item',
        metadata: { itemId: input.itemId, replayed: result.replayed },
      });
      return result;
    }),

  send: manageProcedure
    .input(z.object({ orderId: ID, actor: SESSION_ACTOR }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveOrderSessionActor(ctx, input.orderId, input.actor);
      const result = await run(() => sendOrder(ctx.db, { orderId: input.orderId, actor }));
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Sent an order to the kitchen',
        metadata: { itemCount: result.itemIds.length, replayed: result.replayed },
      });
      return serializeFire(result);
    }),

  fireCourse: manageProcedure
    .input(
      z.object({ orderId: ID, course: z.number().int().min(1), actor: SESSION_ACTOR }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveOrderSessionActor(ctx, input.orderId, input.actor);
      const result = await run(() =>
        fireCourse(ctx.db, {
          orderId: input.orderId,
          course: input.course,
          actor,
        })
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Fired a course',
        metadata: { course: input.course, replayed: result.replayed },
      });
      return serializeFire(result);
    }),

  holdCourse: manageProcedure
    .input(
      z.object({ orderId: ID, course: z.number().int().min(1), actor: SESSION_ACTOR }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveOrderSessionActor(ctx, input.orderId, input.actor);
      const result = await run(() =>
        holdCourse(ctx.db, {
          orderId: input.orderId,
          course: input.course,
          actor,
        })
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Recalled a course to hold',
        metadata: { course: input.course, replayed: result.replayed },
      });
      return result;
    }),

  advanceItem: manageProcedure
    .input(
      z
        .object({
          orderId: ID,
          itemId: ID,
          toStatus: z.enum(['FIRING', 'PREPARED', 'SERVED']),
          actor: SESSION_ACTOR,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveOrderSessionActor(ctx, input.orderId, input.actor);
      const result = await run(() =>
        advanceItem(ctx.db, {
          orderId: input.orderId,
          itemId: input.itemId,
          toStatus: input.toStatus,
          actor,
        })
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Advanced an order item',
        metadata: { itemId: input.itemId, toStatus: input.toStatus, replayed: result.replayed },
      });
      return result;
    }),

  requestRemake: manageProcedure
    .input(
      z
        .object({ orderId: ID, itemId: ID, reason: z.string().min(1), actor: SESSION_ACTOR })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveOrderSessionActor(ctx, input.orderId, input.actor);
      const result = await run(() =>
        requestRemake(ctx.db, {
          orderId: input.orderId,
          itemId: input.itemId,
          reason: input.reason,
          actor,
        })
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Requested a remake',
        metadata: {
          itemId: input.itemId,
          remakeItemId: result.remakeItemId,
          replayed: result.replayed,
        },
      });
      return result;
    }),

  voidItem: voidProcedure
    .input(
      z
        .object({
          orderId: ID,
          itemId: ID,
          reason: z.string().min(1),
          wastageDisposition: DISPOSITION.optional(),
          approvingStaffProfileId: ID.nullish(),
          approvingCredential: APPROVING_CREDENTIAL.nullish(),
          actor: SESSION_ACTOR,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      // Never write the approver's secret into the audit trail.
      annotateAudit(ctx, { skipInput: true });
      const { result, approvalMode } = await run(() =>
        withApprovedOrderCommand(ctx, input, ({ actor, approvingStaffProfileId }) =>
          voidItem(ctx.db, {
            orderId: input.orderId,
            itemId: input.itemId,
            reason: input.reason,
            wastageDisposition: input.wastageDisposition,
            approvingStaffProfileId,
            actor,
          })
        )
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Voided an order item',
        metadata: { itemId: input.itemId, replayed: result.replayed, approvalMode },
      });
      return result;
    }),

  cancel: voidProcedure
    .input(
      z
        .object({
          orderId: ID,
          reason: z.string().min(1),
          wastageDisposition: DISPOSITION.optional(),
          approvingStaffProfileId: ID.nullish(),
          approvingCredential: APPROVING_CREDENTIAL.nullish(),
          actor: SESSION_ACTOR,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      // Never write the approver's secret into the audit trail.
      annotateAudit(ctx, { skipInput: true });
      const { result, approvalMode } = await run(() =>
        withApprovedOrderCommand(ctx, input, ({ actor, approvingStaffProfileId }) =>
          cancelOrder(ctx.db, {
            orderId: input.orderId,
            reason: input.reason,
            wastageDisposition: input.wastageDisposition,
            approvingStaffProfileId,
            actor,
          })
        )
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Cancelled an order',
        metadata: { replayed: result.replayed, approvalMode },
      });
      return result;
    }),

  close: manageProcedure
    .input(z.object({ orderId: ID, actor: SESSION_ACTOR }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveOrderSessionActor(ctx, input.orderId, input.actor);
      const result = await run(() => closeOrder(ctx.db, { orderId: input.orderId, actor }));
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Closed an order',
        metadata: { replayed: result.replayed },
      });
      return result;
    }),

  moveTable: manageProcedure
    .input(z.object({ orderId: ID, fromTableId: ID, toTableId: ID, actor: SESSION_ACTOR }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveOrderSessionActor(ctx, input.orderId, input.actor);
      const result = await run(() =>
        moveTable(ctx.db, {
          orderId: input.orderId,
          fromTableId: input.fromTableId,
          toTableId: input.toTableId,
          actor,
        })
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Moved an order to another table',
        metadata: {
          fromTableId: input.fromTableId,
          toTableId: input.toTableId,
          replayed: result.replayed,
        },
      });
      return result;
    }),

  mergeTables: manageProcedure
    .input(z.object({ orderId: ID, tableIds: z.array(ID).min(1), actor: SESSION_ACTOR }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveOrderSessionActor(ctx, input.orderId, input.actor);
      const result = await run(() =>
        mergeTables(ctx.db, {
          orderId: input.orderId,
          tableIds: input.tableIds,
          actor,
        })
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Merged tables under an order',
        metadata: { addedTableIds: result.addedTableIds, replayed: result.replayed },
      });
      return result;
    }),

  unlinkTable: manageProcedure
    .input(z.object({ orderId: ID, tableId: ID, actor: SESSION_ACTOR }).strict())
    .mutation(async ({ ctx, input }) => {
      const actor = await resolveOrderSessionActor(ctx, input.orderId, input.actor);
      const result = await run(() =>
        unlinkTable(ctx.db, {
          orderId: input.orderId,
          tableId: input.tableId,
          actor,
        })
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantOrder',
        targetId: input.orderId,
        description: 'Unlinked a table from an order',
        metadata: { tableId: input.tableId, replayed: result.replayed },
      });
      return result;
    }),
});

function serializeFire(result: {
  orderId: string;
  itemIds: string[];
  tickets: Array<{ ticketId: string; stationId: string; ticketNumber: number; matchedBy: string }>;
  replayed: boolean;
}) {
  return {
    orderId: result.orderId,
    itemIds: result.itemIds,
    tickets: result.tickets.map((t) => ({
      ticketId: t.ticketId,
      stationId: t.stationId,
      ticketNumber: t.ticketNumber,
      matchedBy: t.matchedBy,
    })),
    replayed: result.replayed,
  };
}

// ── Read-model implementations ───────────────────────────────────────────────

type ListOrdersInput = {
  branchId: string;
  businessDate?: string;
  status?: z.infer<typeof ORDER_STATUS>;
  channel?: z.infer<typeof orderChannelSchema>;
  limit?: number;
  cursor?: string;
};

async function listOrders(db: ScopedDb, input: ListOrdersInput) {
  const limit = input.limit ?? 50;
  const rows = await db.restaurantOrder.findMany({
    where: {
      branchId: input.branchId,
      businessDate: input.businessDate ? businessDateToUtcDate(input.businessDate) : undefined,
      status: input.status,
      channel: input.channel,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      orderNumber: true,
      businessDate: true,
      status: true,
      channel: true,
      coverCount: true,
      sectionId: true,
      serverStaffProfileId: true,
      createdAt: true,
      items: {
        // This list exposes the amount due and purchased-unit count. Kitchen
        // workload, including remakes, is represented by tickets instead.
        where: { status: { not: 'VOIDED' }, remakeOfItemId: null },
        select: {
          unitPrice: true,
          quantity: true,
          modifiers: { select: { priceDelta: true } },
        },
      },
      orderTables: {
        where: { active: true },
        select: { tableId: true, table: { select: { code: true } } },
      },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    orders: page.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      businessDate: order.businessDate.toISOString().slice(0, 10),
      status: order.status,
      channel: order.channel,
      coverCount: order.coverCount,
      sectionId: order.sectionId,
      serverStaffProfileId: order.serverStaffProfileId,
      activeTableIds: order.orderTables.map((t) => t.tableId),
      // The table code is what the floor plan and the register print (UX rule 1:
      // an operator never reads an id the application already knows the name of).
      activeTables: order.orderTables.map((t) => ({
        id: t.tableId,
        code: t.table?.code ?? t.tableId,
      })),
      itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
      subtotal: money(deriveSubtotal(order.items)),
    })),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}

type PricedItem = {
  unitPrice: Prisma.Decimal;
  quantity: number;
  modifiers: { priceDelta: Prisma.Decimal }[];
};

/** Derived subtotal: Σ (unitPrice + Σ modifier deltas) × quantity over non-voided
 * items. No stored total exists (C3) — this is recomputed from frozen snapshots. */
function deriveSubtotal(items: readonly PricedItem[]): Prisma.Decimal {
  return items.reduce((sum, item) => {
    const modifiers = item.modifiers.reduce(
      (acc, m) => acc.plus(m.priceDelta),
      new Prisma.Decimal(0)
    );
    return sum.plus(item.unitPrice.plus(modifiers).times(item.quantity));
  }, new Prisma.Decimal(0));
}

async function getOrder(db: ScopedDb, orderId: string) {
  const order = await db.restaurantOrder.findUnique({
    where: { id: orderId },
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
      priceListVersionId: true,
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
          modifiers: {
            select: { id: true, modifierOptionId: true, name: true, priceDelta: true },
          },
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
      events: {
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          sequence: true,
          eventType: true,
          actorStaffProfileId: true,
          actorDeviceId: true,
          payload: true,
          createdAt: true,
        },
      },
      kitchenTickets: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          stationId: true,
          businessDate: true,
          ticketNumber: true,
          createdAt: true,
          items: { select: { orderItemId: true, quantity: true } },
        },
      },
      // DEV-769: the service rate pinned when the order opened, and what live bills froze.
      serviceChargePolicyVersion: { select: { rate: true } },
      bills: {
        where: { status: { not: 'VOID' } },
        select: {
          serviceChargeTotal: true,
          splitKind: true,
          lines: { select: { orderItemId: true } },
        },
      },
    },
  });
  if (!order) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'The order does not exist.' });
  }

  // Preserve remake rows in the operational history while excluding them from
  // the guest's payable subtotal.
  const purchasedItems = order.items.filter(
    (item) => item.status !== 'VOIDED' && item.remakeOfItemId === null
  );
  // DEV-769: service runs in the order's total from the first item, not only once a bill is
  // cut. A live bill keeps the service it froze; items on no live bill take the pinned rate,
  // rounded as a bill rounds it. Fractional bills each cover the whole order.
  const billedItemIds = new Set(
    order.bills.flatMap((bill) => bill.lines.map((line) => line.orderItemId))
  );
  const fractional =
    order.bills.length > 0 && order.bills.every((bill) => bill.splitKind === 'FRACTIONAL');
  const unbilledItems = fractional
    ? []
    : purchasedItems.filter((item) => !billedItemIds.has(item.id));
  const serviceCharge = add(
    sumMoney(order.bills.map((bill) => bill.serviceChargeTotal)),
    order.serviceChargePolicyVersion
      ? roundMoney(multiply(deriveSubtotal(unbilledItems), order.serviceChargePolicyVersion.rate))
      : 0
  );
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
    priceListVersionId: order.priceListVersionId,
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
    events: order.events,
    kitchenTickets: order.kitchenTickets.map((ticket) => ({
      id: ticket.id,
      stationId: ticket.stationId,
      businessDate: ticket.businessDate.toISOString().slice(0, 10),
      ticketNumber: ticket.ticketNumber,
      createdAt: ticket.createdAt,
      items: ticket.items,
    })),
    totals: {
      subtotal: money(deriveSubtotal(purchasedItems)),
      tax: money(new Prisma.Decimal(0)),
      serviceCharge: serviceCharge.toString(),
    },
  };
}

type ListKitchenTicketsInput = { branchId: string; businessDate?: string; stationId?: string };

async function listKitchenTickets(db: ScopedDb, input: ListKitchenTicketsInput) {
  const tickets = await db.restaurantKitchenTicket.findMany({
    where: {
      businessDate: input.businessDate ? businessDateToUtcDate(input.businessDate) : undefined,
      stationId: input.stationId,
      order: { branchId: input.branchId },
    },
    orderBy: [{ createdAt: 'asc' }],
    select: {
      id: true,
      orderId: true,
      stationId: true,
      businessDate: true,
      ticketNumber: true,
      createdAt: true,
      order: { select: { orderNumber: true } },
      items: {
        select: {
          orderItemId: true,
          quantity: true,
          orderItem: { select: { name: true, status: true, course: true, seatNumber: true } },
        },
      },
    },
  });
  return {
    tickets: tickets.map((ticket) => ({
      id: ticket.id,
      orderId: ticket.orderId,
      orderNumber: ticket.order.orderNumber,
      stationId: ticket.stationId,
      businessDate: ticket.businessDate.toISOString().slice(0, 10),
      ticketNumber: ticket.ticketNumber,
      createdAt: ticket.createdAt,
      items: ticket.items.map((line) => ({
        orderItemId: line.orderItemId,
        quantity: line.quantity,
        name: line.orderItem.name,
        status: line.orderItem.status,
        course: line.orderItem.course,
        seatNumber: line.orderItem.seatNumber,
      })),
    })),
  };
}
