import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import * as operations from '@/lib/restaurant/catering-operations';
import { hasModule } from '@/lib/entitlements';
import { resolveRestaurantActor } from '../restaurant-actor';
import { computeRecipeCost, explodeRecipeInDb } from '@/lib/restaurant/recipe-costing';
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
function cateringProcedure(capability: 'catering:read' | 'catering:manage') {
  return capabilityProcedure(capability).use(async ({ ctx, getRawInput, next }) => {
    if (!hasModule(ctx.entitlements, 'restaurant-core'))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'The restaurant-core module is not enabled for this organization.',
      });
    const raw = await getRawInput();
    const input = z
      .object({
        orderId: id.optional(),
        branchId: id.optional(),
        actorStaffProfileId: id.nullable().optional(),
        createdByStaffId: id.nullable().optional(),
      })
      .parse(raw);
    let branch = input.branchId;
    if (input.orderId)
      branch = (await requireOrder(ctx.db, organizationId(ctx), input.orderId)).branchId;
    const trusted = await resolveRestaurantActor(ctx, branch ? [branch] : []);
    for (const supplied of [input.actorStaffProfileId, input.createdByStaffId]) {
      if (supplied && supplied !== trusted.staffProfileId)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Actor must be the authenticated staff member.',
        });
    }
    return next({ ctx: { ...ctx, cateringActor: trusted.staffProfileId } });
  });
}
const readProcedure = cateringProcedure('catering:read');
const manageProcedure = cateringProcedure('catering:manage');

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

type Requirement = {
  ingredientId: string;
  ingredientName: string;
  baseUnitId: string;
  stockItemId: string | null;
  quantityInBaseUnit: Prisma.Decimal;
};

async function calculateRequirements(
  db: Pick<ScopedDb, 'restaurantCateringOrderLine'>,
  organizationId: string,
  orderId: string
): Promise<Requirement[]> {
  const lines = await db.restaurantCateringOrderLine.findMany({
    where: { organizationId, orderId, recipeId: { not: null } },
    select: { recipeId: true, portions: true },
  });
  const grouped = new Map<string, Requirement>();
  for (const line of lines) {
    if (!line.recipeId) continue;
    const explosion = await explodeRecipeInDb(db as ScopedDb, {
      organizationId,
      recipeId: line.recipeId,
      portions: line.portions,
    });
    for (const ingredient of explosion.ingredients) {
      const current = grouped.get(ingredient.ingredientId);
      if (current) {
        current.quantityInBaseUnit = current.quantityInBaseUnit.plus(ingredient.quantityInBaseUnit);
      } else {
        grouped.set(ingredient.ingredientId, { ...ingredient });
      }
    }
  }
  return [...grouped.values()].sort((a, b) => a.ingredientName.localeCompare(b.ingredientName));
}

async function calculateLineCosts(
  db: Pick<ScopedDb, 'restaurantCateringOrderLine'>,
  organizationId: string,
  orderId: string
) {
  const lines = await db.restaurantCateringOrderLine.findMany({
    where: { organizationId, orderId },
    select: { id: true, recipeId: true, portions: true, costPerPortionSnapshot: true },
  });
  const results: Array<{
    id: string;
    costPerPortion: Prisma.Decimal | null;
    totalCost: Prisma.Decimal | null;
  }> = [];
  for (const line of lines) {
    let costPerPortion = line.costPerPortionSnapshot;
    if (!costPerPortion && line.recipeId) {
      const result = await computeRecipeCost({ organizationId, recipeId: line.recipeId });
      costPerPortion = result.missing.length ? null : result.costPerPortion;
    }
    const resolved = costPerPortion;
    results.push({
      id: line.id,
      costPerPortion: resolved,
      totalCost: resolved === null ? null : line.portions.times(resolved),
    });
  }
  return results;
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
    recipeId: id,
    description: z.string().trim().min(1).max(500),
    portions: money,
    unitPrice: money,
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict();
const addLineInput = z
  .object({ orderId: id, ...actor })
  .extend(lineShape.shape)
  .strict();

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
  bookingLocations: readProcedure
    .input(z.object({ branchId: id }).strict())
    .query(({ ctx, input }) =>
      ctx.db.restaurantStockLocation.findMany({
        where: {
          organizationId: organizationId(ctx),
          branchId: input.branchId,
          isActive: true,
        },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      })
    ),

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
            createdByStaffId: createdByStaffId ?? ctx.cateringActor,
            quotedTotal: decimal(quotedTotal),
            depositAmount: decimal(depositAmount),
          },
        });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId: created.id,
          eventType: 'CREATED',
          actorStaffProfileId: ctx.cateringActor,
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
        await operations.invalidateQuote(tx as ScopedDb, orgId, orderId);
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
          actorStaffProfileId: actorStaffProfileId ?? ctx.cateringActor,
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
    return serializeOrder({
      ...order,
      ...(await operations.bookingState(ctx.db, organizationId(ctx), input.orderId)),
    });
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
      for (const order of orders) await resolveRestaurantActor(ctx, [order.branchId]);
      return orders.map(serializeOrder);
    }),

  addLine: manageProcedure.input(addLineInput).mutation(async ({ ctx, input }) => {
    const orgId = organizationId(ctx);
    const { orderId, actorStaffProfileId, portions, unitPrice, ...data } = input;
    await requireOrder(ctx.db, orgId, orderId);
    return ctx.db.$transaction(async (tx) => {
      await operations.invalidateQuote(tx as ScopedDb, orgId, orderId);
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
        actorStaffProfileId: actorStaffProfileId ?? ctx.cateringActor,
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
        .extend({ recipeId: id })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = organizationId(ctx);
      const { orderId, lineId, actorStaffProfileId, portions, unitPrice, ...data } = input;
      await requireOrder(ctx.db, orgId, orderId);
      return ctx.db.$transaction(async (tx) => {
        await operations.invalidateQuote(tx as ScopedDb, orgId, orderId);
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
          actorStaffProfileId: actorStaffProfileId ?? ctx.cateringActor,
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
        await operations.invalidateQuote(tx as ScopedDb, orgId, input.orderId);
        const result = await tx.restaurantCateringOrderLine.deleteMany({
          where: { id: input.lineId, orderId: input.orderId, organizationId: orgId },
        });
        if (result.count !== 1)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Catering line not found.' });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId: input.orderId,
          eventType: 'LINE_REMOVED',
          actorStaffProfileId: ctx.cateringActor,
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
        await operations.invalidateQuote(tx as ScopedDb, orgId, input.orderId);
        const cost = await tx.restaurantCateringExtraCost.create({
          data: { ...data, organizationId: orgId, amount: decimal(amount)! },
        });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId: input.orderId,
          eventType: 'EXTRA_COST_ADDED',
          actorStaffProfileId: actorStaffProfileId ?? ctx.cateringActor,
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
        await operations.invalidateQuote(tx as ScopedDb, orgId, input.orderId);
        const result = await tx.restaurantCateringExtraCost.deleteMany({
          where: { id: input.extraCostId, orderId: input.orderId, organizationId: orgId },
        });
        if (result.count !== 1)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Extra cost not found.' });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId: input.orderId,
          eventType: 'EXTRA_COST_REMOVED',
          actorStaffProfileId: ctx.cateringActor,
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
        await operations.lockOrder(tx as ScopedDb, orderId);
        const current = await requireOrder(tx, orgId, orderId);
        if (['CLOSED', 'CANCELLED'].includes(current.status))
          operations.fail('Terminal delivery cannot be edited.');
        const delivery = await tx.restaurantCateringDelivery.upsert({
          where: { orderId },
          create: { ...data, orderId, organizationId: orgId },
          update: data,
        });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId,
          eventType: 'DELIVERY_SET',
          actorStaffProfileId: actorStaffProfileId ?? ctx.cateringActor,
          payload: { scheduledAt: input.scheduledAt.toISOString() },
        });
        return delivery;
      });
    }),

  productionRequirements: readProcedure
    .input(z.object({ orderId: id }).strict())
    .query(async ({ ctx, input }) => {
      const orgId = organizationId(ctx);
      const order = await requireOrder(ctx.db, orgId, input.orderId);
      const frozen = await operations.frozenQuote(ctx.db, orgId, input.orderId);
      if (!frozen && !['DRAFT', 'QUOTED'].includes(order.status))
        operations.fail('Legacy production requirements are unknown.');
      const requirements =
        frozen?.snapshot.requirements ??
        (await calculateRequirements(ctx.db, orgId, input.orderId));
      // Labels are current display metadata for the recorded unit IDs; never re-explode
      // a frozen recipe or rewrite its quantities/snapshot to obtain a label.
      const units = await ctx.db.restaurantUnit.findMany({
        where: {
          organizationId: orgId,
          id: { in: [...new Set(requirements.map((r) => r.baseUnitId))] },
        },
        select: { id: true, name: true, abbreviation: true },
      });
      const unitsById = new Map(units.map((unit) => [unit.id, unit]));
      return requirements.map((requirement) => ({
        ...requirement,
        baseUnit: unitsById.get(requirement.baseUnitId) ?? null,
        quantityInBaseUnit: requirement.quantityInBaseUnit.toString(),
      }));
    }),

  costSummary: readProcedure
    .input(z.object({ orderId: id }).strict())
    .query(async ({ ctx, input }) => {
      const orgId = organizationId(ctx);
      const order = await ctx.db.restaurantCateringOrder.findFirst({
        where: { organizationId: orgId, id: input.orderId },
        select: { quotedTotal: true, extraCosts: { select: { amount: true } } },
      });
      if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'Catering order not found.' });
      const frozen = await operations.frozenQuote(ctx.db, orgId, input.orderId);
      if (frozen) return operations.snapshotCosts(frozen.snapshot);
      const lineCosts = await calculateLineCosts(ctx.db, orgId, input.orderId);
      const recipeCost = lineCosts.reduce(
        (total, line) => total.plus(line.totalCost ?? 0),
        new Prisma.Decimal(0)
      );
      const extraCost = order.extraCosts.reduce(
        (total, cost) => total.plus(cost.amount),
        new Prisma.Decimal(0)
      );
      const totalCost = recipeCost.plus(extraCost);
      const margin = order.quotedTotal?.minus(totalCost) ?? null;
      const marginPercent =
        margin && order.quotedTotal && !order.quotedTotal.isZero()
          ? margin.dividedBy(order.quotedTotal).times(100)
          : null;
      const missing = lineCosts.filter((line) => line.totalCost === null).map((line) => line.id);
      if (missing.length || !lineCosts.length)
        return {
          costBasis: 'MISSING',
          missing,
          recipeCost: null,
          ingredientCost: null,
          extraCost: extraCost.toString(),
          totalCost: null,
          quotedTotal: order.quotedTotal?.toString() ?? null,
          grossMargin: null,
          actualCost: null,
        };
      return {
        costBasis: 'ESTIMATED',
        missing: [],
        ingredientCost: recipeCost.toString(),
        grossMargin: margin?.toString() ?? null,
        actualCost: null,
        recipeCost: recipeCost.toString(),
        extraCost: extraCost.toString(),
        totalCost: totalCost.toString(),
        quotedTotal: order.quotedTotal?.toString() ?? null,
        margin: margin?.toString() ?? null,
        marginPercent: marginPercent?.toString() ?? null,
      };
    }),

  setBooking: manageProcedure
    .input(
      z
        .object({
          orderId: id,
          bookingStartsAt: z.date(),
          bookingEndsAt: z.date(),
          fulfillmentMode: z.enum(['PICKUP', 'DELIVERY']),
          stockLocationId: id,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const result = await operations.setBooking(
          tx as ScopedDb,
          organizationId(ctx),
          input.orderId,
          input
        );
        await appendEvent(tx, {
          organizationId: organizationId(ctx),
          orderId: input.orderId,
          eventType: 'BOOKING_SET',
          actorStaffProfileId: ctx.cateringActor,
          payload: { revision: result.revision },
        });
        return result;
      })
    ),
  setBranchCapacity: manageProcedure
    .input(
      z
        .object({ branchId: id, maxConcurrentHeadcount: z.number().int().positive().nullable() })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        operations.setCapacity(
          tx as ScopedDb,
          organizationId(ctx),
          input.branchId,
          input.maxConcurrentHeadcount
        )
      )
    ),
  bookingAvailability: readProcedure
    .input(z.object({ orderId: id }).strict())
    .query(async ({ ctx, input }) => {
      const org = organizationId(ctx),
        order = await requireOrder(ctx.db, org, input.orderId);
      return operations.availability(ctx.db, org, order.branchId, input.orderId);
    }),
  publishQuote: manageProcedure
    .input(z.object({ orderId: id, currency: z.string().regex(/^[A-Z]{3}$/) }).strict())
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const quote = await operations.publishQuote(
          tx as ScopedDb,
          organizationId(ctx),
          input.orderId,
          input.currency,
          ctx.cateringActor
        );
        return quote;
      })
    ),
  approveQuote: manageProcedure
    .input(z.object({ orderId: id, quoteRevisionId: id }).strict())
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        operations.approveQuote(
          tx as ScopedDb,
          organizationId(ctx),
          input.orderId,
          input.quoteRevisionId,
          ctx.cateringActor
        )
      )
    ),
  paymentSummary: readProcedure
    .input(z.object({ orderId: id }).strict())
    .query(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const org = organizationId(ctx);
        const order = await requireOrder(tx, org, input.orderId);
        return operations.paymentSummary(tx as ScopedDb, org, input.orderId, order.branchId);
      })
    ),
  approvalHistory: readProcedure
    .input(z.object({ orderId: id }).strict())
    .query(async ({ ctx, input }) =>
      ctx.db.$queryRaw<
        Array<{
          id: string;
          quoteRevisionId: string;
          orderRevision: number;
          actorStaffProfileId: string;
          createdAt: Date;
        }>
      >(Prisma.sql`SELECT id,"quoteRevisionId","orderRevision","actorStaffProfileId","createdAt"
      FROM restaurant_catering_quote_approvals WHERE "organizationId"=${organizationId(ctx)} AND "orderId"=${input.orderId} ORDER BY "createdAt",id`)
    ),
  consumptionHistory: readProcedure
    .input(z.object({ orderId: id }).strict())
    .query(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const org = organizationId(ctx);
        const order = await requireOrder(tx, org, input.orderId);
        return operations.consumptionHistory(tx as ScopedDb, org, input.orderId, order.branchId);
      })
    ),
  quoteHistory: readProcedure
    .input(z.object({ orderId: id }).strict())
    .query(async ({ ctx, input }) =>
      ctx.db.$queryRaw<Array<operations.Quote>>(
        Prisma.sql`SELECT id,revision,snapshot,"contentHash","createdAt" FROM restaurant_catering_quote_revisions WHERE "organizationId"=${organizationId(ctx)} AND "orderId"=${input.orderId} ORDER BY revision`
      )
    ),
  recordDisposition: manageProcedure
    .input(
      z
        .object({
          orderId: id,
          originalMovementId: id,
          kind: z.enum(['UNUSED_RETURN', 'WASTE', 'NO_RETURN']),
          quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
          reason: z.string().trim().min(1).max(500),
          idempotencyKey: id,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        operations.recordDisposition(
          tx as ScopedDb,
          organizationId(ctx),
          input.orderId,
          ctx.cateringActor,
          input
        )
      )
    ),

  transition: manageProcedure
    .input(z.object({ orderId: id, to: status, idempotencyKey: id.optional(), ...actor }).strict())
    .mutation(async ({ ctx, input }) => {
      const orgId = organizationId(ctx);
      const order = await ctx.db.$transaction(async (tx) => {
        const scopedTx = tx as ScopedDb;
        const initial = await requireOrder(tx, orgId, input.orderId);
        await operations.lockBranch(scopedTx, orgId, initial.branchId);
        await operations.lockOrder(scopedTx, input.orderId);
        const hash = operations.payloadHash({ to: input.to, actor: ctx.cateringActor });
        if (input.idempotencyKey) {
          const replay = await tx.$queryRaw<
            Array<{ payloadHash: string; result: Record<string, unknown> }>
          >(
            Prisma.sql`SELECT "payloadHash",result FROM restaurant_catering_commands WHERE "organizationId"=${orgId} AND "orderId"=${input.orderId} AND "idempotencyKey"=${input.idempotencyKey}`
          );
          if (replay[0]) {
            if (replay[0].payloadHash !== hash)
              operations.fail('Transition replay payload changed.');
            return replay[0].result;
          }
        }
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
        if (input.to === 'CONFIRMED')
          await operations.confirmQuote(scopedTx, orgId, input.orderId, current.branchId);
        if (input.to === 'READY')
          await operations.consumeFrozen(
            scopedTx,
            orgId,
            input.orderId,
            current.branchId,
            ctx.cateringActor
          );
        const updated = await tx.restaurantCateringOrder.update({
          where: { organizationId_id: { organizationId: orgId, id: input.orderId } },
          data: { status: input.to },
          include: orderInclude,
        });
        await appendEvent(tx, {
          organizationId: orgId,
          orderId: input.orderId,
          eventType: 'STATUS_TRANSITIONED',
          actorStaffProfileId: ctx.cateringActor,
          payload: { from: current.status, to: input.to },
        });
        if (input.idempotencyKey)
          await tx.$executeRaw(
            Prisma.sql`INSERT INTO restaurant_catering_commands ("organizationId","orderId","idempotencyKey","payloadHash",result) VALUES (${orgId},${input.orderId},${input.idempotencyKey},${hash},${JSON.stringify(serializeOrder(updated))}::jsonb)`
          );
        return updated;
      });
      return serializeOrder(order);
    }),
});
