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

import { Prisma } from '@/generated/prisma/client';
import { arrangementFor, PharmacyInventoryError } from '@/lib/pharmacy/inventory';
import {
  confirmPriceChange,
  FileDrapNoticeSource,
  ingestDrapSource,
  ManualDrapNoticeSource,
  recallActionList,
  reverseRecallQuarantine,
  type DrapNotice,
} from '@/lib/pharmacy/drap-monitoring';
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
  CsvTemperatureReadingSource,
  ingestTemperatureReadings,
  loadTemperatureZoneStatuses,
  ManualTemperatureReadingSource,
} from '@/lib/pharmacy/temperature-log';

import {
  auditedProtectedProcedure,
  capabilityProcedure,
  protectedProcedure,
  router,
} from '../trpc';
import type { TRPCContext } from '../trpc';

const branchId = z.string().trim().min(1).max(128);
const expiryPrecision = z.enum(['DAY', 'MONTH']);
const regulatory = capabilityProcedure('pharmacy:safety');
const drapNotice = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('PRICE'),
      sourceReference: z.string().trim().min(1),
      drapRegistrationNumber: z.string().trim().min(1),
      notifiedPriceMinor: z.number().int().nonnegative(),
      effectiveDate: z.date(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('RECALL'),
      sourceReference: z.string().trim().min(1),
      drapRegistrationNumber: z.string().trim().min(1),
      batchNumbers: z.array(z.string().trim().min(1)).optional(),
      reason: z.string().trim().min(1),
    })
    .strict(),
]);

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

// ── WHA-1603 / INV-07 transfers console ────────────────────────────────────
//
// The console composes the existing transfer operations; the only new ledger
// fact is the receipt variance. Units that left the source branch but never
// reached the destination are not "still in transit" — they are lost, and a
// loss is a WRITE_OFF with INV-06 custody, posted once per line.

const RECEIVABLE_TRANSFER_STATUSES = ['DISPATCHED', 'PARTIALLY_RECEIVED', 'EXCEPTION'];

/** One variance per transfer line, whatever the caller's retry key. */
function transferVarianceKey(transferId: string, lineId: string): string {
  return `transfer-variance:${transferId}:${lineId}`;
}

async function transferBoard(db: ScopedDb, scope: LedgerScope) {
  const transfers = await db.pharmacyInterbranchTransfer.findMany({
    where: {
      organizationId: scope.organizationId,
      OR: [{ fromBranchId: scope.branchId }, { toBranchId: scope.branchId }],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      lines: {
        orderBy: { id: 'asc' },
        include: {
          sourceLot: {
            select: {
              unitsPerPack: true,
              batch: {
                select: {
                  batchNumber: true,
                  expiresAt: true,
                  medicine: { select: { productName: true, brandName: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  const lines = transfers.flatMap((transfer) => transfer.lines);
  const locationIds = [
    ...new Set(
      lines.flatMap((line) => [line.sourceStockLocationId, line.destinationStockLocationId])
    ),
  ];
  const branchIds = [...new Set(transfers.flatMap((t) => [t.fromBranchId, t.toBranchId]))];
  const actorIds = [
    ...new Set(
      transfers.flatMap((t) => [t.allocatedById, t.approvedById, t.dispatchedById]).filter(Boolean)
    ),
  ] as string[];
  const [locations, branches, actors, variances] = await Promise.all([
    db.pharmacyStockLocation.findMany({
      where: { organizationId: scope.organizationId, id: { in: locationIds } },
      select: { id: true, name: true, code: true },
    }),
    db.pharmacyBranch.findMany({
      where: { organizationId: scope.organizationId, id: { in: branchIds } },
      select: { id: true, name: true, city: true },
    }),
    db.user.findMany({
      where: { organizationId: scope.organizationId, id: { in: actorIds } },
      select: { id: true, name: true },
    }),
    db.pharmacyStockMovement.findMany({
      where: {
        organizationId: scope.organizationId,
        kind: 'WRITE_OFF',
        idempotencyKey: {
          in: transfers.flatMap((t) => t.lines.map((l) => transferVarianceKey(t.id, l.id))),
        },
      },
      select: { idempotencyKey: true, quantityUnits: true, reason: true },
    }),
  ]);
  const locationById = new Map(locations.map((row) => [row.id, row]));
  const branchById = new Map(branches.map((row) => [row.id, row]));
  const actorName = (id: string | null) =>
    id ? (actors.find((row) => row.id === id)?.name ?? null) : null;
  const varianceByKey = new Map(variances.map((row) => [row.idempotencyKey, row]));

  return transfers.map((transfer) => ({
    id: transfer.id,
    status: transfer.status,
    direction: transfer.fromBranchId === scope.branchId ? 'OUTBOUND' : 'INBOUND',
    fromBranch: {
      id: transfer.fromBranchId,
      name: branchById.get(transfer.fromBranchId)?.name ?? null,
      city: branchById.get(transfer.fromBranchId)?.city ?? null,
    },
    toBranch: {
      id: transfer.toBranchId,
      name: branchById.get(transfer.toBranchId)?.name ?? null,
      city: branchById.get(transfer.toBranchId)?.city ?? null,
    },
    allocatedById: transfer.allocatedById,
    allocatedByName: actorName(transfer.allocatedById),
    approvedByName: actorName(transfer.approvedById),
    dispatchedByName: actorName(transfer.dispatchedById),
    createdAt: transfer.createdAt,
    dispatchedAt: transfer.dispatchedAt,
    receivedAt: transfer.receivedAt,
    lines: transfer.lines.map((line) => {
      const variance = varianceByKey.get(transferVarianceKey(transfer.id, line.id));
      const packs = arrangementFor(line.quantityUnits, line.sourceLot.unitsPerPack);
      return {
        id: line.id,
        medicineName:
          line.sourceLot.batch.medicine.brandName ?? line.sourceLot.batch.medicine.productName,
        batchNumber: line.sourceLot.batch.batchNumber,
        expiresAt: line.sourceLot.batch.expiresAt,
        unitsPerPack: line.sourceLot.unitsPerPack,
        sealedPacks: packs.sealedPacks,
        looseUnits: packs.looseUnits,
        sourceLocation: locationById.get(line.sourceStockLocationId) ?? null,
        destinationLocation: locationById.get(line.destinationStockLocationId) ?? null,
        quantityUnits: line.quantityUnits,
        receivedUnits: line.receivedUnits,
        varianceUnits: variance ? Math.abs(variance.quantityUnits) : 0,
        varianceReason: variance?.reason ?? null,
      };
    }),
  }));
}

type VarianceReceiptInput = {
  transferId: string;
  lines: ReadonlyArray<{ lineId: string; receivedUnits: number }>;
  variance?: { reason: string; witnessId: string; evidenceRef: string };
  idempotencyKeyPrefix: string;
};

/**
 * The closing receipt of a transfer. Every open line is answered with what
 * physically arrived; what did not is written off out of IN_TRANSIT at the
 * source branch, where dispatch left it. The transfer then closes RECEIVED, so
 * the line-by-line receipt path can never draw written-off units back out of
 * transit. Runs inside the caller's transaction.
 */
async function receiveTransferWithVariance(
  db: ScopedDb,
  scope: LedgerScope,
  input: VarianceReceiptInput
) {
  // Serialize receipts of one transfer: the outstanding balances read below
  // must be the ones the postings land on.
  const locked = await db.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM "pharmacy_interbranch_transfers" WHERE "organizationId"=${scope.organizationId} AND id=${input.transferId} AND "toBranchId"=${scope.branchId} FOR UPDATE`
  );
  const transfer = locked[0]
    ? await db.pharmacyInterbranchTransfer.findFirst({
        where: {
          id: input.transferId,
          organizationId: scope.organizationId,
          toBranchId: scope.branchId,
        },
        include: { lines: true },
      })
    : null;
  if (!transfer) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (!RECEIVABLE_TRANSFER_STATUSES.includes(transfer.status))
    throw new PharmacyInventoryError('INVALID_STATE');

  const answered = new Map(input.lines.map((line) => [line.lineId, line.receivedUnits]));
  if (answered.size !== input.lines.length) throw new PharmacyInventoryError('INVALID_UNITS');
  for (const [lineId, units] of answered) {
    const line = transfer.lines.find((one) => one.id === lineId);
    if (!line) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
    if (
      !Number.isSafeInteger(units) ||
      units < 0 ||
      units > line.quantityUnits - line.receivedUnits
    )
      throw new PharmacyInventoryError('INVALID_UNITS');
  }
  const open = transfer.lines.filter((line) => line.receivedUnits < line.quantityUnits);
  // A closing receipt answers every open line; silence is not a count.
  if (open.some((line) => !answered.has(line.id)))
    throw new PharmacyInventoryError('INVALID_UNITS');

  const plan = [];
  for (const line of open) {
    const receivedUnits = answered.get(line.id)!;
    const outstanding = line.quantityUnits - line.receivedUnits;
    const balances = await db.$queryRaw<
      Array<{ onHandUnits: number; sealedPacks: number; looseUnits: number; unitsPerPack: number }>
    >(
      Prisma.sql`SELECT b."onHandUnits",b."sealedPacks",b."looseUnits",l."unitsPerPack" FROM "pharmacy_stock_balances" b JOIN "pharmacy_inventory_lots" l ON l.id=b."inventoryLotId" WHERE b."organizationId"=${scope.organizationId} AND b."branchId"=${transfer.fromBranchId} AND b."inventoryLotId"=${line.sourceLotId} AND b."stockLocationId"=${line.sourceStockLocationId} AND b."disposition"='IN_TRANSIT' FOR UPDATE OF b`
    );
    const transit = balances[0];
    if (!transit || Number(transit.onHandUnits) < outstanding)
      throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
    const unitsPerPack = Number(transit.unitsPerPack);
    // The receipt leg removes a normalised arrangement; the variance takes loose
    // units first. Both have to fit what transit physically holds, or the
    // projection would go negative mid-transaction.
    const receipt =
      receivedUnits > 0
        ? arrangementFor(receivedUnits, unitsPerPack)
        : { sealedPacks: 0, looseUnits: 0 };
    let sealedLeft = Number(transit.sealedPacks) - receipt.sealedPacks;
    let looseLeft = Number(transit.looseUnits) - receipt.looseUnits;
    const varianceUnits = outstanding - receivedUnits;
    const varianceLoose = Math.min(Math.max(looseLeft, 0), varianceUnits);
    const varianceSealedUnits = varianceUnits - varianceLoose;
    sealedLeft -= varianceSealedUnits / unitsPerPack;
    looseLeft -= varianceLoose;
    if (varianceSealedUnits % unitsPerPack !== 0 || sealedLeft < 0 || looseLeft < 0)
      throw new PharmacyInventoryError('INVALID_ARRANGEMENT');
    plan.push({
      line,
      receivedUnits,
      varianceUnits,
      variance: { sealedPacks: varianceSealedUnits / unitsPerPack, looseUnits: varianceLoose },
    });
  }

  const short = plan.some((step) => step.varianceUnits > 0);
  if (short) {
    const evidence = input.variance;
    if (!evidence || evidence.witnessId === scope.actorId)
      throw new PharmacyInventoryError('COAUTH_REQUIRED');
    const witness = await db.user.findFirst({
      where: { id: evidence.witnessId, organizationId: scope.organizationId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!witness) throw new PharmacyInventoryError('COAUTH_REQUIRED');
  }

  const postedVariances = [];
  for (const step of plan) {
    if (step.receivedUnits > 0) {
      await receiveTransferLine(db, scope, {
        transferId: transfer.id,
        lineId: step.line.id,
        receivedUnits: step.receivedUnits,
        idempotencyKeyPrefix: `${input.idempotencyKeyPrefix}:${step.line.id}`,
      });
    }
    if (step.varianceUnits === 0) continue;
    const evidence = input.variance!;
    const movement = await db.pharmacyStockMovement.create({
      data: {
        organizationId: scope.organizationId,
        branchId: transfer.fromBranchId,
        inventoryLotId: step.line.sourceLotId,
        stockLocationId: step.line.sourceStockLocationId,
        kind: 'WRITE_OFF',
        disposition: 'IN_TRANSIT',
        quantityUnits: -step.varianceUnits,
        sealedPackDelta: -step.variance.sealedPacks,
        looseUnitDelta: -step.variance.looseUnits,
        actorId: scope.actorId,
        reason: `Transfer ${transfer.id} receipt variance: ${evidence.reason}`,
        idempotencyKey: transferVarianceKey(transfer.id, step.line.id),
      },
    });
    const custody = await db.pharmacyCustodyRecord.create({
      data: {
        organizationId: scope.organizationId,
        branchId: transfer.fromBranchId,
        movementId: movement.id,
        actorId: scope.actorId,
        witnessId: evidence.witnessId,
        reason: evidence.reason,
        evidenceRef: evidence.evidenceRef,
      },
    });
    postedVariances.push({ lineId: step.line.id, units: step.varianceUnits, movement, custody });
  }

  const closed = await db.pharmacyInterbranchTransfer.update({
    where: { id: transfer.id },
    data: { status: 'RECEIVED', receivedAt: new Date() },
  });
  return { transfer: closed, variances: postedVariances };
}

export const pharmacyInventoryRouter = router({
  ingestDrapManual: regulatory
    .input(z.object({ notices: z.array(drapNotice).min(1).max(100) }).strict())
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        ingestDrapSource(
          txDb(tx),
          actorFor(ctx),
          new ManualDrapNoticeSource(input.notices as DrapNotice[])
        )
      )
    ),

  ingestDrapFile: regulatory
    .input(z.object({ contents: z.string().min(2).max(1_000_000) }).strict())
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        ingestDrapSource(txDb(tx), actorFor(ctx), new FileDrapNoticeSource(input.contents))
      )
    ),

  confirmDrapPrice: regulatory
    .input(z.object({ proposalId: z.string().min(1) }).strict())
    .mutation(({ ctx, input }) => confirmPriceChange(ctx.db, actorFor(ctx), input.proposalId)),

  drapRecallActions: auditedProtectedProcedure
    .input(z.object({ recallNoticeId: z.string().min(1) }).strict())
    .query(({ ctx, input }) => recallActionList(ctx.db, actorFor(ctx), input.recallNoticeId)),

  reverseDrapRecall: regulatory
    .input(
      z
        .object({ recallNoticeId: z.string().min(1), reason: z.string().trim().min(1).max(500) })
        .strict()
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction((tx) =>
        reverseRecallQuarantine(txDb(tx), actorFor(ctx), input.recallNoticeId, input.reason)
      )
    ),

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
          expectedTemperatureReadingIntervalMinutes: z
            .number()
            .int()
            .min(1)
            .max(10_080)
            .default(15),
          temperatureExcursionDurationMinutes: z.number().int().min(1).max(10_080).default(30),
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
        return await ingestTemperatureReadings(
          ctx.db,
          scope,
          input.stockLocationId,
          new ManualTemperatureReadingSource(input)
        );
      } catch (error) {
        domainError(error);
      }
    }),

  importTemperatureCsv: protectedProcedure
    .input(
      z
        .object({
          branchId,
          stockLocationId: z.string().min(1),
          csv: z.string().min(1).max(5_000_000),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      try {
        return await ingestTemperatureReadings(
          ctx.db,
          scope,
          input.stockLocationId,
          new CsvTemperatureReadingSource(input.csv)
        );
      } catch (error) {
        domainError(error);
      }
    }),

  temperatureZoneStatuses: auditedProtectedProcedure
    .input(z.object({ branchId }).strict())
    .query(({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      return loadTemperatureZoneStatuses(ctx.db, scope, new Date());
    }),

  configureTemperatureMonitoring: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          stockLocationId: z.string().min(1),
          expectedTemperatureReadingIntervalMinutes: z.number().int().min(1).max(10_080),
          temperatureExcursionDurationMinutes: z.number().int().min(1).max(10_080),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      const location = await ctx.db.pharmacyStockLocation.findFirst({
        where: {
          id: input.stockLocationId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          active: true,
        },
        select: { id: true },
      });
      if (!location) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Storage zone is outside this branch.' });
      }
      return ctx.db.pharmacyStockLocation.update({
        where: { id: location.id },
        data: {
          expectedTemperatureReadingIntervalMinutes:
            input.expectedTemperatureReadingIntervalMinutes,
          temperatureExcursionDurationMinutes: input.temperatureExcursionDurationMinutes,
        },
      });
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

  /** WHA-1603 INV-07 console: both directions for one branch, slip-ready. */
  transferBoard: auditedProtectedProcedure
    .input(z.object({ branchId }).strict())
    .query(({ ctx, input }) => transferBoard(ctx.db, scopeFor(ctx, input.branchId))),

  /** WHA-1603 INV-07: close a transfer, posting any shortfall as a custody write-off. */
  receiveTransferWithVariance: protectedProcedure
    .input(
      z
        .object({
          branchId,
          transferId: z.string().min(1),
          lines: z
            .array(
              z
                .object({
                  lineId: z.string().min(1),
                  receivedUnits: z.number().int().min(0),
                })
                .strict()
            )
            .min(1)
            .max(100),
          variance: z
            .object({
              reason: z.string().trim().min(1).max(500),
              witnessId: z.string().trim().min(1).max(200),
              evidenceRef: z.string().trim().min(1).max(200),
            })
            .strict()
            .optional(),
          idempotencyKeyPrefix: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          receiveTransferWithVariance(txDb(tx), scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        domainError(error);
      }
    }),
});
