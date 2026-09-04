import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '../audit';
import { capabilityProcedure, router } from '../trpc';

const id = z.string().trim().min(1).max(200);
const money = z.string().regex(/^\d+(?:\.\d{1,4})?$/);
const status = z.enum([
  'DRAFT',
  'QUOTED',
  'CONFIRMED',
  'IN_PRODUCTION',
  'READY',
  'DELIVERED',
  'CLOSED',
  'CANCELLED',
]);
const extraCostKind = z.enum(['LABOUR', 'TRANSPORT', 'RENTAL', 'OTHER']);
const actor = { actorStaffProfileId: id.nullable().optional() };
const readProcedure = capabilityProcedure('catering:read');
const manageProcedure = capabilityProcedure('catering:manage');

const orderInclude = {
  lines: { orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }] },
  extraCosts: { orderBy: { createdAt: 'asc' as const } },
  delivery: true,
  events: { orderBy: { sequence: 'asc' as const } },
} satisfies Prisma.RestaurantCateringOrderInclude;

function organizationId(ctx: { entitlements: { organizationId: string } }) {
  return ctx.entitlements.organizationId;
}

function decimal(value: string | null | undefined) {
  return value == null ? null : new Prisma.Decimal(value);
}

function serializeOrder<T extends Record<string, unknown>>(order: T) {
  return JSON.parse(
    JSON.stringify(order, (_key, value) =>
      Prisma.Decimal.isDecimal(value) ? value.toString() : value
    )
  ) as T;
}

async function requireOrder(
  db: Pick<ScopedDb, 'restaurantCateringOrder'>,
  organizationId: string,
  orderId: string
) {
  const order = await db.restaurantCateringOrder.findFirst({
    where: { id: orderId, organizationId },
  });
  if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'Catering order not found.' });
  return order;
}

async function appendEvent(
  tx: Pick<ScopedDb, '$queryRaw' | 'restaurantCateringEvent'>,
  data: {
    organizationId: string;
    orderId: string;
    eventType: string;
    actorStaffProfileId?: string | null;
    payload: Prisma.InputJsonValue;
  }
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${data.orderId}, 0))`
  );
  const aggregate = await tx.restaurantCateringEvent.aggregate({
    where: { organizationId: data.organizationId, orderId: data.orderId },
    _max: { sequence: true },
  });
  return tx.restaurantCateringEvent.create({
    data: {
      ...data,
      actorStaffProfileId: data.actorStaffProfileId ?? null,
      sequence: (aggregate._max.sequence ?? 0) + 1,
    },
  });
}

const editableOrder = z
  .object({
    customerId: id.nullable().optional(),
    eventName: z.string().trim().min(1).max(240),
    eventDate: z.date(),
    serviceTime: z.date().nullable().optional(),
    headcount: z.number().int().min(1),
    venueAddress: z.string().trim().max(500).nullable().optional(),
    deliveryAddressId: id.nullable().optional(),
    quotedTotal: money.nullable().optional(),
    depositAmount: money.nullable().optional(),
    notes: z.string().max(10_000).nullable().optional(),
  })
  .strict();

const lineShape = z
  .object({
    productId: id.nullable().optional(),
    recipeId: id.nullable().optional(),
    description: z.string().trim().min(1).max(500),
    portions: money,
    unitPrice: money,
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict();
const lineFields = lineShape.refine((value) => Boolean(value.productId || value.recipeId), {
  message: 'A productId or recipeId is required.',
});
const addLineInput = z
  .object({ orderId: id, ...actor })
  .extend(lineFields.shape)
  .strict()
  .refine((value) => Boolean(value.productId || value.recipeId), {
    message: 'A productId or recipeId is required.',
  });

const transitions: Record<z.infer<typeof status>, z.infer<typeof status> | null> = {
  DRAFT: 'QUOTED',
  QUOTED: 'CONFIRMED',
  CONFIRMED: 'IN_PRODUCTION',
  IN_PRODUCTION: 'READY',
  READY: 'DELIVERED',
  DELIVERED: 'CLOSED',
  CLOSED: null,
  CANCELLED: null,
};

export const restaurantCateringRouter = router({
  create: manageProcedure
    .input(editableOrder.extend({ branchId: id, createdByStaffId: id.nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const orgId = organizationId(ctx);
      const { quotedTotal, depositAmount, createdByStaffId, ...data } = input;
      const order = await ctx.db.$transaction(async (tx) => {
        const created = await tx.restaurantCateringOrder.create({
          data: {
            ...data,
            organizationId: orgId,
            createdByStaffId: createdByStaffId ?? null,
            quotedTotal: decimal(quotedTotal),
            depositAmount: decimal(depositAmount),
          },
        });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId: created.id,
          eventType: 'CREATED',
          actorStaffProfileId: createdByStaffId,
          payload: { status: 'DRAFT' },
        });
        return created;
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantCateringOrder',
        targetId: order.id,
        description: 'Created catering order',
      });
      return serializeOrder(order);
    }),

  update: manageProcedure
    .input(
      editableOrder
        .partial()
        .extend({ orderId: id, ...actor })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = organizationId(ctx);
      const { orderId, actorStaffProfileId, quotedTotal, depositAmount, ...data } = input;
      await requireOrder(ctx.db, orgId, orderId);
      const order = await ctx.db.$transaction(async (tx) => {
        const updated = await tx.restaurantCateringOrder.update({
          where: { organizationId_id: { organizationId: orgId, id: orderId } },
          data: {
            ...data,
            ...(quotedTotal !== undefined ? { quotedTotal: decimal(quotedTotal) } : {}),
            ...(depositAmount !== undefined ? { depositAmount: decimal(depositAmount) } : {}),
          },
          include: orderInclude,
        });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId,
          eventType: 'UPDATED',
          actorStaffProfileId,
          payload: { fields: Object.keys(data) },
        });
        return updated;
      });
      return serializeOrder(order);
    }),

  get: readProcedure.input(z.object({ orderId: id }).strict()).query(async ({ ctx, input }) => {
    const order = await ctx.db.restaurantCateringOrder.findFirst({
      where: { id: input.orderId, organizationId: organizationId(ctx) },
      include: orderInclude,
    });
    if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'Catering order not found.' });
    return serializeOrder(order);
  }),

  list: readProcedure
    .input(
      z
        .object({
          branchId: id.optional(),
          status: status.optional(),
          eventDateFrom: z.date().optional(),
          eventDateTo: z.date().optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const orders = await ctx.db.restaurantCateringOrder.findMany({
        where: {
          organizationId: organizationId(ctx),
          branchId: input.branchId,
          status: input.status,
          eventDate: { gte: input.eventDateFrom, lte: input.eventDateTo },
        },
        include: orderInclude,
        orderBy: [{ eventDate: 'asc' }, { createdAt: 'asc' }],
      });
      return orders.map(serializeOrder);
    }),

  addLine: manageProcedure.input(addLineInput).mutation(async ({ ctx, input }) => {
    const orgId = organizationId(ctx);
    const { orderId, actorStaffProfileId, portions, unitPrice, ...data } = input;
    await requireOrder(ctx.db, orgId, orderId);
    return ctx.db.$transaction(async (tx) => {
      const line = await tx.restaurantCateringOrderLine.create({
        data: {
          ...data,
          organizationId: orgId,
          orderId,
          portions: decimal(portions)!,
          unitPrice: decimal(unitPrice)!,
        },
      });
      await appendEvent(tx, {
        organizationId: orgId,
        orderId,
        eventType: 'LINE_ADDED',
        actorStaffProfileId,
        payload: { lineId: line.id },
      });
      return serializeOrder(line);
    });
  }),

  updateLine: manageProcedure
    .input(
      z
        .object({ orderId: id, lineId: id, ...actor })
        .extend(lineShape.partial().shape)
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = organizationId(ctx);
      const { orderId, lineId, actorStaffProfileId, portions, unitPrice, ...data } = input;
      await requireOrder(ctx.db, orgId, orderId);
      return ctx.db.$transaction(async (tx) => {
        const result = await tx.restaurantCateringOrderLine.updateMany({
          where: { id: lineId, orderId, organizationId: orgId },
          data: {
            ...data,
            ...(portions ? { portions: decimal(portions)! } : {}),
            ...(unitPrice ? { unitPrice: decimal(unitPrice)! } : {}),
          },
        });
        if (result.count !== 1)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Catering line not found.' });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId,
          eventType: 'LINE_UPDATED',
          actorStaffProfileId,
          payload: { lineId },
        });
        return { id: lineId };
      });
    }),

  removeLine: manageProcedure
    .input(z.object({ orderId: id, lineId: id, ...actor }).strict())
    .mutation(async ({ ctx, input }) => {
      const orgId = organizationId(ctx);
      return ctx.db.$transaction(async (tx) => {
        const result = await tx.restaurantCateringOrderLine.deleteMany({
          where: { id: input.lineId, orderId: input.orderId, organizationId: orgId },
        });
        if (result.count !== 1)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Catering line not found.' });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId: input.orderId,
          eventType: 'LINE_REMOVED',
          actorStaffProfileId: input.actorStaffProfileId,
          payload: { lineId: input.lineId },
        });
        return { id: input.lineId };
      });
    }),

  addExtraCost: manageProcedure
    .input(
      z
        .object({
          orderId: id,
          kind: extraCostKind,
          label: z.string().trim().min(1).max(240),
          amount: money,
          ...actor,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = organizationId(ctx);
      const { actorStaffProfileId, amount, ...data } = input;
      await requireOrder(ctx.db, orgId, input.orderId);
      return ctx.db.$transaction(async (tx) => {
        const cost = await tx.restaurantCateringExtraCost.create({
          data: { ...data, organizationId: orgId, amount: decimal(amount)! },
        });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId: input.orderId,
          eventType: 'EXTRA_COST_ADDED',
          actorStaffProfileId,
          payload: { extraCostId: cost.id },
        });
        return serializeOrder(cost);
      });
    }),

  removeExtraCost: manageProcedure
    .input(z.object({ orderId: id, extraCostId: id, ...actor }).strict())
    .mutation(async ({ ctx, input }) => {
      const orgId = organizationId(ctx);
      return ctx.db.$transaction(async (tx) => {
        const result = await tx.restaurantCateringExtraCost.deleteMany({
          where: { id: input.extraCostId, orderId: input.orderId, organizationId: orgId },
        });
        if (result.count !== 1)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Extra cost not found.' });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId: input.orderId,
          eventType: 'EXTRA_COST_REMOVED',
          actorStaffProfileId: input.actorStaffProfileId,
          payload: { extraCostId: input.extraCostId },
        });
        return { id: input.extraCostId };
      });
    }),

  setDelivery: manageProcedure
    .input(
      z
        .object({
          orderId: id,
          scheduledAt: z.date(),
          dispatchedAt: z.date().nullable().optional(),
          deliveredAt: z.date().nullable().optional(),
          driverStaffId: id.nullable().optional(),
          vehicle: z.string().trim().max(120).nullable().optional(),
          notes: z.string().max(5_000).nullable().optional(),
          ...actor,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = organizationId(ctx);
      const { actorStaffProfileId, orderId, ...data } = input;
      await requireOrder(ctx.db, orgId, orderId);
      return ctx.db.$transaction(async (tx) => {
        const delivery = await tx.restaurantCateringDelivery.upsert({
          where: { orderId },
          create: { ...data, orderId, organizationId: orgId },
          update: data,
        });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId,
          eventType: 'DELIVERY_SET',
          actorStaffProfileId,
          payload: { scheduledAt: input.scheduledAt.toISOString() },
        });
        return delivery;
      });
    }),

  transition: manageProcedure
    .input(z.object({ orderId: id, to: status, ...actor }).strict())
    .mutation(async ({ ctx, input }) => {
      const orgId = organizationId(ctx);
      const order = await ctx.db.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.orderId}, 0))`
        );
        const current = await requireOrder(tx, orgId, input.orderId);
        const currentStatus = current.status as z.infer<typeof status>;
        const allowed =
          transitions[currentStatus] === input.to ||
          (input.to === 'CANCELLED' && !['CLOSED', 'CANCELLED'].includes(currentStatus));
        if (!allowed)
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Cannot transition catering order from ${current.status} to ${input.to}.`,
          });
        const updated = await tx.restaurantCateringOrder.update({
          where: { organizationId_id: { organizationId: orgId, id: input.orderId } },
          data: { status: input.to },
          include: orderInclude,
        });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId: input.orderId,
          eventType: 'STATUS_TRANSITIONED',
          actorStaffProfileId: input.actorStaffProfileId,
          payload: { from: current.status, to: input.to },
        });
        return updated;
      });
      return serializeOrder(order);
    }),
});
