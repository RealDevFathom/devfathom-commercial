/**
 * PH-INV / INV-01..04 — the minimal procedures behind the `pharmacy-inventory`
 * entitlement (module-catalog).
 *
 * Nothing here re-decides an invariant. Branch scope and the hard blocks live in
 * `@/lib/pharmacy/stock-ledger` and its migration triggers; this layer parses
 * input, pins the tenant/branch/actor scope to the SESSION rather than the
 * payload, and maps the domain error onto a tRPC code.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { PharmacyInventoryError } from '@/lib/pharmacy/inventory';
import {
  acknowledgeRecall,
  allocateTransfer,
  approveCount,
  approveTransfer,
  closeRecall,
  createCount,
  createRecall,
  dispatchTransfer,
  nearExpiryBoard,
  quarantinePart,
  recallTrace,
  receiveTransferLine,
  reserveSupplierClaim,
  writeOff,
} from '@/lib/pharmacy/inventory-operations';
import {
  allocateForSale,
  breakPack,
  expiryInstant,
  onHand,
  receiveLot,
  transferStock,
} from '@/lib/pharmacy/stock-ledger';
import type { LedgerScope } from '@/lib/pharmacy/stock-ledger';
import { PharmacyStockSignalError } from '@/lib/pharmacy/stock-signals';
import {
  acknowledgeSignal,
  createDraftAction,
  dismissSignal,
  markStaleSignals,
  ownerDigest,
  refreshStockSignals,
  roleDashboard,
  snoozeSignal,
} from '@/lib/pharmacy/stock-signals-operations';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  appendTemperatureLog,
  ManualTemperatureSensorSource,
} from '@/lib/pharmacy/temperature-log';

import { auditedProtectedProcedure, protectedProcedure, router } from '../trpc';
import type { TRPCContext } from '../trpc';

const branchId = z.string().trim().min(1).max(128);
const expiryPrecision = z.enum(['DAY', 'MONTH']);

/**
 * Prisma's interactive-transaction client omits lifecycle methods from its
 * generated type even though the model delegates are identical (see
 * `lib/tenancy/scoped-db`), so a transaction handle needs the same widening the
 * rest of the repository uses before it reaches a service function.
 */
function txDb(tx: unknown): ScopedDb {
  return tx as ScopedDb;
}

function domainError(error: unknown): never {
  if (error instanceof PharmacyInventoryError) {
    const code =
      error.reason === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.reason === 'CROSS_TENANT_REFERENCE' ||
            error.reason === 'CROSS_BRANCH_REFERENCE' ||
            error.reason === 'BLOCKED_STOCK'
          ? 'FORBIDDEN'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: error.reason });
  }
  if (error instanceof PharmacyStockSignalError) {
    throw new TRPCError({
      code: error.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  throw error;
}

/**
 * The tenant and the actor come from the SESSION, never from an input field:
 * override evidence a caller could name someone else in is not evidence (§8A
 * invariant 5), and a payload-supplied organization is a substitution vector.
 */
function actorFor(ctx: TRPCContext): { organizationId: string; actorId: string } {
  const organizationId = ctx.entitlements?.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!organizationId || !actorId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No tenant actor on this request.' });
  }
  return { organizationId, actorId };
}

function scopeFor(ctx: TRPCContext, branch: string): LedgerScope {
  return { ...actorFor(ctx), branchId: branch };
}

export const pharmacyInventoryRouter = router({
  createLocation: protectedProcedure
    .input(
      z
        .object({
          branchId,
          code: z.string().trim().min(1).max(60),
          name: z.string().trim().min(1).max(200),
          kind: z.enum(['STORE', 'RACK_BIN', 'FRIDGE', 'SAFE', 'QUARANTINE', 'TRANSIT', 'RETURNS']),
          coldChain: z.boolean().default(false),
          minimumTemperatureC: z.number().finite().min(-100).max(100).nullable().default(null),
          maximumTemperatureC: z.number().finite().min(-100).max(100).nullable().default(null),
        })
        .superRefine((value, ctx) => {
          if (
            value.coldChain &&
            (value.minimumTemperatureC === null ||
              value.maximumTemperatureC === null ||
              value.minimumTemperatureC >= value.maximumTemperatureC)
          ) {
            ctx.addIssue({
              code: 'custom',
              message:
                'Validated cold-chain zones require a valid minimum and maximum temperature.',
              path: ['minimumTemperatureC'],
            });
          }
        })
        .strict()
    )
    .mutation(({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      return ctx.db.pharmacyStockLocation.create({
        data: { ...input, organizationId: scope.organizationId },
      });
    }),

  recordTemperature: protectedProcedure
    .input(
      z
        .object({
          branchId,
          stockLocationId: z.string().min(1),
          temperatureC: z.number().finite().min(-100).max(100),
          recordedAt: z.date(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      try {
        return await appendTemperatureLog(
          ctx.db,
          scope,
          input.stockLocationId,
          new ManualTemperatureSensorSource(input)
        );
      } catch (error) {
        domainError(error);
      }
    }),

  registerBatch: protectedProcedure
    .input(
      z
        .object({
          medicineId: z.string().min(1),
          batchNumber: z.string().trim().min(1).max(120),
          printedExpiry: z.date(),
          expiryPrecision,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { organizationId } = actorFor(ctx);
      if (!(await ctx.db.medicine.findFirst({ where: { id: input.medicineId, saleable: true } }))) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Medicine is outside this workspace.' });
      }
      return ctx.db.pharmacyManufacturingBatch.create({
        data: {
          organizationId,
          medicineId: input.medicineId,
          batchNumber: input.batchNumber,
          // Stored as the instant the batch becomes expired, so INV-03 never has
          // to re-derive a precision rule at the counter.
          expiresAt: expiryInstant(input.printedExpiry, input.expiryPrecision),
          expiryPrecision: input.expiryPrecision,
        },
      });
    }),

  /**
   * INV-03/INV-08 seam: block a batch everywhere at once. Recall and batch-level
   * quarantine are organization-wide by §8A invariant 18, so this is not
   * branch-scoped.
   */
  setBatchState: protectedProcedure
    .input(
      z
        .object({
          manufacturingBatchId: z.string().min(1),
          state: z.enum(['ACTIVE', 'RECALLED', 'QUARANTINED']),
          reason: z.string().trim().max(500).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const batch = await ctx.db.pharmacyManufacturingBatch.findFirst({
        where: { id: input.manufacturingBatchId },
      });
      if (!batch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Batch not found.' });
      if (input.state !== 'ACTIVE' && !input.reason) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Blocking a batch requires a reason.',
        });
      }
      return ctx.db.pharmacyManufacturingBatch.update({
        where: { id: batch.id },
        data: {
          state: input.state,
          stateReason: input.state === 'ACTIVE' ? null : (input.reason ?? null),
          stateChangedAt: input.state === 'ACTIVE' ? null : new Date(),
        },
      });
    }),

  receiveLot: protectedProcedure
    .input(
      z
        .object({
          branchId,
          manufacturingBatchId: z.string().min(1),
          packLevelId: z.string().min(1),
          stockLocationId: z.string().min(1),
          unitsPerPack: z.number().int().positive(),
          supplierName: z.string().trim().min(1).max(300),
          supplierInvoiceRef: z.string().trim().min(1).max(200),
          unitCostMinor: z.number().int().nonnegative(),
          printedMrpMinor: z.number().int().nonnegative(),
          printedExpiry: z.date(),
          expiryPrecision,
          quantityUnits: z.number().int().positive(),
          idempotencyKey: z.string().trim().min(1).max(200),
          received: z.boolean().default(true),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      if (!(await ctx.db.packLevel.findFirst({ where: { id: input.packLevelId } }))) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Pack level is outside this workspace.',
        });
      }
      try {
        // The lot and its opening RECEIPT are one fact: a committed lot with no
        // receipt is unreceived stock the ledger would then refuse to move.
        return await ctx.db.$transaction((tx) =>
          receiveLot(txDb(tx), scope, {
            manufacturingBatchId: input.manufacturingBatchId,
            packLevelId: input.packLevelId,
            stockLocationId: input.stockLocationId,
            unitsPerPack: input.unitsPerPack,
            supplierName: input.supplierName,
            supplierInvoiceRef: input.supplierInvoiceRef,
            unitCostMinor: input.unitCostMinor,
            printedMrpMinor: input.printedMrpMinor,
            receivedExpiresAt: expiryInstant(input.printedExpiry, input.expiryPrecision),
            receivedExpiryPrecision: input.expiryPrecision,
            quantityUnits: input.quantityUnits,
            idempotencyKey: input.idempotencyKey,
            receivedAt: input.received ? new Date() : undefined,
          })
        );
      } catch (error) {
        domainError(error);
      }
    }),

  allocateForSale: protectedProcedure
    .input(
      z
        .object({
          branchId,
          medicineId: z.string().min(1),
          requiredUnits: z.number().int().positive(),
          idempotencyKeyPrefix: z.string().trim().min(1).max(160),
          override: z
            .object({
              inventoryLotId: z.string().min(1),
              reason: z.string().trim().min(1).max(500),
              approvalPolicy: z.string().trim().min(1).max(200),
            })
            .strict()
            .optional(),
          emergency: z
            .object({ reason: z.string().trim().min(1).max(500) })
            .strict()
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      try {
        // One transaction: the FOR UPDATE locks the allocator takes over the
        // candidate balances are what stop two counters overselling the same
        // last unit, and they only hold until this transaction ends (INV-02).
        return await ctx.db.$transaction((tx) =>
          allocateForSale(txDb(tx), scope, {
            medicineId: input.medicineId,
            requiredUnits: input.requiredUnits,
            at: new Date(),
            idempotencyKeyPrefix: input.idempotencyKeyPrefix,
            override: input.override,
            emergency: input.emergency,
          })
        );
      } catch (error) {
        domainError(error);
      }
    }),

  breakPack: protectedProcedure
    .input(
      z
        .object({
          branchId,
          inventoryLotId: z.string().min(1),
          stockLocationId: z.string().min(1),
          requiredLooseUnits: z.number().int().positive(),
          idempotencyKey: z.string().trim().min(1).max(200),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await breakPack(ctx.db, scopeFor(ctx, input.branchId), {
          inventoryLotId: input.inventoryLotId,
          stockLocationId: input.stockLocationId,
          requiredLooseUnits: input.requiredLooseUnits,
          idempotencyKey: input.idempotencyKey,
          at: new Date(),
        });
      } catch (error) {
        domainError(error);
      }
    }),

  transfer: protectedProcedure
    .input(
      z
        .object({
          branchId,
          inventoryLotId: z.string().min(1),
          fromStockLocationId: z.string().min(1),
          toStockLocationId: z.string().min(1),
          units: z.number().int().positive(),
          idempotencyKeyPrefix: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      if (input.fromStockLocationId === input.toStockLocationId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Transfer needs two locations.' });
      }
      try {
        // Both legs and the source lock commit together, so the units are never
        // AVAILABLE at the origin and IN_TRANSIT at the destination at once.
        return await ctx.db.$transaction((tx) =>
          transferStock(txDb(tx), scopeFor(ctx, input.branchId), {
            inventoryLotId: input.inventoryLotId,
            fromStockLocationId: input.fromStockLocationId,
            toStockLocationId: input.toStockLocationId,
            units: input.units,
            at: new Date(),
            idempotencyKeyPrefix: input.idempotencyKeyPrefix,
          })
        );
      } catch (error) {
        domainError(error);
      }
    }),

  createCount: protectedProcedure
    .input(
      z
        .object({
          branchId,
          varianceThreshold: z.number().int().nonnegative(),
          readings: z
            .array(
              z
                .object({
                  inventoryLotId: z.string().min(1),
                  stockLocationId: z.string().min(1),
                  countedSealedPacks: z.number().int().nonnegative(),
                  countedLooseUnits: z.number().int().nonnegative(),
                })
                .strict()
            )
            .min(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          createCount(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        domainError(error);
      }
    }),

  approveCount: protectedProcedure
    .input(
      z
        .object({
          branchId,
          countId: z.string().min(1),
          idempotencyKeyPrefix: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          approveCount(
            txDb(tx),
            scopeFor(ctx, input.branchId),
            input.countId,
            input.idempotencyKeyPrefix
          )
        );
      } catch (error) {
        domainError(error);
      }
    }),

  writeOff: protectedProcedure
    .input(
      z
        .object({
          branchId,
          inventoryLotId: z.string().min(1),
          stockLocationId: z.string().min(1),
          units: z.number().int().positive(),
          witnessId: z.string().trim().min(1),
          reason: z.string().trim().min(1).max(500),
          evidenceRef: z.string().trim().min(1).max(500),
          idempotencyKey: z.string().trim().min(1).max(200),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          writeOff(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        domainError(error);
      }
    }),

  quarantinePart: protectedProcedure
    .input(
      z
        .object({
          branchId,
          inventoryLotId: z.string().min(1),
          stockLocationId: z.string().min(1),
          units: z.number().int().positive(),
          damaged: z.boolean().optional(),
          reason: z.string().trim().min(1).max(500),
          idempotencyKeyPrefix: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          quarantinePart(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        domainError(error);
      }
    }),

  allocateTransfer: protectedProcedure
    .input(
      z
        .object({
          branchId,
          toBranchId: branchId,
          lines: z
            .array(
              z
                .object({
                  sourceLotId: z.string().min(1),
                  sourceStockLocationId: z.string().min(1),
                  destinationStockLocationId: z.string().min(1),
                  quantityUnits: z.number().int().positive(),
                })
                .strict()
            )
            .min(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await allocateTransfer(ctx.db, scopeFor(ctx, input.branchId), input);
      } catch (error) {
        domainError(error);
      }
    }),

  approveTransfer: protectedProcedure
    .input(z.object({ branchId, transferId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await approveTransfer(ctx.db, scopeFor(ctx, input.branchId), input.transferId);
      } catch (error) {
        domainError(error);
      }
    }),

  dispatchTransfer: protectedProcedure
    .input(
      z
        .object({
          branchId,
          transferId: z.string().min(1),
          idempotencyKeyPrefix: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          dispatchTransfer(
            txDb(tx),
            scopeFor(ctx, input.branchId),
            input.transferId,
            input.idempotencyKeyPrefix
          )
        );
      } catch (error) {
        domainError(error);
      }
    }),

  receiveTransferLine: protectedProcedure
    .input(
      z
        .object({
          branchId,
          transferId: z.string().min(1),
          lineId: z.string().min(1),
          receivedUnits: z.number().int().positive(),
          idempotencyKeyPrefix: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          receiveTransferLine(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        domainError(error);
      }
    }),

  createRecall: protectedProcedure
    .input(
      z
        .object({
          batchId: z.string().min(1).optional(),
          medicineId: z.string().min(1).optional(),
          reference: z.string().trim().min(1).max(200),
          reason: z.string().trim().min(1).max(500),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) => createRecall(txDb(tx), actorFor(ctx), input));
      } catch (error) {
        domainError(error);
      }
    }),

  recallTrace: auditedProtectedProcedure
    .input(z.object({ recallNoticeId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await recallTrace(ctx.db, actorFor(ctx).organizationId, input.recallNoticeId);
      } catch (error) {
        domainError(error);
      }
    }),

  acknowledgeRecall: protectedProcedure
    .input(z.object({ branchId, recallNoticeId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await acknowledgeRecall(ctx.db, scopeFor(ctx, input.branchId), input.recallNoticeId);
      } catch (error) {
        domainError(error);
      }
    }),

  closeRecall: protectedProcedure
    .input(z.object({ recallNoticeId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          closeRecall(txDb(tx), actorFor(ctx), input.recallNoticeId)
        );
      } catch (error) {
        domainError(error);
      }
    }),

  reserveSupplierClaim: protectedProcedure
    .input(
      z
        .object({
          branchId,
          inventoryLotId: z.string().min(1),
          reservedUnits: z.number().int().positive(),
          returnBy: z.date(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await reserveSupplierClaim(ctx.db, scopeFor(ctx, input.branchId), input);
      } catch (error) {
        domainError(error);
      }
    }),

  nearExpiryBoard: auditedProtectedProcedure
    .input(z.object({ branchId }).strict())
    .query(({ ctx, input }) => nearExpiryBoard(ctx.db, scopeFor(ctx, input.branchId), new Date())),

  onHand: auditedProtectedProcedure
    .input(z.object({ branchId, medicineId: z.string().min(1) }).strict())
    .query(({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      return onHand(
        ctx.db,
        { organizationId: scope.organizationId, branchId: scope.branchId },
        input.medicineId,
        new Date()
      );
    }),

  // ── PUR-07 — the deterministic stock action centre ────────────────────────

  /** The approved threshold a stock-level signal is measured against. */
  approveSafetyStock: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          medicineId: z.string().min(1),
          safetyStockUnits: z.number().int().min(0),
          coverageDays: z.number().int().positive().max(365).default(30),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      if (!(await ctx.db.medicine.findFirst({ where: { id: input.medicineId, saleable: true } }))) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Medicine is outside this workspace.' });
      }
      const data = {
        safetyStockUnits: input.safetyStockUnits,
        coverageDays: input.coverageDays,
        // The approver is the SESSION actor: a threshold approved by whoever the
        // payload names is not an approval.
        approvedByUserId: scope.actorId,
        approvedAt: new Date(),
      };
      return ctx.db.pharmacySafetyStock.upsert({
        where: {
          organizationId_branchId_medicineId: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            medicineId: input.medicineId,
          },
        },
        create: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          medicineId: input.medicineId,
          ...data,
        },
        update: data,
      });
    }),

  /** Recompute the branch's signals from current ledger facts. */
  refreshStockSignals: auditedProtectedProcedure
    .input(z.object({ branchId }).strict())
    .mutation(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      try {
        return await ctx.db.$transaction((tx) => refreshStockSignals(txDb(tx), scope, new Date()));
      } catch (error) {
        domainError(error);
      }
    }),

  markStaleSignals: auditedProtectedProcedure
    .input(z.object({ branchId }).strict())
    .mutation(({ ctx, input }) =>
      markStaleSignals(ctx.db, scopeFor(ctx, input.branchId), new Date())
    ),

  acknowledgeSignal: auditedProtectedProcedure
    .input(z.object({ branchId, signalId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await acknowledgeSignal(ctx.db, scopeFor(ctx, input.branchId), {
          signalId: input.signalId,
          at: new Date(),
        });
      } catch (error) {
        domainError(error);
      }
    }),

  /** §8A invariant 29: a snooze is only auditable with its reason attached. */
  snoozeSignal: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          signalId: z.string().min(1),
          until: z.date(),
          reason: z.string().trim().min(1).max(500),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await snoozeSignal(ctx.db, scopeFor(ctx, input.branchId), {
          signalId: input.signalId,
          until: input.until,
          reason: input.reason,
          at: new Date(),
        });
      } catch (error) {
        domainError(error);
      }
    }),

  dismissSignal: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          signalId: z.string().min(1),
          reason: z.string().trim().min(1).max(500),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await dismissSignal(ctx.db, scopeFor(ctx, input.branchId), {
          signalId: input.signalId,
          reason: input.reason,
          at: new Date(),
        });
      } catch (error) {
        domainError(error);
      }
    }),

  /**
   * §8A invariant 29: the one-click action. Creates a DRAFT requisition,
   * transfer or claim — never an order, never a stock movement.
   */
  createDraftAction: auditedProtectedProcedure
    .input(
      z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('DRAFT_REQUISITION'),
            branchId,
            signalId: z.string().min(1),
            reference: z.string().trim().min(1).max(120),
            medicineId: z.string().min(1),
            packLevelId: z.string().min(1),
            canonicalUnitsPerPack: z.number().int().positive(),
            quantityPacks: z.number().int().positive(),
            neededBy: z.date().optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal('DRAFT_TRANSFER'),
            branchId,
            signalId: z.string().min(1),
            fromBranchId: z.string().trim().min(1).max(128),
            lines: z
              .array(
                z
                  .object({
                    sourceLotId: z.string().min(1),
                    sourceStockLocationId: z.string().min(1),
                    destinationStockLocationId: z.string().min(1),
                    quantityUnits: z.number().int().positive(),
                  })
                  .strict()
              )
              .min(1),
          })
          .strict(),
        z
          .object({
            kind: z.literal('DRAFT_CLAIM'),
            branchId,
            signalId: z.string().min(1),
            reference: z.string().trim().min(1).max(120),
            supplierId: z.string().min(1),
            lines: z
              .array(
                z
                  .object({
                    inventoryLotId: z.string().min(1),
                    stockLocationId: z.string().min(1),
                    quantityUnits: z.number().int().positive(),
                    reason: z.string().trim().min(1).max(500),
                    returnWindowEndsAt: z.date(),
                    expectedCreditMinor: z.number().int().min(0),
                  })
                  .strict()
              )
              .min(1),
          })
          .strict(),
      ])
    )
    .mutation(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      try {
        return await ctx.db.$transaction((tx) => createDraftAction(txDb(tx), scope, input));
      } catch (error) {
        domainError(error);
      }
    }),

  /** PUR-07 role dashboards: live signals per kind and accountable owner. */
  stockSignalDashboard: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      return roleDashboard(
        ctx.db,
        { organizationId: scope.organizationId, branchId: scope.branchId },
        new Date()
      );
    }),

  /** PUR-07 owner digest payload. */
  stockSignalDigest: protectedProcedure
    .input(z.object({ branchId, ownerUserId: z.string().trim().min(1).max(200) }).strict())
    .query(({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      return ownerDigest(
        ctx.db,
        { organizationId: scope.organizationId, branchId: scope.branchId },
        input.ownerUserId,
        new Date()
      );
    }),
});
