/**
 * MEAL-01 — `hotelRates.mealPlans.*` (05 §3).
 *
 * Every procedure gates on `hotel:rates` (06 §1: "rate plans, meal plans,
 * seasons, overrides, restrictions, FX source, recommendations apply/reject,
 * parity") twice: the ABAC engine's organization-level `can`, then
 * `requireHotelPropertyScope` for the property the caller selected, which also
 * demands an active assignment there whose role ALLOWs the capability. Reads
 * are included: which plans a property sells, and at which outlets, is
 * commercial configuration rather than operating data.
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
 * Every write runs inside `withLockedProperty` (lock, re-check access, write),
 * scoped by `(organizationId, branchId, id)` and by the version the editor saw,
 * and every mutation enriches the request's audit row. Forced row-level
 * security is the second wall and never the only one.
 */
import { TRPCError } from '@trpc/server';
import { z, ZodRealError, type ZodError } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import { recordHotelAudit } from '@/lib/hotel/audit';
import {
  HOTEL_MEALS,
  HOTEL_MEAL_LABELS,
  STANDARD_MEAL_PLAN_CODES,
  mealPlanCreateInput,
  mealPlanSetActiveInput,
  mealPlanUpdateInput,
  parseMealPlanMeals,
} from '@/lib/hotel/meal-plans';
import {
  currentProperty,
  uniqueViolationColumns,
  withLockedProperty,
  type PropertyContext,
} from '@/server/hotel-property-context';
import { hotelPropertySelectionInput } from '@/server/hotel-property-scope';
import { capabilityProcedure, router } from '../trpc';
import { hotelRatePlansRouter } from './hotel-rate-plans';

const rates = capabilityProcedure('hotel:rates');
const RATES = 'hotel:rates' as const;

/** The version the editor saw; a write against another version is a conflict. */
const expectedVersionInput = z.object({ expectedUpdatedAt: z.coerce.date() });

/**
 * A rule the database enforces but the input schema cannot see — a code this
 * property already sells — stated as a field error so it reaches the form
 * through `data.validation` exactly like a shape failure does (UX rule 11).
 */
function fieldError(field: string, message: string): ZodError {
  return new ZodRealError([{ code: 'custom', path: [field], message, input: undefined }]);
}

function takenCode(code: string): TRPCError {
  const message = `This property already sells a plan coded ${code}. Choose another code, or edit that plan.`;
  return new TRPCError({ code: 'BAD_REQUEST', message, cause: fieldError('code', message) });
}

function planChanged(): TRPCError {
  return new TRPCError({
    code: 'CONFLICT',
    message: 'That meal plan changed or no longer exists. Reload the list and try again.',
  });
}

/**
 * A validated `meals` document on its way into JSONB. The round-trip drops
 * anything Prisma's `InputJsonValue` cannot carry rather than asserting the
 * shape and hoping; the database re-checks it either way.
 */
function mealsJson(meals: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(meals)) as Prisma.InputJsonValue;
}

/** The columns every surface reads. `updatedAt` is the version an editor sends back. */
const planSelect = {
  id: true,
  code: true,
  name: true,
  nameUr: true,
  meals: true,
  active: true,
  updatedAt: true,
} as const;

type PlanRow = {
  id: string;
  code: string;
  name: string;
  nameUr: string | null;
  meals: unknown;
  active: boolean;
  updatedAt: Date;
};

/** A row as an operator surface reads it, with `meals` parsed out of JSONB. */
function asMealPlan(row: PlanRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    nameUr: row.nameUr,
    meals: parseMealPlanMeals(row.meals),
    active: row.active,
    updatedAt: row.updatedAt,
    /** One of the industry's four codes, as opposed to a plan this property invented. */
    standard: (STANDARD_MEAL_PLAN_CODES as readonly string[]).includes(row.code),
  };
}

export type HotelMealPlanView = ReturnType<typeof asMealPlan>;

/** The services a form offers, already named for an operator (UX rule 1). */
const mealOptions = HOTEL_MEALS.map((value) => ({ value, label: HOTEL_MEAL_LABELS[value] }));

/**
 * The property selection joined onto a lib contract as ONE parser, so the lib
 * schema stays strict about its own fields and its refinements intact.
 */
function selected<Shape extends z.ZodRawShape, Config extends z.core.$ZodObjectConfig>(
  schema: z.ZodObject<Shape, Config>
) {
  return schema.extend(hotelPropertySelectionInput.shape);
}

/**
 * PROP-05's pattern: the unique index is the guarantee; this read exists so
 * the operator gets the refusal on the `code` field rather than a constraint
 * name. Two simultaneous creates still lose to the index, which the catch
 * below translates the same way.
 */
async function refuseATakenCode(ctx: PropertyContext, branchId: string, code: string) {
  const clash = await ctx.db.hotelMealPlan.findFirst({
    where: { organizationId: ctx.entitlements.organizationId, branchId, code },
    select: { id: true },
  });
  if (clash) throw takenCode(code);
}

function mapMealPlanError(error: unknown, code: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = uniqueViolationColumns(error);
    if (
      target.includes('hotel_meal_plans_org_branch_code_key') ||
      target.some((column) => column.includes('code'))
    ) {
      throw takenCode(code);
    }
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'That meal plan already exists. Reload the list and try again.',
      cause: error,
    });
  }
  throw error;
}

export const hotelRatesRouter = router({
  ratePlans: hotelRatePlansRouter,
  mealPlans: router({
    /** Every plan the property has, inactive ones included — this is the editor. */
    list: rates.input(hotelPropertySelectionInput).query(async ({ ctx, input }) => {
      const property = await currentProperty(ctx, input.branchId, RATES);
      const plans = await ctx.db.hotelMealPlan.findMany({
        where: { organizationId: ctx.entitlements.organizationId, branchId: property.branchId },
        orderBy: [{ active: 'desc' }, { code: 'asc' }],
        select: planSelect,
      });
      return {
        plans: plans.map(asMealPlan),
        mealOptions,
        standardCodes: STANDARD_MEAL_PLAN_CODES,
      };
    }),

    /** MEAL-01 — a custom plan, or one of the standard codes a property re-adds. */
    create: rates.input(selected(mealPlanCreateInput)).mutation(({ ctx, input }) =>
      withLockedProperty(
        ctx,
        input.branchId,
        async (ctx, property) => {
          await refuseATakenCode(ctx, property.branchId, input.code);
          try {
            const plan = await ctx.db.hotelMealPlan.create({
              data: {
                organizationId: ctx.entitlements.organizationId,
                branchId: property.branchId,
                code: input.code,
                name: input.name,
                nameUr: input.nameUr ?? null,
                meals: mealsJson(input.meals),
                active: input.active,
              },
              select: planSelect,
            });
            recordHotelAudit(ctx, {
              entity: { type: 'HotelMealPlan', id: plan.id, label: `${plan.code} ${plan.name}` },
              action: 'hotel.rates.mealPlan.create',
              operation: 'CREATE',
              after: { code: plan.code, name: plan.name, meals: input.meals, active: plan.active },
              metadata: { branchId: property.branchId },
            });
            return { plan: asMealPlan(plan) };
          } catch (error) {
            mapMealPlanError(error, input.code);
          }
        },
        RATES
      )
    ),

    /**
     * Change what a plan covers. The code is not editable: it is the plan's
     * identity on a voucher, a rate and a channel push, and a property that
     * wants a different one is describing a different plan.
     */
    update: rates
      .input(selected(mealPlanUpdateInput).extend(expectedVersionInput.shape))
      .mutation(({ ctx, input }) =>
        withLockedProperty(
          ctx,
          input.branchId,
          async (ctx, property) => {
            // Scoped by `(organizationId, branchId, id)` and the version the
            // editor saw, so a crafted id cannot address another tenant's plan
            // and a stale form cannot overwrite a colleague's change.
            const where = {
              organizationId: ctx.entitlements.organizationId,
              branchId: property.branchId,
              id: input.id,
            };
            const before = await ctx.db.hotelMealPlan.findFirst({ where, select: planSelect });
            if (!before || before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
              throw planChanged();
            }
            const written = await ctx.db.hotelMealPlan.updateMany({
              where: { ...where, updatedAt: input.expectedUpdatedAt },
              data: {
                name: input.name,
                nameUr: input.nameUr ?? null,
                meals: mealsJson(input.meals),
                active: input.active,
              },
            });
            if (written.count !== 1) throw planChanged();
            const plan = await ctx.db.hotelMealPlan.findFirst({ where, select: planSelect });
            if (!plan) throw planChanged();
            recordHotelAudit(ctx, {
              entity: { type: 'HotelMealPlan', id: plan.id, label: `${plan.code} ${plan.name}` },
              action: 'hotel.rates.mealPlan.update',
              before: {
                name: before.name,
                nameUr: before.nameUr,
                meals: parseMealPlanMeals(before.meals),
                active: before.active,
              },
              after: {
                name: plan.name,
                nameUr: plan.nameUr,
                meals: input.meals,
                active: plan.active,
              },
              metadata: { branchId: property.branchId },
            });
            return { plan: asMealPlan(plan) };
          },
          RATES
        )
      ),

    /**
     * Withdraw a plan from sale, or put one back. Never a delete: a reservation
     * sold under a plan keeps its snapshot, and the reports that group by plan
     * code still have to name it.
     */
    setActive: rates
      .input(selected(mealPlanSetActiveInput).extend(expectedVersionInput.shape))
      .mutation(({ ctx, input }) =>
        withLockedProperty(
          ctx,
          input.branchId,
          async (ctx, property) => {
            const written = await ctx.db.hotelMealPlan.updateMany({
              where: {
                organizationId: ctx.entitlements.organizationId,
                branchId: property.branchId,
                id: input.id,
                updatedAt: input.expectedUpdatedAt,
              },
              data: { active: input.active },
            });
            if (written.count !== 1) throw planChanged();
            recordHotelAudit(ctx, {
              entity: { type: 'HotelMealPlan', id: input.id },
              action: input.active
                ? 'hotel.rates.mealPlan.activate'
                : 'hotel.rates.mealPlan.retire',
              before: { active: !input.active },
              after: { active: input.active },
              metadata: { branchId: property.branchId },
            });
            return { id: input.id, active: input.active };
          },
          RATES
        )
      ),
  }),
});
