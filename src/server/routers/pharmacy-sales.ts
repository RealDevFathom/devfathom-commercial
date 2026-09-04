import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  PharmacyCounterError,
  readCounterCart,
  readCounterReceipt,
  searchCounterCatalog,
} from '@/lib/pharmacy/counter';
import {
  PharmacyCounterKeymapError,
  resolveCounterKeymap,
  type CounterBinding,
} from '@/lib/pharmacy/counter-keymap';
import {
  linkCustomerToSale,
  PharmacyLoyaltyError,
  readCustomerSnapshot,
  redeemSalePoints,
} from '@/lib/pharmacy/customer-loyalty';
import {
  addSaleLine,
  captureDemand,
  changeSaleStatus,
  createSale,
  demandAggregate,
  PharmacySaleError,
  recoverDemandWithAlternate,
  returnSaleLine,
} from '@/lib/pharmacy/sales';
import type { LedgerScope } from '@/lib/pharmacy/stock-ledger';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  applyPharmacyTender,
  closePharmacyDrawer,
  cutPharmacyDailyClose,
  openPharmacyDrawer,
  PharmacySettlementError,
  recordPharmacyCashMovement,
  refundPharmacyTender,
} from '@/lib/pharmacy/settlement';

import { protectedProcedure, router } from '../trpc';
import type { TRPCContext } from '../trpc';

const branchId = z.string().trim().min(1).max(128);
const saleUnit = z.enum(['PACK', 'STRIP', 'UNIT']);
const demandReason = z.enum([
  'STOCKOUT',
  'NOT_CARRIED',
  'PACK_UNAVAILABLE',
  'QUARANTINED_OR_EXPIRED',
  'PRICE_REJECTED',
  'PRESCRIPTION_RESTRICTION',
  'LICENCE_RESTRICTION',
  'PHARMACIST_RESTRICTION',
  'SUBSTITUTE_DECLINED',
  'SEARCH_FAILURE',
  'SERVICE_FAILURE',
]);
const txDb = (tx: unknown) => tx as ScopedDb;

function scopeFor(ctx: TRPCContext, branch: string): LedgerScope {
  const organizationId = ctx.entitlements?.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!organizationId || !actorId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return { organizationId, branchId: branch, actorId };
}

function fail(error: unknown): never {
  if (error instanceof PharmacyLoyaltyError) {
    throw new TRPCError({
      code:
        error.reason === 'CUSTOMER_NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CONSENT_REQUIRED' || error.reason === 'SALE_NOT_LINKED'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  if (error instanceof PharmacySettlementError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.reason });
  }
  if (error instanceof PharmacyCounterError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CROSS_BRANCH_REFERENCE'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  if (error instanceof PharmacyCounterKeymapError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.reason });
  }
  if (error instanceof PharmacySaleError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'CROSS_BRANCH_REFERENCE'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  throw error;
}

export const pharmacySalesRouter = router({
  customerSnapshot: protectedProcedure
    .input(z.object({ branchId, customerId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await readCustomerSnapshot(ctx.db, scopeFor(ctx, input.branchId), input.customerId);
      } catch (error) {
        fail(error);
      }
    }),
  linkCustomer: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          patientId: z.string().min(1),
          displayName: z.string().trim().min(1).max(200),
          phoneLast4: z
            .string()
            .regex(/^\d{4}$/)
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          linkCustomerToSale(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  redeemPoints: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          points: z.number().int().positive(),
          deviceId: z.string().min(1),
          businessDate: z.date(),
          idempotencyKey: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          redeemSalePoints(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  openDrawer: protectedProcedure
    .input(
      z
        .object({
          branchId,
          deviceId: z.string().min(1),
          businessDate: z.date(),
          openingFloatMinor: z.number().int().nonnegative(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        openPharmacyDrawer(txDb(tx), scopeFor(ctx, input.branchId), input)
      )
    ),
  drawerMovement: protectedProcedure
    .input(
      z
        .object({
          branchId,
          drawerSessionId: z.string().min(1),
          kind: z.enum(['PAID_IN', 'PAID_OUT']),
          amountMinor: z.number().int().positive(),
          reason: z.string().trim().min(1),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        recordPharmacyCashMovement(txDb(tx), scopeFor(ctx, input.branchId), input)
      )
    ),
  closeDrawer: protectedProcedure
    .input(
      z
        .object({
          branchId,
          drawerSessionId: z.string().min(1),
          countedCashMinor: z.number().int().nonnegative(),
          controlledCountHook: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        closePharmacyDrawer(txDb(tx), scopeFor(ctx, input.branchId), input)
      )
    ),
  dailyClose: protectedProcedure
    .input(
      z
        .object({
          branchId,
          businessDate: z.date(),
          reopenReason: z.string().trim().min(1).optional(),
          controlledCountHook: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        cutPharmacyDailyClose(txDb(tx), scopeFor(ctx, input.branchId), input)
      )
    ),
  tender: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          deviceId: z.string().min(1),
          businessDate: z.date(),
          type: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'WALLET', 'CREDIT']),
          amountMinor: z.number().int().positive(),
          cashReceivedMinor: z.number().int().nonnegative().optional(),
          idempotencyKey: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          applyPharmacyTender(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  refundTender: protectedProcedure
    .input(
      z
        .object({
          branchId,
          originalTenderId: z.string().min(1),
          deviceId: z.string().min(1),
          businessDate: z.date(),
          amountMinor: z.number().int().positive(),
          reason: z.string().trim().min(1),
          idempotencyKey: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          refundPharmacyTender(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  create: protectedProcedure
    .input(z.object({ branchId, quotation: z.boolean().default(false) }).strict())
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        createSale(txDb(tx), scopeFor(ctx, input.branchId), input.quotation)
      )
    ),
  addLine: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          medicineId: z.string().min(1),
          presentationId: z.string().min(1),
          packLevelId: z.string().min(1),
          saleUnit,
          quantity: z.number().int().positive(),
          canonicalUnitsPerSaleUnit: z.number().int().positive(),
          discountKind: z.enum(['DISCOUNT', 'PROMOTION', 'COMPLIMENTARY']).optional(),
          discountMinor: z.number().int().nonnegative().optional(),
          approvedByUserId: z.string().min(1).optional(),
          approvalPolicy: z.string().trim().min(1).optional(),
          override: z
            .object({
              inventoryLotId: z.string().min(1),
              reason: z.string().trim().min(1),
              approvalPolicy: z.string().trim().min(1),
            })
            .strict()
            .optional(),
          idempotencyKey: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          addSaleLine(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  transition: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1),
          action: z.enum(['hold', 'resume', 'convertQuotation', 'complete', 'void']),
          reason: z.string().trim().min(1).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          changeSaleStatus(
            txDb(tx),
            scopeFor(ctx, input.branchId),
            input.saleId,
            input.action,
            input.reason
          )
        );
      } catch (error) {
        fail(error);
      }
    }),
  returnLine: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleLineId: z.string().min(1),
          canonicalUnits: z.number().int().positive(),
          quarantineLocationId: z.string().min(1),
          reason: z.string().trim().min(1),
          integrityDecision: z.string().trim().min(1),
          idempotencyKey: z.string().trim().min(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          returnSaleLine(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
  captureDemand: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1).optional(),
          requestedMedicineId: z.string().min(1).optional(),
          requestedText: z.string().trim().min(1).optional(),
          strength: z.string().optional(),
          form: z.string().optional(),
          presentation: z.string().optional(),
          saleUnit,
          quantity: z.number().int().positive(),
          reason: demandReason,
          inventoryRuleSnapshot: z.record(z.string(), z.unknown()),
          estimatedValueMinor: z.number().int().nonnegative().optional(),
          estimatedMarginMinor: z.number().int().optional(),
          customerId: z.string().min(1).optional(),
          consentRecorded: z.boolean().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await captureDemand(ctx.db, scopeFor(ctx, input.branchId), input);
      } catch (error) {
        fail(error);
      }
    }),
  recoverDemand: protectedProcedure
    .input(
      z.object({ branchId, demandId: z.string().min(1), saleLineId: z.string().min(1) }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await recoverDemandWithAlternate(
          ctx.db,
          scopeFor(ctx, input.branchId),
          input.demandId,
          input.saleLineId
        );
      } catch (error) {
        fail(error);
      }
    }),
  demandAggregate: protectedProcedure
    .input(z.object({ branchId, from: z.date(), to: z.date() }).strict())
    .query(({ ctx, input }) =>
      demandAggregate(ctx.db, scopeFor(ctx, input.branchId), input.from, input.to)
    ),

  // ── PH-POS counter reads (POS-01, POS-02, POS-08) ─────────────────────────

  /** The branches this counter may open a bill against, with the money format. */
  counterBranches: protectedProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.entitlements?.organizationId;
    if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
    const [branches, organization] = await Promise.all([
      ctx.db.pharmacyBranch.findMany({
        where: { organizationId, active: true },
        select: { id: true, code: true, name: true, city: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      ctx.db.organization.findUnique({
        where: { id: organizationId },
        select: { currency: true },
      }),
    ]);
    return { branches, currency: organization?.currency ?? 'PKR' };
  }),

  /** POS-02: one search across brand, generic, ingredient, form, barcode and alias. */
  counterSearch: protectedProcedure
    .input(
      z
        .object({
          branchId,
          query: z.string().trim().min(2).max(120),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      try {
        return await searchCounterCatalog(ctx.db, scopeFor(ctx, input.branchId), {
          query: input.query,
          limit: input.limit,
        });
      } catch (error) {
        fail(error);
      }
    }),

  /** The open bill with the FEFO allocation each line actually drew (POS-03). */
  counterCart: protectedProcedure
    .input(z.object({ branchId, saleId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await readCounterCart(ctx.db, scopeFor(ctx, input.branchId), input.saleId);
      } catch (error) {
        fail(error);
      }
    }),

  /**
   * POS-08: the receipt model, for the thermal and A4 renders alike.
   *
   * A query, deliberately. Reprinting re-reads the same sale and therefore the
   * same receipt number; only `tender` can ever issue one.
   */
  counterReceipt: protectedProcedure
    .input(z.object({ branchId, saleId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      try {
        const [branch, organization] = await Promise.all([
          ctx.db.pharmacyBranch.findFirst({
            where: { id: input.branchId, organizationId: scope.organizationId },
            select: { name: true },
          }),
          ctx.db.organization.findUnique({
            where: { id: scope.organizationId },
            select: { currency: true },
          }),
        ]);
        if (!branch) throw new PharmacyCounterError('CROSS_BRANCH_REFERENCE');
        return await readCounterReceipt(ctx.db, scope, input.saleId, {
          name: branch.name,
          currency: organization?.currency ?? 'PKR',
        });
      } catch (error) {
        fail(error);
      }
    }),

  // ── POS-01 configurable shortcuts ─────────────────────────────────────────

  /** This operator's resolved keymap, falling back to the shipped default. */
  counterKeymap: protectedProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.entitlements?.organizationId;
    const userId = ctx.session?.user?.id;
    if (!organizationId || !userId) throw new TRPCError({ code: 'UNAUTHORIZED' });
    const stored = await ctx.db.pharmacyCounterKeymapPreference.findFirst({
      where: { organizationId, userId },
      select: { preset: true, overrides: true },
    });
    try {
      const resolved = resolveCounterKeymap({
        preset: (stored?.preset ?? 'devfathom') as 'devfathom' | 'legacySpeed',
        overrides: (stored?.overrides ?? {}) as Record<string, CounterBinding>,
      });
      return { ...resolved, stored: stored !== null };
    } catch {
      // A row that no longer resolves (a preset removed, a chord that now
      // collides) must not leave the counter with no shortcuts at all. Fall
      // back to the shipped default and say the stored map was not applied.
      return { ...resolveCounterKeymap({ preset: 'devfathom' }), stored: false };
    }
  }),

  /**
   * Save this operator's keymap.
   *
   * Validated before it is written, so a map that would shadow a workflow is
   * refused at the boundary rather than persisted and discovered mid-bill.
   */
  counterSaveKeymap: protectedProcedure
    .input(
      z
        .object({
          preset: z.enum(['devfathom', 'legacySpeed']),
          // Keys are validated by `resolveCounterKeymap` rather than by the
          // schema: it is the same check that rejects a duplicate chord, so an
          // unknown action and a shadowed workflow fail through one path.
          overrides: z
            .record(
              z.string().trim().min(1).max(64),
              z
                .object({
                  key: z.string().trim().min(1).max(16),
                  ctrl: z.boolean().optional(),
                  alt: z.boolean().optional(),
                  shift: z.boolean().optional(),
                })
                .strict()
            )
            .default({}),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements?.organizationId;
      const userId = ctx.session?.user?.id;
      if (!organizationId || !userId) throw new TRPCError({ code: 'UNAUTHORIZED' });
      try {
        const resolved = resolveCounterKeymap({
          preset: input.preset,
          overrides: input.overrides as Record<string, CounterBinding>,
        });
        await ctx.db.pharmacyCounterKeymapPreference.upsert({
          where: { organizationId_userId: { organizationId, userId } },
          update: { preset: input.preset, overrides: input.overrides },
          create: { organizationId, userId, preset: input.preset, overrides: input.overrides },
        });
        return { ...resolved, stored: true };
      } catch (error) {
        fail(error);
      }
    }),
});
