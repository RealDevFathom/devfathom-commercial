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
import { PharmacySupplierReturnError } from '@/lib/pharmacy/supplier-returns';
import { createPurchaseReturn } from '@/lib/pharmacy/supplier-returns-operations';
import {
  acknowledgeSignal,
  createDraftAction,
  dismissSignal,
  markStaleSignals,
  ownerDigest,
  PharmacyDraftIntentError,
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
import { assertInOrganization } from '../org-refs';
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

async function scopeFor(ctx: TRPCContext, branch: string): Promise<LedgerScope> {
  const actor = actorFor(ctx);
  await assertInOrganization(ctx.db.pharmacyBranch, actor.organizationId, [branch], {
    active: true,
  });
  return { ...actor, branchId: branch };
}

// ── PH-A5 — expiry board actions ────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** The board's look-ahead choices; the widest one also bounds every action. */
export const EXPIRY_BOARD_WINDOWS = [30, 60, 90, 180] as const;
const EXPIRY_ACTION_HORIZON_DAYS = 180;
const LIVE_SIGNAL_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'SNOOZED', 'STALE'] as const;
/**
 * There is no pharmacy price-rule table yet, so a mark-down is recorded as a
 * DRAFT_ACTION event on the lot's NEAR_EXPIRY signal — append-only, attributed,
 * and inert: nothing at the counter reads it. This prefix is how the board finds
 * its own drafts among the other DRAFT_ACTION events.
 */
export const MARKDOWN_DRAFT_PREFIX = 'DRAFT mark-down ';

export type ExpiryMarkdownDraft = {
  inventoryLotId: string;
  stockLocationId: string;
  batchNumber: string;
  markdownPercent: number;
  printedMrpMinor: number;
  proposedPackPriceMinor: number;
  unitsPerPack: number;
  unitCostMinor: number;
  onHandUnits: number;
  expiresAt: string;
};

export function parseMarkdownDraft(detail: string | null): ExpiryMarkdownDraft | null {
  if (!detail?.startsWith(MARKDOWN_DRAFT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(detail.slice(MARKDOWN_DRAFT_PREFIX.length)) as ExpiryMarkdownDraft;
    return typeof parsed.inventoryLotId === 'string' &&
      typeof parsed.stockLocationId === 'string' &&
      Number.isSafeInteger(parsed.proposedPackPriceMinor)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Pack price after `percent` off the printed MRP, rounded to the nearest minor unit. */
export function markdownPackPrice(printedMrpMinor: number, percent: number): number {
  return Math.round((printedMrpMinor * (100 - percent)) / 100);
}

function expiryError(error: unknown): never {
  if (error instanceof PharmacySupplierReturnError) {
    throw new TRPCError({
      code:
        error.reason === 'CROSS_TENANT_REFERENCE' || error.reason === 'CROSS_BRANCH_REFERENCE'
          ? 'FORBIDDEN'
          : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  domainError(error);
}

/** The payload names a branch; only the session's organization may own it. */
async function assertBranch(db: ScopedDb, scope: LedgerScope) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
    select: { id: true },
  });
  if (!branch) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside this workspace.' });
  }
}

/**
 * Lock the lot row so two operators acting on the same lot serialize: the
 * second one re-reads the first one's draft or movement instead of racing it.
 */
async function lockExpiringLot(db: ScopedDb, scope: LedgerScope, inventoryLotId: string) {
  await db.$queryRaw(
    Prisma.sql`SELECT "id" FROM "pharmacy_inventory_lots" WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND "id"=${inventoryLotId} FOR UPDATE`
  );
  const lot = await db.pharmacyInventoryLot.findFirst({
    where: { id: inventoryLotId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: {
      batch: { select: { batchNumber: true, expiresAt: true, state: true, medicineId: true } },
    },
  });
  if (!lot) throw new TRPCError({ code: 'FORBIDDEN', message: 'Lot is outside this branch.' });
  return lot;
}

function assertOnBoard(expiresAt: Date, at: Date) {
  if (expiresAt.getTime() > at.getTime() + EXPIRY_ACTION_HORIZON_DAYS * DAY_MS) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `This lot does not expire within ${EXPIRY_ACTION_HORIZON_DAYS} days.`,
    });
  }
}

async function availableAt(
  db: ScopedDb,
  scope: LedgerScope,
  inventoryLotId: string,
  stockLocationId: string
) {
  const balance = await db.pharmacyStockBalance.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId,
      stockLocationId,
      disposition: 'AVAILABLE',
    },
    select: { onHandUnits: true },
  });
  return balance?.onHandUnits ?? 0;
}

const expiryPosition = {
  branchId,
  inventoryLotId: z.string().min(1).max(128),
  stockLocationId: z.string().min(1).max(128),
};

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
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        ingestDrapSource(
          txDb(tx),
          actorFor(ctx),
          new ManualDrapNoticeSource(input.notices as DrapNotice[])
        )
      )
    ),

  ingestDrapFile: regulatory
    .input(z.object({ contents: z.string().min(2).max(1_000_000) }).strict())
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
        ingestDrapSource(txDb(tx), actorFor(ctx), new FileDrapNoticeSource(input.contents))
      )
    ),

  confirmDrapPrice: regulatory
    .input(z.object({ proposalId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) =>
      confirmPriceChange(ctx.db, actorFor(ctx), input.proposalId)
    ),

  drapRecallActions: auditedProtectedProcedure
    .input(z.object({ recallNoticeId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => recallActionList(ctx.db, actorFor(ctx), input.recallNoticeId)),

  reverseDrapRecall: regulatory
    .input(
      z
        .object({ recallNoticeId: z.string().min(1), reason: z.string().trim().min(1).max(500) })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db.$transaction(async (tx) =>
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
    .mutation(async ({ ctx, input }) => {
      const scope = await scopeFor(ctx, input.branchId);
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
      const scope = await scopeFor(ctx, input.branchId);
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
      const scope = await scopeFor(ctx, input.branchId);
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
    .query(async ({ ctx, input }) => {
      const scope = await scopeFor(ctx, input.branchId);
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
      const scope = await scopeFor(ctx, input.branchId);
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
  setBatchState: regulatory
    .input(
      z
        .object({
          manufacturingBatchId: z.string().min(1),
          // Reactivation belongs to the recall close/reversal workflows, which
          // verify the recall evidence before restoring affected stock.
          state: z.enum(['RECALLED', 'QUARANTINED']),
          reason: z.string().trim().max(500).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const batch = await ctx.db.pharmacyManufacturingBatch.findFirst({
        where: { id: input.manufacturingBatchId },
      });
      if (!batch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Batch not found.' });
      if (!input.reason) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Blocking a batch requires a reason.',
        });
      }
      return ctx.db.pharmacyManufacturingBatch.update({
        where: { id: batch.id },
        data: {
          state: input.state,
          stateReason: input.reason,
          stateChangedAt: new Date(),
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
      const scope = await scopeFor(ctx, input.branchId);
      if (!(await ctx.db.packLevel.findFirst({ where: { id: input.packLevelId } }))) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Pack level is outside this workspace.',
        });
      }
      try {
        // The lot and its opening RECEIPT are one fact: a committed lot with no
        // receipt is unreceived stock the ledger would then refuse to move.
        return await ctx.db.$transaction(async (tx) =>
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
      const scope = await scopeFor(ctx, input.branchId);
      try {
        // One transaction: the FOR UPDATE locks the allocator takes over the
        // candidate balances are what stop two counters overselling the same
        // last unit, and they only hold until this transaction ends (INV-02).
        return await ctx.db.$transaction(async (tx) =>
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
        return await breakPack(ctx.db, await scopeFor(ctx, input.branchId), {
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
        return await ctx.db.$transaction(async (tx) =>
          transferStock(txDb(tx), await scopeFor(ctx, input.branchId), {
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
        return await ctx.db.$transaction(async (tx) =>
          createCount(txDb(tx), await scopeFor(ctx, input.branchId), input)
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
        return await ctx.db.$transaction(async (tx) =>
          approveCount(
            txDb(tx),
            await scopeFor(ctx, input.branchId),
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
        return await ctx.db.$transaction(async (tx) =>
          writeOff(txDb(tx), await scopeFor(ctx, input.branchId), input)
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
        return await ctx.db.$transaction(async (tx) =>
          quarantinePart(txDb(tx), await scopeFor(ctx, input.branchId), input)
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
        return await allocateTransfer(ctx.db, await scopeFor(ctx, input.branchId), input);
      } catch (error) {
        domainError(error);
      }
    }),

  approveTransfer: protectedProcedure
    .input(z.object({ branchId, transferId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await approveTransfer(ctx.db, await scopeFor(ctx, input.branchId), input.transferId);
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
        return await ctx.db.$transaction(async (tx) =>
          dispatchTransfer(
            txDb(tx),
            await scopeFor(ctx, input.branchId),
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
        return await ctx.db.$transaction(async (tx) =>
          receiveTransferLine(txDb(tx), await scopeFor(ctx, input.branchId), input)
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
        return await ctx.db.$transaction(async (tx) =>
          createRecall(txDb(tx), actorFor(ctx), input)
        );
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

  acknowledgeRecall: regulatory
    .input(z.object({ branchId, recallNoticeId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await acknowledgeRecall(
          ctx.db,
          await scopeFor(ctx, input.branchId),
          input.recallNoticeId
        );
      } catch (error) {
        domainError(error);
      }
    }),

  closeRecall: regulatory
    .input(z.object({ recallNoticeId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
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
        return await reserveSupplierClaim(ctx.db, await scopeFor(ctx, input.branchId), input);
      } catch (error) {
        domainError(error);
      }
    }),

  nearExpiryBoard: auditedProtectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) =>
      nearExpiryBoard(ctx.db, await scopeFor(ctx, input.branchId), new Date())
    ),

  onHand: auditedProtectedProcedure
    .input(z.object({ branchId, medicineId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await scopeFor(ctx, input.branchId);
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
      const scope = await scopeFor(ctx, input.branchId);
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
      const scope = await scopeFor(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) =>
          refreshStockSignals(txDb(tx), scope, new Date())
        );
      } catch (error) {
        domainError(error);
      }
    }),

  markStaleSignals: auditedProtectedProcedure
    .input(z.object({ branchId }).strict())
    .mutation(async ({ ctx, input }) =>
      markStaleSignals(ctx.db, await scopeFor(ctx, input.branchId), new Date())
    ),

  acknowledgeSignal: auditedProtectedProcedure
    .input(z.object({ branchId, signalId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await acknowledgeSignal(ctx.db, await scopeFor(ctx, input.branchId), {
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
        return await snoozeSignal(ctx.db, await scopeFor(ctx, input.branchId), {
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
        return await dismissSignal(ctx.db, await scopeFor(ctx, input.branchId), {
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
            idempotencyKey: z.string().trim().min(1).max(200).optional(),
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
            idempotencyKey: z.string().trim().min(1).max(200).optional(),
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
            idempotencyKey: z.string().trim().min(1).max(200).optional(),
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
      const scope = await scopeFor(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) => createDraftAction(txDb(tx), scope, input));
      } catch (error) {
        if (error instanceof PharmacyDraftIntentError) {
          throw new TRPCError({ code: error.code, message: error.message });
        }
        domainError(error);
      }
    }),

  /** PUR-07 role dashboards: live signals per kind and accountable owner. */
  stockSignalDashboard: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await scopeFor(ctx, input.branchId);
      return roleDashboard(
        ctx.db,
        { organizationId: scope.organizationId, branchId: scope.branchId },
        new Date()
      );
    }),

  /** PUR-07 owner digest payload. */
  stockSignalDigest: protectedProcedure
    .input(z.object({ branchId, ownerUserId: z.string().trim().min(1).max(200) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await scopeFor(ctx, input.branchId);
      return ownerDigest(
        ctx.db,
        { organizationId: scope.organizationId, branchId: scope.branchId },
        input.ownerUserId,
        new Date()
      );
    }),

  // ── PH-A5 — expiry board actions ──────────────────────────────────────────

  /**
   * Every saleable lot position expiring inside the window — and every one that
   * has already expired but is still AVAILABLE on a shelf, which is the stock
   * most in need of an action — with the drafts already raised against it.
   */
  expiryBoardLots: auditedProtectedProcedure
    .input(
      z
        .object({
          branchId,
          withinDays: z
            .union([z.literal(30), z.literal(60), z.literal(90), z.literal(180)])
            .default(90),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const scope = await scopeFor(ctx, input.branchId);
      await assertBranch(ctx.db, scope);
      const at = new Date();
      const { withinDays } = input;
      const horizon = new Date(at.getTime() + withinDays * DAY_MS);
      const tenant = { organizationId: scope.organizationId, branchId: scope.branchId };

      const [balances, suppliers] = await Promise.all([
        ctx.db.pharmacyStockBalance.findMany({
          where: {
            ...tenant,
            disposition: 'AVAILABLE',
            onHandUnits: { gt: 0 },
            lot: { batch: { expiresAt: { lte: horizon } } },
          },
          select: {
            inventoryLotId: true,
            stockLocationId: true,
            onHandUnits: true,
            location: { select: { name: true } },
            lot: {
              select: {
                supplierName: true,
                unitsPerPack: true,
                unitCostMinor: true,
                printedMrpMinor: true,
                batch: {
                  select: {
                    batchNumber: true,
                    expiresAt: true,
                    state: true,
                    medicine: { select: { productName: true, brandName: true } },
                  },
                },
                receiptLines: {
                  where: { goodsReceipt: { status: 'POSTED' } },
                  select: { goodsReceipt: { select: { supplierId: true } } },
                  take: 1,
                },
              },
            },
          },
        }),
        ctx.db.pharmacySupplier.findMany({
          where: { organizationId: scope.organizationId, active: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
      ]);
      const lotIds = [...new Set(balances.map((row) => row.inventoryLotId))];
      const [held, claims, returnLines, markdownEvents] = lotIds.length
        ? await Promise.all([
            ctx.db.pharmacyStockBalance.findMany({
              where: {
                ...tenant,
                inventoryLotId: { in: lotIds },
                disposition: 'QUARANTINE',
                onHandUnits: { gt: 0 },
              },
              select: { inventoryLotId: true, onHandUnits: true },
            }),
            ctx.db.pharmacySupplierClaim.findMany({
              where: { ...tenant, inventoryLotId: { in: lotIds }, status: 'RESERVED' },
              select: { inventoryLotId: true, reservedUnits: true },
            }),
            ctx.db.pharmacyPurchaseReturnLine.findMany({
              where: {
                ...tenant,
                inventoryLotId: { in: lotIds },
                purchaseReturn: { status: { in: ['DRAFT', 'SUBMITTED'] } },
              },
              orderBy: { createdAt: 'desc' },
              select: {
                inventoryLotId: true,
                purchaseReturn: { select: { id: true, reference: true, status: true } },
              },
            }),
            ctx.db.pharmacyStockSignalEvent.findMany({
              where: {
                ...tenant,
                kind: 'DRAFT_ACTION',
                detail: { startsWith: MARKDOWN_DRAFT_PREFIX },
                signal: { kind: 'NEAR_EXPIRY' },
              },
              orderBy: { createdAt: 'desc' },
              take: 500,
              select: { id: true, reason: true, detail: true, createdAt: true },
            }),
          ])
        : [[], [], [], []];

      const sum = (rows: Array<{ inventoryLotId: string; units: number }>) => {
        const totals = new Map<string, number>();
        for (const row of rows)
          totals.set(row.inventoryLotId, (totals.get(row.inventoryLotId) ?? 0) + row.units);
        return totals;
      };
      const heldByLot = sum(held.map((row) => ({ ...row, units: row.onHandUnits })));
      const reservedByLot = sum(claims.map((row) => ({ ...row, units: row.reservedUnits })));
      const returnByLot = new Map<string, (typeof returnLines)[number]['purchaseReturn']>();
      for (const line of returnLines)
        if (!returnByLot.has(line.inventoryLotId))
          returnByLot.set(line.inventoryLotId, line.purchaseReturn);
      const markdownByPosition = new Map<
        string,
        ExpiryMarkdownDraft & { eventId: string; reason: string | null; recordedAt: Date }
      >();
      for (const event of markdownEvents) {
        const draft = parseMarkdownDraft(event.detail);
        const key = draft ? `${draft.inventoryLotId}:${draft.stockLocationId}` : null;
        if (draft && key && !markdownByPosition.has(key))
          markdownByPosition.set(key, {
            ...draft,
            eventId: event.id,
            reason: event.reason,
            recordedAt: event.createdAt,
          });
      }
      const supplierIds = new Set(suppliers.map((supplier) => supplier.id));
      const supplierByName = new Map(
        suppliers.map((supplier) => [supplier.name.trim().toLowerCase(), supplier.id])
      );

      const rows = balances
        .map((row) => {
          const { lot } = row;
          const expiresAt = lot.batch.expiresAt;
          const receiptSupplier = lot.receiptLines[0]?.goodsReceipt.supplierId ?? null;
          return {
            key: `${row.inventoryLotId}:${row.stockLocationId}`,
            inventoryLotId: row.inventoryLotId,
            stockLocationId: row.stockLocationId,
            locationName: row.location.name,
            medicineName: lot.batch.medicine.brandName ?? lot.batch.medicine.productName,
            batchNumber: lot.batch.batchNumber,
            batchState: lot.batch.state,
            expiresAt,
            daysLeft: Math.ceil((expiresAt.getTime() - at.getTime()) / DAY_MS),
            expired: expiresAt.getTime() <= at.getTime(),
            onHandUnits: row.onHandUnits,
            reservedUnits: reservedByLot.get(row.inventoryLotId) ?? 0,
            quarantinedUnits: heldByLot.get(row.inventoryLotId) ?? 0,
            unitsPerPack: lot.unitsPerPack,
            unitCostMinor: lot.unitCostMinor,
            printedMrpMinor: lot.printedMrpMinor,
            valueAtRiskMinor: row.onHandUnits * lot.unitCostMinor,
            supplierName: lot.supplierName,
            suggestedSupplierId:
              receiptSupplier && supplierIds.has(receiptSupplier)
                ? receiptSupplier
                : (supplierByName.get(lot.supplierName.trim().toLowerCase()) ?? null),
            markdown:
              markdownByPosition.get(`${row.inventoryLotId}:${row.stockLocationId}`) ?? null,
            returnDraft: returnByLot.get(row.inventoryLotId) ?? null,
          };
        })
        .sort(
          (left, right) =>
            left.expiresAt.getTime() - right.expiresAt.getTime() ||
            right.valueAtRiskMinor - left.valueAtRiskMinor ||
            left.key.localeCompare(right.key)
        );
      return { generatedAt: at, withinDays, rows, suppliers };
    }),

  /**
   * A mark-down DRAFT: the proposed pack price, recorded against the lot's
   * NEAR_EXPIRY signal. It changes no price — the counter keeps selling at the
   * printed MRP until a person applies the mark-down through pricing.
   */
  draftExpiryMarkdown: auditedProtectedProcedure
    .input(
      z
        .object({
          ...expiryPosition,
          markdownPercent: z.number().int().min(1).max(90),
          reason: z.string().trim().min(1).max(500),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await scopeFor(ctx, input.branchId);
      const at = new Date();
      try {
        return await ctx.db.$transaction(async (transaction) => {
          const tx = txDb(transaction);
          await assertBranch(tx, scope);
          const lot = await lockExpiringLot(tx, scope, input.inventoryLotId);
          if (lot.batch.expiresAt.getTime() <= at.getTime()) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Expired stock cannot be marked down for sale. Quarantine it instead.',
            });
          }
          if (lot.batch.state !== 'ACTIVE') throw new PharmacyInventoryError('BLOCKED_STOCK');
          assertOnBoard(lot.batch.expiresAt, at);
          const onHandUnits = await availableAt(
            tx,
            scope,
            input.inventoryLotId,
            input.stockLocationId
          );
          if (onHandUnits <= 0) throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
          const proposedPackPriceMinor = markdownPackPrice(
            lot.printedMrpMinor,
            input.markdownPercent
          );
          if (proposedPackPriceMinor <= 0 || proposedPackPriceMinor >= lot.printedMrpMinor) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'A mark-down must price the pack above zero and below its printed MRP.',
            });
          }

          const findSignal = () =>
            tx.pharmacyStockSignal.findFirst({
              where: {
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                kind: 'NEAR_EXPIRY',
                medicineId: lot.batch.medicineId,
                stockLocationId: input.stockLocationId,
                status: { in: [...LIVE_SIGNAL_STATUSES] },
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            });
          let signal = await findSignal();
          if (!signal) {
            // The evaluator raises NEAR_EXPIRY from the same ledger facts; a
            // lot on this board without one only means nobody refreshed yet.
            await refreshStockSignals(tx, scope, at);
            signal = await findSignal();
          }
          if (!signal) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message:
                'No near-expiry signal covers this lot yet — it is outside the near-expiry policy window.',
            });
          }

          const draft: ExpiryMarkdownDraft = {
            inventoryLotId: input.inventoryLotId,
            stockLocationId: input.stockLocationId,
            batchNumber: lot.batch.batchNumber,
            markdownPercent: input.markdownPercent,
            printedMrpMinor: lot.printedMrpMinor,
            proposedPackPriceMinor,
            unitsPerPack: lot.unitsPerPack,
            unitCostMinor: lot.unitCostMinor,
            onHandUnits,
            expiresAt: lot.batch.expiresAt.toISOString(),
          };
          const earlier = await tx.pharmacyStockSignalEvent.findMany({
            where: {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              signalId: signal.id,
              kind: 'DRAFT_ACTION',
              detail: { startsWith: MARKDOWN_DRAFT_PREFIX },
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: { id: true, detail: true },
          });
          // The latest draft for this exact position wins; re-submitting the
          // same mark-down replays it rather than stacking a duplicate.
          const latest = earlier
            .map((event) => ({ id: event.id, draft: parseMarkdownDraft(event.detail) }))
            .find(
              (event) =>
                event.draft?.inventoryLotId === input.inventoryLotId &&
                event.draft.stockLocationId === input.stockLocationId
            );
          if (
            latest?.draft &&
            latest.draft.markdownPercent === input.markdownPercent &&
            latest.draft.proposedPackPriceMinor === proposedPackPriceMinor
          ) {
            return { created: false, signalId: signal.id, eventId: latest.id, draft: latest.draft };
          }
          const event = await tx.pharmacyStockSignalEvent.create({
            data: {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              signalId: signal.id,
              kind: 'DRAFT_ACTION',
              actorId: scope.actorId,
              reason: input.reason,
              detail: `${MARKDOWN_DRAFT_PREFIX}${JSON.stringify(draft)}`,
            },
            select: { id: true },
          });
          return { created: true, signalId: signal.id, eventId: event.id, draft };
        });
      } catch (error) {
        expiryError(error);
      }
    }),

  /**
   * A supplier return DRAFT (EXPIRY_CLAIM) for one near-expiry lot position. It
   * reserves nothing; submitting it in Purchasing → Returns is what holds stock.
   */
  draftExpiryReturn: auditedProtectedProcedure
    .input(
      z
        .object({
          ...expiryPosition,
          supplierId: z.string().min(1).max(128),
          units: z.number().int().positive(),
          reason: z.string().trim().min(1).max(500),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await scopeFor(ctx, input.branchId);
      const at = new Date();
      try {
        return await ctx.db.$transaction(async (transaction) => {
          const tx = txDb(transaction);
          await assertBranch(tx, scope);
          const lot = await lockExpiringLot(tx, scope, input.inventoryLotId);
          assertOnBoard(lot.batch.expiresAt, at);
          const open = await tx.pharmacyPurchaseReturnLine.findFirst({
            where: {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              inventoryLotId: input.inventoryLotId,
              purchaseReturn: { status: { in: ['DRAFT', 'SUBMITTED'] } },
            },
            orderBy: { createdAt: 'desc' },
            select: { purchaseReturn: { select: { id: true, reference: true, status: true } } },
          });
          if (open) return { created: false, purchaseReturn: open.purchaseReturn };

          const supplier = await tx.pharmacySupplier.findFirst({
            where: { id: input.supplierId, organizationId: scope.organizationId, active: true },
            select: { id: true },
          });
          if (!supplier) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Supplier is outside this workspace.',
            });
          }
          const [onHandUnits, reserved] = await Promise.all([
            availableAt(tx, scope, input.inventoryLotId, input.stockLocationId),
            tx.pharmacySupplierClaim.aggregate({
              where: {
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                inventoryLotId: input.inventoryLotId,
                status: 'RESERVED',
              },
              _sum: { reservedUnits: true },
            }),
          ]);
          if (input.units > onHandUnits - (reserved._sum.reservedUnits ?? 0)) {
            throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
          }
          const stamp = at.toISOString().slice(0, 10).replaceAll('-', '');
          const created = await createPurchaseReturn(tx, scope, {
            supplierId: supplier.id,
            kind: 'EXPIRY_CLAIM',
            reference: `EXP-${stamp}-${lot.batch.batchNumber.slice(0, 24)}-${at.getTime().toString(36).toUpperCase()}`,
            note: 'Drafted from the near-expiry board. A draft reserves nothing; submit it to hold the stock for the supplier.',
            lines: [
              {
                inventoryLotId: input.inventoryLotId,
                stockLocationId: input.stockLocationId,
                quantityUnits: input.units,
                reason: input.reason,
                returnWindowEndsAt: lot.batch.expiresAt,
                expectedCreditMinor: input.units * lot.unitCostMinor,
              },
            ],
          });
          return {
            created: true,
            purchaseReturn: {
              id: created.id,
              reference: created.reference,
              status: created.status,
            },
          };
        });
      } catch (error) {
        expiryError(error);
      }
    }),

  /**
   * Quarantine near-expiry or expired units: the existing INV-08 movement pair
   * (AVAILABLE out, QUARANTINE in). `requestKey` is minted when the board is
   * rendered, so a double-submitted form replays instead of moving stock twice.
   */
  quarantineExpiring: auditedProtectedProcedure
    .input(
      z
        .object({
          ...expiryPosition,
          units: z.number().int().positive(),
          reason: z.string().trim().min(1).max(500),
          requestKey: z.string().trim().min(8).max(100),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await scopeFor(ctx, input.branchId);
      const at = new Date();
      const idempotencyKeyPrefix = `expiry-quarantine:${input.requestKey}`;
      try {
        return await ctx.db.$transaction(async (transaction) => {
          const tx = txDb(transaction);
          await assertBranch(tx, scope);
          const lot = await lockExpiringLot(tx, scope, input.inventoryLotId);
          const replay = await tx.pharmacyStockMovement.findFirst({
            where: {
              organizationId: scope.organizationId,
              idempotencyKey: `${idempotencyKeyPrefix}:in`,
            },
          });
          if (replay) {
            if (
              replay.inventoryLotId !== input.inventoryLotId ||
              replay.stockLocationId !== input.stockLocationId ||
              replay.quantityUnits !== input.units
            ) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'This request key was already used for a different quarantine.',
              });
            }
            return { replayed: true, held: replay };
          }
          assertOnBoard(lot.batch.expiresAt, at);
          const moved = await quarantinePart(tx, scope, {
            inventoryLotId: input.inventoryLotId,
            stockLocationId: input.stockLocationId,
            units: input.units,
            reason: input.reason,
            idempotencyKeyPrefix,
          });
          return { replayed: false, held: moved.held };
        });
      } catch (error) {
        expiryError(error);
      }
    }),
  /** WHA-1603 INV-07 console: both directions for one branch, slip-ready. */
  transferBoard: auditedProtectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => transferBoard(ctx.db, await scopeFor(ctx, input.branchId))),

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
        return await ctx.db.$transaction(async (tx) =>
          receiveTransferWithVariance(txDb(tx), await scopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        domainError(error);
      }
    }),
});
