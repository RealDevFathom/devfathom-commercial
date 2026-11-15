import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { can, subjectFromSession } from '@/lib/abac';
import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import {
  cancelMyCustomerOrder,
  completeCustomerOrder,
  listMyCustomerOrders,
  listStaffCustomerOrders,
  listStorefrontCatalog,
  PharmacyCustomerOrderError,
  placeCustomerOrder,
  startCustomerOrderCheckout,
  transitionCustomerOrder,
} from '@/lib/pharmacy/customer-ordering';
import {
  deliveryCommandInput,
  recordDeliveryCommand,
  PharmacyDeliveryError,
} from '@/lib/pharmacy/customer-delivery';
import {
  confirmPortalKhataPayment,
  decidePortalRequest,
  listPortalQueue,
  mintPortalLink,
  PharmacyPortalError,
  type PortalRequestKind,
} from '@/lib/pharmacy/customer-portal';
import { FamilyKhataError } from '@/lib/pharmacy/family-khata';
import { BranchOperationDeniedError } from '@/lib/pharmacy/regulatory';
import { PharmacySettlementError } from '@/lib/pharmacy/settlement';
import { MAX_DELIVERY_DISTANCE_METERS } from '@/lib/pharmacy/delivery-radius-profitability';
import { PharmacyRxSaleDenied } from '@/lib/pharmacy/rx-sale-gate';
import {
  approveRefillCycle,
  cancelRefillSubscription,
  createRefillSubscription,
  listDueRefillSubscriptionIds,
  listRefillSubscriptions,
  openRefillCycle,
  RefillCycleApprovalDenied,
  RefillSubscriptionError,
  releaseRefillCycle,
  setRefillSubscriptionPaused,
  startRefillCycleCheckout,
  verifyRefillCyclePharmacistPin,
} from '@/lib/pharmacy/refill-subscriptions';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import {
  actorMayRefund,
  authenticateRefundPin,
  REFUND_FORBIDDEN,
  REFUND_PIN_BLOCKED,
  REFUND_PIN_POLICY,
} from '@/lib/pharmacy/refund-authorization';
import { annotateAudit } from '@/server/audit';
import type { LedgerScope } from '@/lib/pharmacy/stock-ledger';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { assertInOrganization } from '../org-refs';
import { capabilityProcedure, protectedProcedure, router, type TRPCContext } from '../trpc';

const branchId = z.string().trim().min(1).max(128);
const staffProcedure = capabilityProcedure('pharmacy:orders');
const txDb = (tx: unknown) => tx as ScopedDb;

async function scopeFor(ctx: TRPCContext, branch: string): Promise<LedgerScope> {
  const organizationId = ctx.entitlements?.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!organizationId || !actorId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  await assertInOrganization(ctx.db.pharmacyBranch, organizationId, [branch], { active: true });
  return { organizationId, branchId: branch, actorId };
}

const outsideScope = () =>
  new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });

/**
 * DEV-845: a live tenant admin or owner reaches every active branch without an
 * assignment. The user record decides, not the session role, and any explicit
 * DENY rule (override or role) withdraws the exception, as in owner-access.
 */
async function hasTenantWideOrdersAccess(
  ctx: TRPCContext,
  organizationId: string,
  actorId: string
): Promise<boolean> {
  const member = await ctx.db.user.findFirst({
    where: { id: actorId, organizationId, status: 'ACTIVE' },
    select: {
      role: true,
      status: true,
      organizationRole: {
        select: {
          key: true,
          isSystem: true,
          permissions: { select: { capability: true, effect: true } },
        },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (!member) return false;
  const rules = [...member.permissionOverrides, ...(member.organizationRole?.permissions ?? [])];
  if (rules.some((rule) => rule.effect === 'DENY')) return false;
  return member.role === 'ADMIN' || hasAllCapabilityAccess(member);
}

/** The session tenant and actor, or UNAUTHORIZED / FORBIDDEN. */
function staffActor(ctx: TRPCContext) {
  const organizationId = ctx.entitlements?.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!organizationId || !actorId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (ctx.session?.user?.organizationId !== organizationId) throw outsideScope();
  return { organizationId, actorId };
}

/**
 * DEV-845: `pharmacy:orders` says what a staff member may do; this says where.
 * A staff procedure acts only at a branch the session user holds an active
 * assignment to. A live tenant admin or owner keeps every active branch, and
 * that exception is written to the audit entry. A solo owner assigned to the
 * branch passes on the assignment alone.
 */
async function staffScopeFor(ctx: TRPCContext, branch: string): Promise<LedgerScope> {
  const scope = await scopeFor(ctx, branch);
  staffActor(ctx);
  const assignment = await ctx.db.pharmacyBranchAssignment.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: branch,
      userId: scope.actorId,
      active: true,
    },
    select: { id: true },
  });
  if (assignment) return scope;
  if (await hasTenantWideOrdersAccess(ctx, scope.organizationId, scope.actorId)) {
    annotateAudit(ctx, {
      targetType: 'PharmacyBranch',
      targetId: branch,
      metadata: {
        branchId: branch,
        reason: 'tenant-admin-orders-access-without-branch-assignment',
      },
    });
    return scope;
  }
  throw outsideScope();
}

/**
 * DEV-845: the branches a branch-less staff read covers: `null` for a tenant
 * admin or owner (every branch), otherwise the caller's active assignments.
 */
async function staffBranchIds(ctx: TRPCContext): Promise<string[] | null> {
  const { organizationId, actorId } = staffActor(ctx);
  if (await hasTenantWideOrdersAccess(ctx, organizationId, actorId)) return null;
  const rows = await ctx.db.pharmacyBranchAssignment.findMany({
    where: {
      organizationId,
      userId: actorId,
      active: true,
      branch: { organizationId, active: true },
    },
    select: { branchId: true },
  });
  return rows.map((row) => row.branchId);
}

async function holds(ctx: TRPCContext, action: 'pharmacy:dispense' | 'pharmacy:counter') {
  if (!ctx.session?.user) return false;
  return can(subjectFromSession(ctx.session.user), action, undefined, {
    db: ctx.db,
    source: 'TRPC',
    ip: ctx.requestMeta.ip,
  });
}

/** Bind the branch for branch-scoped row-level security, as the counter's khata path does. */
async function bindBranch(db: ScopedDb, branch: string) {
  await db.$queryRaw`SELECT set_config('app.current_branch_id', ${branch}, true)`;
}

async function isStaff(ctx: TRPCContext) {
  if (!ctx.session?.user) return false;
  return can(subjectFromSession(ctx.session.user), 'pharmacy:orders', undefined, {
    db: ctx.db,
    source: 'TRPC',
    ip: ctx.requestMeta.ip,
  });
}

function fail(error: unknown): never {
  if (error instanceof PharmacyPortalError) {
    const code =
      error.reason === 'REQUEST_NOT_FOUND' || error.reason === 'CUSTOMER_NOT_FOUND'
        ? 'NOT_FOUND'
        : error.reason === 'KIND_NOT_ALLOWED'
          ? 'FORBIDDEN'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: error.reason });
  }
  if (error instanceof FamilyKhataError || error instanceof PharmacySettlementError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.reason });
  if (error instanceof BranchOperationDeniedError)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.reason });
  if (error instanceof PharmacyDeliveryError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  if (error instanceof PharmacyRxSaleDenied)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
  if (error instanceof RefillCycleApprovalDenied)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
  if (error instanceof RefillSubscriptionError) {
    const code =
      error.reason === 'SUBSCRIPTION_NOT_FOUND' ||
      error.reason === 'CYCLE_NOT_FOUND' ||
      error.reason === 'CUSTOMER_NOT_FOUND'
        ? 'NOT_FOUND'
        : error.reason === 'PHARMACIST_APPROVAL_REQUIRED'
          ? 'FORBIDDEN'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: error.reason });
  }
  if (error instanceof PharmacyCustomerOrderError) {
    const code =
      error.reason === 'ORDER_NOT_FOUND' || error.reason === 'CUSTOMER_NOT_FOUND'
        ? 'NOT_FOUND'
        : error.reason === 'STAFF_ACCESS_REQUIRED'
          ? 'FORBIDDEN'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: error.reason });
  }
  throw error;
}

const subscriptionId = z.string().min(1).max(128);
const cycleId = z.string().min(1).max(128);

const orderLine = z
  .object({
    medicineId: z.string().min(1),
    presentationId: z.string().min(1),
    packLevelId: z.string().min(1),
    saleUnit: z.literal('PACK'),
    quantity: z.number().int().positive().max(100),
  })
  .strict();

export const pharmacyOrderingRouter = router({
  deliveryCommand: staffProcedure.input(deliveryCommandInput).mutation(async ({ ctx, input }) => {
    try {
      return await ctx.db.$transaction(async (tx) => {
        const scope = await staffScopeFor(ctx, input.branchId);
        return recordDeliveryCommand(txDb(tx), scope, input, {
          // DEV-647 / DEV-786: a physical return that refunds cash or returns a completed sale
          // needs a manager or owner PIN.
          authorizeRefund: async () => {
            if (!(await actorMayRefund(ctx.db, ctx.session.user)))
              throw new TRPCError({ code: 'FORBIDDEN', message: REFUND_FORBIDDEN });
            // An independent transaction, so a refused PIN commits its lockout strike.
            const pin = input.managerPin
              ? await authenticateRefundPin({
                  organizationId: scope.organizationId,
                  actorId: scope.actorId,
                  pin: input.managerPin,
                  action: 'pharmacyOrdering.deliveryCommand',
                })
              : { blocked: REFUND_PIN_BLOCKED };
            annotateAudit(ctx, {
              metadata: {
                policy: REFUND_PIN_POLICY,
                approverId: scope.actorId,
                pinVerified: 'verified' in pin,
              },
            });
            if ('blocked' in pin) throw new TRPCError({ code: 'FORBIDDEN', message: pin.blocked });
          },
        });
      });
    } catch (error) {
      fail(error);
    }
  }),
  branches: protectedProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.entitlements.organizationId;
    const [branches, organization, customer] = await Promise.all([
      ctx.db.pharmacyBranch.findMany({
        where: { organizationId, active: true },
        select: { id: true, name: true, city: true, addressLine: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      ctx.db.organization.findUnique({
        where: { id: organizationId },
        select: { currency: true },
      }),
      ctx.db.pharmacyCustomer.findFirst({
        where: { organizationId, userId: ctx.session.user.id, active: true },
        select: { id: true, displayName: true },
      }),
    ]);
    return { branches, currency: organization?.currency ?? 'PKR', customer };
  }),

  catalog: protectedProcedure
    .input(z.object({ branchId, search: z.string().trim().max(120).optional() }).strict())
    .query(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        listStorefrontCatalog(txDb(tx), await scopeFor(ctx, input.branchId), input.search)
      )
    ),

  mine: protectedProcedure.query(({ ctx }) =>
    listMyCustomerOrders(ctx.db, ctx.entitlements.organizationId, ctx.session.user.id)
  ),

  place: protectedProcedure
    .input(
      z
        .object({
          branchId,
          customerId: z.string().min(1).optional(),
          fulfillment: z.enum(['COLLECT', 'DELIVER']),
          intendedPaymentMethod: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'WALLET', 'CREDIT']),
          addressLine: z.string().trim().min(1).max(300).optional(),
          city: z.string().trim().min(1).max(120).optional(),
          deliveryInstructions: z.string().trim().max(500).optional(),
          lines: z.array(orderLine).min(1).max(30),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const staff = await isStaff(ctx);
        // DEV-845: ordering for another customer is staff-only, so it takes the
        // staff branch boundary; a customer ordering for themselves does not.
        const onBehalf = staff && input.customerId !== undefined;
        return await ctx.db.$transaction(async (tx) =>
          placeCustomerOrder(
            txDb(tx),
            onBehalf
              ? await staffScopeFor(ctx, input.branchId)
              : await scopeFor(ctx, input.branchId),
            { ...input, staff }
          )
        );
      } catch (error) {
        fail(error);
      }
    }),

  cancelMine: protectedProcedure
    .input(z.object({ branchId, orderId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
          cancelMyCustomerOrder(txDb(tx), await scopeFor(ctx, input.branchId), input.orderId)
        );
      } catch (error) {
        fail(error);
      }
    }),

  staffQueue: staffProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        listStaffCustomerOrders(txDb(tx), await staffScopeFor(ctx, input.branchId))
      )
    ),

  // DEV-845: runners at the caller's assigned branches (every branch for a tenant admin or owner).
  runners: staffProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.entitlements.organizationId;
    const branchIds = await staffBranchIds(ctx);
    if (branchIds?.length === 0) return [];
    return ctx.db.user.findMany({
      where: {
        organizationId,
        organizationRoleId: { not: null },
        status: 'ACTIVE',
        ...(branchIds
          ? {
              pharmacyBranchAssignments: {
                some: { organizationId, active: true, branchId: { in: branchIds } },
              },
            }
          : {}),
      },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }),

  // DEV-845: customers seen at the caller's assigned branches (an order, a sale
  // or a refill subscription there); every customer for a tenant admin or owner.
  customers: staffProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.entitlements.organizationId;
    const branchIds = await staffBranchIds(ctx);
    if (branchIds?.length === 0) return [];
    const atBranch = branchIds ? { some: { organizationId, branchId: { in: branchIds } } } : null;
    return ctx.db.pharmacyCustomer.findMany({
      where: {
        organizationId,
        active: true,
        ...(atBranch
          ? { OR: [{ orders: atBranch }, { sales: atBranch }, { refillSubscriptions: atBranch }] }
          : {}),
      },
      select: { id: true, displayName: true, phoneLast4: true },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 200,
    });
  }),

  transition: staffProcedure
    .input(
      z
        .object({
          branchId,
          orderId: z.string().min(1),
          action: z.enum(['accept', 'pack', 'ready', 'dispatch', 'cancel', 'expire']),
          runnerUserId: z.string().min(1).optional(),
          deliveryDistanceMeters: z
            .number()
            .int()
            .min(0)
            .max(MAX_DELIVERY_DISTANCE_METERS)
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
          transitionCustomerOrder(txDb(tx), await staffScopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),

  startCheckout: staffProcedure
    .input(z.object({ branchId, orderId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
          startCustomerOrderCheckout(
            txDb(tx),
            await staffScopeFor(ctx, input.branchId),
            input.orderId
          )
        );
      } catch (error) {
        fail(error);
      }
    }),

  // DEV-15 (#762): customer PWA. A sign-in link for one customer; the customer
  // signs in with a code sent to their stored phone.
  portalLink: staffProcedure
    .input(z.object({ branchId, customerId: z.string().trim().min(1).max(128) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
          mintPortalLink(txDb(tx), await scopeFor(ctx, input.branchId), input.customerId)
        );
      } catch (error) {
        fail(error);
      }
    }),

  // Open customer PWA requests for this branch. Refills and prescription-photo
  // orders are decided by a pharmacist; khata payments by the counter.
  portalQueue: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const [pharmacist, counter, orders] = await Promise.all([
        holds(ctx, 'pharmacy:dispense'),
        holds(ctx, 'pharmacy:counter'),
        isStaff(ctx),
      ]);
      if (!pharmacist && !counter && !orders) throw new TRPCError({ code: 'FORBIDDEN' });
      const requests = await ctx.db.$transaction(async (tx) => {
        const scope = await scopeFor(ctx, input.branchId);
        await bindBranch(txDb(tx), scope.branchId);
        return listPortalQueue(txDb(tx), scope);
      });
      return { requests, canVerifyPrescriptions: pharmacist, canConfirmPayments: counter };
    }),

  portalDecide: protectedProcedure
    .input(
      z
        .object({
          branchId,
          requestId: z.string().trim().min(1).max(128),
          decision: z.enum(['VERIFY', 'REJECT']),
          note: z.string().trim().max(500).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      // Server-side permission: a refill or prescription-photo order needs the
      // pharmacist dispensing permission; rejecting a payment notice needs counter access.
      const allowed: PortalRequestKind[] = [];
      if (await holds(ctx, 'pharmacy:dispense')) allowed.push('REFILL', 'RX_ORDER');
      if (await holds(ctx, 'pharmacy:counter')) allowed.push('KHATA_PAYMENT');
      if (!allowed.length) throw new TRPCError({ code: 'FORBIDDEN' });
      try {
        return await ctx.db.$transaction(async (tx) => {
          const scope = await scopeFor(ctx, input.branchId);
          await bindBranch(txDb(tx), scope.branchId);
          return decidePortalRequest(txDb(tx), scope, input, allowed);
        });
      } catch (error) {
        fail(error);
      }
    }),

  portalConfirmPayment: capabilityProcedure('pharmacy:counter')
    .input(
      z
        .object({
          branchId,
          requestId: z.string().trim().min(1).max(128),
          // Optional: the server books on today; any other client date is refused.
          businessDate: z.date().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) => {
          const scope = await scopeFor(ctx, input.branchId);
          await bindBranch(txDb(tx), scope.branchId);
          return confirmPortalKhataPayment(txDb(tx), scope, input);
        });
      } catch (error) {
        fail(error);
      }
    }),

  complete: staffProcedure
    .input(z.object({ branchId, orderId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
          completeCustomerOrder(txDb(tx), await staffScopeFor(ctx, input.branchId), input.orderId)
        );
      } catch (error) {
        fail(error);
      }
    }),

  // DEV-73: chronic refill program and monthly pack subscriptions.
  subscriptions: staffProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        listRefillSubscriptions(txDb(tx), await staffScopeFor(ctx, input.branchId))
      )
    ),

  createSubscription: staffProcedure
    .input(
      z
        .object({
          branchId,
          customerId: z.string().min(1),
          medicineId: z.string().min(1),
          presentationId: z.string().min(1),
          packLevelId: z.string().min(1),
          packsPerCycle: z.number().int().min(1).max(100),
          cycleDays: z.number().int().min(1).max(180).optional(),
          reminderLeadDays: z.number().int().min(0).max(30).optional(),
          fulfillment: z.enum(['COLLECT', 'DELIVER']),
          paymentMode: z.enum(['PREPAY', 'KHATA']),
          firstDueAt: z.coerce.date(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
          createRefillSubscription(txDb(tx), await staffScopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),

  setSubscriptionStatus: staffProcedure
    .input(
      z.object({ branchId, subscriptionId, action: z.enum(['pause', 'resume', 'cancel']) }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) => {
          const scope = await staffScopeFor(ctx, input.branchId);
          return input.action === 'cancel'
            ? cancelRefillSubscription(txDb(tx), scope, input.subscriptionId)
            : setRefillSubscriptionPaused(
                txDb(tx),
                scope,
                input.subscriptionId,
                input.action === 'pause'
              );
        });
      } catch (error) {
        fail(error);
      }
    }),

  openSubscriptionCycle: staffProcedure
    .input(z.object({ branchId, subscriptionId }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
          openRefillCycle(txDb(tx), await staffScopeFor(ctx, input.branchId), input.subscriptionId)
        );
      } catch (error) {
        fail(error);
      }
    }),

  openDueSubscriptionCycles: staffProcedure
    .input(z.object({ branchId }).strict())
    .mutation(async ({ ctx, input }) => {
      const scope = await staffScopeFor(ctx, input.branchId);
      const due = await ctx.db.$transaction(async (tx) =>
        listDueRefillSubscriptionIds(txDb(tx), scope)
      );
      const opened: string[] = [];
      const skipped: { subscriptionId: string; reason: string }[] = [];
      // One transaction per subscriber: a stock-out never undoes another's hold.
      for (const id of due) {
        try {
          const cycle = await ctx.db.$transaction(async (tx) =>
            openRefillCycle(txDb(tx), scope, id)
          );
          opened.push(cycle.id);
        } catch (error) {
          if (!(error instanceof RefillSubscriptionError)) fail(error);
          skipped.push({ subscriptionId: id, reason: error.reason });
        }
      }
      return { opened, skipped };
    }),

  approveSubscriptionCycle: staffProcedure
    .input(
      z
        .object({
          branchId,
          cycleId,
          pharmacistPin: z
            .object({
              staffProfileId: z.string().min(1).max(128),
              pin: z.string().regex(/^\d{4,8}$/),
            })
            .strict(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await staffScopeFor(ctx, input.branchId);
        // The PIN check commits in its own transaction so a wrong PIN keeps its
        // lockout strike even though the approval is refused.
        const approval = await withTenantDb(
          scope.organizationId,
          (credentialDb) =>
            verifyRefillCyclePharmacistPin(credentialDb, scope, input.pharmacistPin),
          { userId: scope.actorId, skipDrain: true }
        );
        annotateAudit(ctx, {
          metadata: {
            policy: 'PHARMACIST_PIN_REAUTH',
            approverId: approval?.approvedByUserId ?? null,
            pinVerified: Boolean(approval),
          },
        });
        if (!approval) throw new RefillCycleApprovalDenied();
        return await ctx.db.$transaction(async (tx) =>
          approveRefillCycle(txDb(tx), scope, input.cycleId, approval)
        );
      } catch (error) {
        fail(error);
      }
    }),

  releaseSubscriptionCycle: staffProcedure
    .input(z.object({ branchId, cycleId }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
          releaseRefillCycle(txDb(tx), await staffScopeFor(ctx, input.branchId), input.cycleId)
        );
      } catch (error) {
        fail(error);
      }
    }),

  startSubscriptionCycleCheckout: staffProcedure
    .input(z.object({ branchId, cycleId }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
          startRefillCycleCheckout(
            txDb(tx),
            await staffScopeFor(ctx, input.branchId),
            input.cycleId
          )
        );
      } catch (error) {
        fail(error);
      }
    }),
});
