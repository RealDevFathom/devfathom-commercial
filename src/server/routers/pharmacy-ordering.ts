import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { can, subjectFromSession } from '@/lib/abac';
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
        const scope = await scopeFor(ctx, input.branchId);
        return recordDeliveryCommand(txDb(tx), scope, input, {
          // DEV-647: a physical return that refunds cash needs a manager or owner PIN.
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
        return await ctx.db.$transaction(async (tx) =>
          placeCustomerOrder(txDb(tx), await scopeFor(ctx, input.branchId), { ...input, staff })
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
        listStaffCustomerOrders(txDb(tx), await scopeFor(ctx, input.branchId))
      )
    ),

  runners: staffProcedure.query(({ ctx }) =>
    ctx.db.user.findMany({
      where: {
        organizationId: ctx.entitlements.organizationId,
        organizationRoleId: { not: null },
        status: 'ACTIVE',
      },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    })
  ),

  customers: staffProcedure.query(({ ctx }) =>
    ctx.db.pharmacyCustomer.findMany({
      where: { organizationId: ctx.entitlements.organizationId, active: true },
      select: { id: true, displayName: true, phoneLast4: true },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 200,
    })
  ),

  transition: staffProcedure
    .input(
      z
        .object({
          branchId,
          orderId: z.string().min(1),
          action: z.enum(['accept', 'pack', 'ready', 'dispatch', 'cancel', 'expire']),
          runnerUserId: z.string().min(1).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
          transitionCustomerOrder(txDb(tx), await scopeFor(ctx, input.branchId), input)
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
          startCustomerOrderCheckout(txDb(tx), await scopeFor(ctx, input.branchId), input.orderId)
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
          completeCustomerOrder(txDb(tx), await scopeFor(ctx, input.branchId), input.orderId)
        );
      } catch (error) {
        fail(error);
      }
    }),
});
