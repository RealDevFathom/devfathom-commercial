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

async function isStaff(ctx: TRPCContext) {
  if (!ctx.session?.user) return false;
  return can(subjectFromSession(ctx.session.user), 'pharmacy:orders', undefined, {
    db: ctx.db,
    source: 'TRPC',
    ip: ctx.requestMeta.ip,
  });
}

function fail(error: unknown): never {
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
      return await ctx.db.$transaction(async (tx) =>
        recordDeliveryCommand(txDb(tx), await scopeFor(ctx, input.branchId), input)
      );
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
