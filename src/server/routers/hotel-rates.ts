/**
 * MEAL-01 — `hotelRates.mealPlans.*` (05 §3).
 *
 * Every procedure gates on `hotel:rates` (06 §1: "rate plans, meal plans,
 * seasons, overrides, restrictions, FX source, recommendations apply/reject,
 * parity"), through the ABAC engine and its default-deny catalogue. Reads are
 * included: which plans a property sells, and at which outlets, is commercial
 * configuration rather than operating data.
 *
 * The rest of `hotelRates` — seasons, overrides, restrictions, FX,
 * recommendations, parity, promo codes — arrives in the later rate lanes and
 * joins this router; the meal plans are here because H1-08 attaches one to every
 * rate plan.
 *
 * Editing a plan in place is safe on purpose: a reservation carries a frozen
 * `meal_snapshot` (src/lib/hotel/meal-plans.ts), so MEAL-01's "changing a meal
 * plan never changes a confirmed reservation" holds without versioning this
 * table. What an edit does change is what a *future* reservation is sold.
 *
 * Every query carries an explicit `organizationId` predicate. Forced row-level
 * security is the second wall and never the only one.
 */
import { TRPCError } from '@trpc/server';

import type { Prisma } from '@/generated/prisma/client';
import {
  mealPlanCreateInput,
  mealPlanSetActiveInput,
  mealPlanUpdateInput,
  parseMealPlanMeals,
} from '@/lib/hotel/meal-plans';
import { capabilityProcedure, router, type TRPCContext } from '../trpc';

const rates = capabilityProcedure('hotel:rates');

/**
 * The property a hospitality organization operates. Resolved per call rather
 * than trusted from the input: a meal plan belongs to the property, and no
 * request gets to name which property it is writing to.
 */
async function currentPropertyBranchId(ctx: TRPCContext): Promise<string> {
  const property = await ctx.db.hotelProperty.findFirst({
    where: { organizationId: ctx.entitlements.organizationId, active: true },
    orderBy: { createdAt: 'asc' },
    select: { branchId: true },
  });
  if (!property) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message:
        'This workspace has no property yet. A property is created with the workspace, so ask your DevFathom account manager to re-run provisioning.',
    });
  }
  return property.branchId;
}

function planNotFound(): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message: 'That meal plan no longer exists.' });
}

/**
 * A validated `meals` document on its way into JSONB. The round-trip drops
 * anything Prisma's `InputJsonValue` cannot carry rather than asserting the
 * shape and hoping; the database re-checks it either way.
 */
function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** A row as an operator surface reads it, with `meals` parsed out of JSONB. */
function asMealPlan(row: {
  id: string;
  code: string;
  name: string;
  nameUr: string | null;
  meals: unknown;
  active: boolean;
}) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    nameUr: row.nameUr,
    meals: parseMealPlanMeals(row.meals),
    active: row.active,
  };
}

const planSelect = {
  id: true,
  code: true,
  name: true,
  nameUr: true,
  meals: true,
  active: true,
} as const;

export const hotelRatesRouter = router({
  mealPlans: router({
    /** Every plan the property has, inactive ones included — this is the editor. */
    list: rates.query(async ({ ctx }) => {
      const branchId = await currentPropertyBranchId(ctx);
      const plans = await ctx.db.hotelMealPlan.findMany({
        where: { organizationId: ctx.entitlements.organizationId, branchId },
        orderBy: [{ active: 'desc' }, { code: 'asc' }],
        select: planSelect,
      });
      return { plans: plans.map(asMealPlan) };
    }),

    /** MEAL-01 — a custom plan, or one of the standard codes a property re-adds. */
    create: rates.input(mealPlanCreateInput).mutation(async ({ ctx, input }) => {
      const branchId = await currentPropertyBranchId(ctx);
      const duplicate = await ctx.db.hotelMealPlan.findFirst({
        where: { organizationId: ctx.entitlements.organizationId, branchId, code: input.code },
        select: { id: true },
      });
      if (duplicate) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `This property already sells a plan coded ${input.code}.`,
        });
      }

      const plan = await ctx.db.hotelMealPlan.create({
        data: {
          organizationId: ctx.entitlements.organizationId,
          branchId,
          code: input.code,
          name: input.name,
          nameUr: input.nameUr ?? null,
          meals: inputJson(input.meals),
          active: input.active,
        },
        select: planSelect,
      });
      return { plan: asMealPlan(plan) };
    }),

    /**
     * Change what a plan covers. The code is not editable: it is the plan's
     * identity on a voucher, a rate and a channel push, and a property that
     * wants a different one is describing a different plan.
     */
    update: rates.input(mealPlanUpdateInput).mutation(async ({ ctx, input }) => {
      const branchId = await currentPropertyBranchId(ctx);
      // Scoped by `(organizationId, branchId, id)` rather than by the primary
      // key alone, so a crafted id cannot address another tenant's plan even if
      // RLS were ever relaxed for a maintenance connection.
      const written = await ctx.db.hotelMealPlan.updateMany({
        where: { organizationId: ctx.entitlements.organizationId, branchId, id: input.id },
        data: {
          name: input.name,
          nameUr: input.nameUr ?? null,
          meals: inputJson(input.meals),
          active: input.active,
        },
      });
      if (written.count === 0) throw planNotFound();

      const plan = await ctx.db.hotelMealPlan.findFirst({
        where: { organizationId: ctx.entitlements.organizationId, branchId, id: input.id },
        select: planSelect,
      });
      if (!plan) throw planNotFound();
      return { plan: asMealPlan(plan) };
    }),

    /**
     * Withdraw a plan from sale, or put one back. Never a delete: a reservation
     * sold under a plan keeps its snapshot, and the reports that group by plan
     * code still have to name it.
     */
    setActive: rates.input(mealPlanSetActiveInput).mutation(async ({ ctx, input }) => {
      const branchId = await currentPropertyBranchId(ctx);
      const written = await ctx.db.hotelMealPlan.updateMany({
        where: { organizationId: ctx.entitlements.organizationId, branchId, id: input.id },
        data: { active: input.active },
      });
      if (written.count === 0) throw planNotFound();
      return { id: input.id, active: input.active };
    }),
  }),
});
