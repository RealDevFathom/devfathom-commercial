/**
 * PH-INV / INV-01..04 — the minimal procedures behind the `pharmacy-inventory`
 * entitlement (module-catalog).
 *
 * Nothing here re-decides an invariant. Branch scope and the hard blocks live in
 * `@/lib/pharmacy/stock-ledger` and its migration triggers; this layer parses
 * input, pins the tenant/branch/actor scope to the SESSION rather than the
 * payload, and maps the domain error onto a tRPC code.
 */
import { randomUUID } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import { arrangementFor, PharmacyInventoryError } from '@/lib/pharmacy/inventory';
import {
  confirmPriceChange,
  confirmDrapRecall,
  dismissDrapRecall,
  drapRecallReviewQueue,
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
  CYCLE_COUNT_DEFAULT_SIZE,
  CYCLE_COUNT_MAX_SIZE,
  CYCLE_COUNT_REASON_MAX,
  dailyCycleCountList,
  createRecall,
  dispatchTransfer,
  nearExpiryBoard,
  OpenRecallConflictError,
  quarantinePart,
  releaseQuarantinedPart,
  recallTrace,
  receiveTransferLine,
  reserveSupplierClaim,
  setManufacturingBatchState,
  writeOff,
} from '@/lib/pharmacy/inventory-operations';
import {
  postInterbranchTransferLossEntry,
  postWriteOffEntry,
} from '@/lib/pharmacy/finance-postings';
import {
  allocateForSale,
  breakPack,
  expiryInstant,
  onHand,
  receiveLot,
  transferStock,
} from '@/lib/pharmacy/stock-ledger';
import type { LedgerScope } from '@/lib/pharmacy/stock-ledger';
import { lockStockBalances, lockStockRowsFrom } from '@/lib/pharmacy/stock-lock-order';
import { PharmacyStockSignalError } from '@/lib/pharmacy/stock-signals';
import { PharmacyCounterError } from '@/lib/pharmacy/counter';
import { readShelfLabelSheet, ShelfLabelSourceError } from '@/lib/pharmacy/shelf-label-source';
import { PharmacySupplierReturnError } from '@/lib/pharmacy/supplier-returns';
import {
  expiryRiskBuckets,
  maySuggestExpiryMarkdown,
  supplierReturnDates,
} from '@/lib/pharmacy/expiry-growth';
import { EXPIRY_CLAIM_MAX_POSITIONS } from '@/lib/pharmacy/expiry-claim';
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
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  SOLO_OWNER_POLICY,
  soloOwnerApprovalAllowed,
  verifyPurchaseApprover,
} from '@/lib/pharmacy/purchase-approval';
import {
  authorizeWriteOffWitness,
  recordWriteOffWitnessEvidence,
} from '@/lib/pharmacy/write-off-witness';
import {
  authorizeCounterApproval,
  confirmCounterApproval,
  CounterApprovalDenied,
  fefoOverrideApprovalPolicy,
} from '@/lib/pharmacy/counter-line-approval';
import {
  CsvTemperatureReadingSource,
  ingestTemperatureReadings,
  loadTemperatureZoneStatuses,
  ManualTemperatureReadingSource,
} from '@/lib/pharmacy/temperature-log';
import {
  enrollColdChainSensor,
  listColdChainSensors,
  PharmacyColdChainSensorError,
  revokeColdChainSensor,
  rotateColdChainSensorSecret,
} from '@/lib/pharmacy/cold-chain-sensors';

import { can, subjectFromSession } from '@/lib/abac';
import { maskPhone } from '@/lib/pharmacy/patient-prescriptions';
import { afterTenantTransaction } from '@/lib/side-effects/scope';

import { auditedProtectedProcedure, capabilityProcedure, router } from '../trpc';
import { assertInOrganization } from '../org-refs';
import type { TRPCContext } from '../trpc';

const branchId = z.string().trim().min(1).max(128);
const expiryPrecision = z.enum(['DAY', 'MONTH']);
const regulatory = capabilityProcedure('pharmacy:safety');
// Storage zones and their cold-chain readings belong to whoever runs the stock
// (the Inventory role, or `pharmacy:*`). Checked through `can()` before any read.
const inventoryControl = capabilityProcedure('pharmacy:inventory');
const SOLO_COUNT_APPROVAL_REFUSED =
  'Only the pharmacy owner who works alone can approve their own count, with their current PIN.';
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
  if (error instanceof CounterApprovalDenied)
    throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
  if (error instanceof PharmacyInventoryError) {
    const code =
      error.reason === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.reason === 'IDEMPOTENCY_CONFLICT'
          ? 'CONFLICT'
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
  if (error instanceof PharmacyColdChainSensorError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.reason === 'DUPLICATE_DEVICE_IDENTIFIER' || error.reason === 'REVOKED'
            ? 'CONFLICT'
            : 'BAD_REQUEST',
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

/**
 * DEV-211 / DEV-660: an active assignment of the session actor on an active
 * branch of the session tenant — the ordinary way into a branch's stock.
 */
function activeAssignmentOf(organizationId: string, userId: string) {
  return {
    organizationId,
    userId,
    active: true,
    branch: { organizationId, active: true },
  };
}

/**
 * DEV-660 (Saad: "ADMIN = Owner", for inventory branch access only): an ADMIN of
 * the session tenant reaches every active branch of that tenant without an
 * individual assignment. The session's role is only a pre-filter; the user
 * record decides, and it must belong to this tenant, be ADMIN and be ACTIVE. An
 * Owner role template, a `*` grant or any other label does not qualify, and a
 * demoted, deactivated or other-tenant user is refused. This grants branch scope
 * only — capability checks (and an explicit DENY) still run first.
 */
async function isActiveTenantAdmin(
  ctx: TRPCContext,
  organizationId: string,
  userId: string
): Promise<boolean> {
  if (ctx.session?.user?.role !== 'ADMIN') return false;
  const admin = await ctx.db.user.findFirst({
    where: { id: userId, organizationId, role: 'ADMIN', status: 'ACTIVE' },
    select: { id: true },
  });
  return admin !== null;
}

/**
 * The exception is an inventory privilege, so it also needs the canonical
 * `pharmacy:inventory` capability through `can()` (deny-wins). An explicit DENY
 * — on the user or the role, `pharmacy:*` or `*` included — or no inventory
 * grant at all leaves an ADMIN with only the branches they are assigned to,
 * including on the reads that carry no capability of their own.
 */
async function tenantAdminException(
  ctx: TRPCContext,
  organizationId: string,
  userId: string
): Promise<boolean> {
  if (!(await isActiveTenantAdmin(ctx, organizationId, userId))) return false;
  return can(subjectFromSession(ctx.session!.user), 'pharmacy:inventory', undefined, {
    db: ctx.db,
    source: 'TRPC',
    ip: ctx.requestMeta?.ip ?? null,
  });
}

export const ADMIN_BRANCH_EXCEPTION_ACTION = 'pharmacy.inventory.admin_branch_exception';

/**
 * One audit row per use of the ADMIN exception, written before any stock is read
 * or moved, so it never rides on the request's shared audit detail (a batched
 * request shares one).
 *
 * The insert is awaited on the request's own client: if it fails, the request
 * fails closed. On /api/trpc that client is the request transaction, which rolls
 * back when any call in the batch fails, so the same row (same id) is written
 * again after the transaction ends, idempotently, on its own connection. A
 * committed request makes that second write a no-op; an aborted one keeps the
 * row it would otherwise lose.
 */
async function recordAdminBranchException(
  ctx: TRPCContext,
  scope: LedgerScope,
  branch: string
): Promise<void> {
  const user = ctx.session!.user as {
    name?: string | null;
    email?: string | null;
    role?: string | null;
    isSupportSession?: boolean;
    supportSessionId?: string;
    platformUserId?: string;
  };
  // The same flag recordAudit puts on every tenant row while the placeholder
  // regulatory rule set is active.
  const placeholder = ctx.db.branchRegulatoryProfile
    ? await ctx.db.branchRegulatoryProfile.findFirst({
        where: { organizationId: scope.organizationId, isPlaceholder: true, effectiveTo: null },
        select: { id: true },
      })
    : null;
  const data = {
    id: randomUUID(),
    // Stamped at the access, so a row restored after a rollback keeps its real time.
    createdAt: new Date(),
    organizationId: scope.organizationId,
    actorType: 'USER' as const,
    actorId: scope.actorId,
    actorName: user.name ?? null,
    actorEmail: user.email ?? null,
    actorRole: user.role ?? null,
    source: 'TRPC' as const,
    category: 'PHARMACY',
    operation: 'OTHER' as const,
    action: ADMIN_BRANCH_EXCEPTION_ACTION,
    description: 'Tenant ADMIN reached an inventory branch without a branch assignment',
    targetType: 'PharmacyBranch',
    targetId: branch,
    metadata: {
      branchId: branch,
      reason: 'tenant-admin-inventory-access-without-branch-assignment',
      ...(user.isSupportSession
        ? {
            supportSessionId: user.supportSessionId,
            platformUserId: user.platformUserId,
            actingAsTenantUserId: scope.actorId,
          }
        : {}),
      ...(placeholder ? { placeholder: true } : {}),
    },
    ip: ctx.requestMeta?.ip ?? null,
    userAgent: ctx.requestMeta?.userAgent ?? null,
    outcome: 'SUCCESS' as const,
  };
  await ctx.db.auditLog.create({ data });
  afterTenantTransaction(() => {
    void withTenantDb(
      scope.organizationId,
      (tx) => tx.auditLog.createMany({ data: [data], skipDuplicates: true }),
      { maxWait: 1_000, timeout: 5_000, skipDrain: true }
    ).catch((error: unknown) => {
      console.error(
        '[audit] failed to re-record',
        ADMIN_BRANCH_EXCEPTION_ACTION,
        error instanceof Error ? error.name : 'error'
      );
    });
  });
}

/**
 * DEV-211 / DEV-660: besides being an active branch of the session tenant, the
 * requested branch must carry an active assignment for the session actor, or the
 * actor must be a verified active ADMIN of the tenant who holds the canonical
 * `pharmacy:inventory` capability — that exception writes its own audit row
 * first. It guards the stock-creating and
 * stock-removing mutations (createLocation, receiveLot, createCount, writeOff),
 * the branch stock reads, allocateForSale and every transfer step.
 *
 * DEV-505: it also guards every other branch-scoped `pharmacy:inventory`
 * procedure (counts, pack breaks, quarantine release, temperature logs, stock
 * signals, safety stock, supplier claims and the expiry markdown, return and
 * quarantine drafts), so a Manager holding `pharmacy:inventory` is refused every
 * branch they are not assigned to. Only the `pharmacy:safety` procedures
 * (quarantinePart, acknowledgeRecall) keep the tenant-only scopeFor.
 */
async function admittedScopeFor(ctx: TRPCContext, branch: string): Promise<LedgerScope> {
  const scope = await scopeFor(ctx, branch);
  const assignment = await ctx.db.pharmacyBranchAssignment.findFirst({
    where: { ...activeAssignmentOf(scope.organizationId, scope.actorId), branchId: branch },
    select: { id: true },
  });
  if (assignment) return scope;
  if (await tenantAdminException(ctx, scope.organizationId, scope.actorId)) {
    await recordAdminBranchException(ctx, scope, branch);
    return scope;
  }
  throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
}

/**
 * The active branches of the session tenant the session actor is admitted to —
 * the same rule as admittedScopeFor, as a set: every active branch for a
 * verified active tenant ADMIN holding `pharmacy:inventory`, otherwise the
 * assigned ones. The inventory pages
 * offer only these, so the default branch and a `?branch=` value are both ones
 * the gated reads admit.
 */
export async function admittedInventoryBranchIds(ctx: TRPCContext): Promise<Set<string>> {
  const { organizationId, actorId } = actorFor(ctx);
  if (await tenantAdminException(ctx, organizationId, actorId)) {
    const branches = await ctx.db.pharmacyBranch.findMany({
      where: { organizationId, active: true },
      select: { id: true },
    });
    return new Set(branches.map((branch) => branch.id));
  }
  const rows = await ctx.db.pharmacyBranchAssignment.findMany({
    where: activeAssignmentOf(organizationId, actorId),
    select: { branchId: true },
  });
  return new Set(rows.map((row) => row.branchId));
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

/** A mark-down draft as any response carries it: never with the landed unit cost. */
export type PublicExpiryMarkdownDraft = Omit<ExpiryMarkdownDraft, 'unitCostMinor'>;

/**
 * DEV-627: the stored draft keeps `unitCostMinor` as evidence, but it is a
 * purchase-cost fact, so it is dropped before a draft leaves the server.
 */
export function publicMarkdownDraft(draft: ExpiryMarkdownDraft): PublicExpiryMarkdownDraft {
  const copy: Partial<ExpiryMarkdownDraft> = { ...draft };
  delete copy.unitCostMinor;
  return copy as PublicExpiryMarkdownDraft;
}

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
 * FOR NO KEY UPDATE (DEV-825, stock-lock-order.ts): a sale that already holds a
 * balance of this lot takes FOR KEY SHARE on it when it inserts its movement,
 * and a FOR UPDATE here would make that wait the inverse of this path's order.
 */
async function lockExpiringLot(db: ScopedDb, scope: LedgerScope, inventoryLotId: string) {
  await lockStockRowsFrom(
    db,
    scope.organizationId,
    Prisma.sql`SELECT "id" AS "inventoryLotId" FROM "pharmacy_inventory_lots" WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND "id"=${inventoryLotId}`,
    { lot: 'update' }
  );
  const lot = await db.pharmacyInventoryLot.findFirst({
    where: { id: inventoryLotId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: {
      batch: {
        select: {
          batchNumber: true,
          expiresAt: true,
          state: true,
          medicineId: true,
          medicine: {
            select: {
              rx: true,
              otc: true,
              restricted: true,
              controlled: true,
              productFamily: true,
            },
          },
        },
      },
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

/** Supplier names match the way the expiry board groups them: trimmed, case-insensitive. */
const sameSupplierName = (left: string, right: string) =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

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
  variance?: { reason: string; witnessId: string; witnessPin: string; evidenceRef: string };
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

  // DEV-628: a shortfall is a stock loss, so it takes the same two-person
  // control as a write-off: a witness assigned to this branch, confirming with
  // their own PIN (or a solo owner/pharmacist's own fresh PIN). DEV-825: the
  // shortfall is known from the answers alone, so the witness credential (a
  // document-class lock) is taken before any stock row (stock-lock-order.ts).
  const short = open.some((line) => line.quantityUnits - line.receivedUnits > answered.get(line.id)!);
  let witness: Awaited<ReturnType<typeof authorizeWriteOffWitness>> | null = null;
  if (short) {
    if (!input.variance) throw new PharmacyInventoryError('COAUTH_REQUIRED');
    witness = await authorizeWriteOffWitness(db, scope, input.variance);
  }

  // DEV-825: lock every IN_TRANSIT balance this receipt writes, in the global
  // key order (stock-lock-order.ts), before reading or writing any line.
  await lockStockBalances(
    db,
    { organizationId: scope.organizationId, branchId: transfer.fromBranchId },
    open.map((line) => ({
      inventoryLotId: line.sourceLotId,
      stockLocationId: line.sourceStockLocationId,
      disposition: 'IN_TRANSIT',
    }))
  );
  const plan = [];
  for (const line of open) {
    const receivedUnits = answered.get(line.id)!;
    const outstanding = line.quantityUnits - line.receivedUnits;
    const balances = await db.$queryRaw<
      Array<{ onHandUnits: number; sealedPacks: number; looseUnits: number; unitsPerPack: number }>
    >(
      Prisma.sql`SELECT b."onHandUnits",b."sealedPacks",b."looseUnits",l."unitsPerPack" FROM "pharmacy_stock_balances" b JOIN "pharmacy_inventory_lots" l ON l.id=b."inventoryLotId" WHERE b."organizationId"=${scope.organizationId} AND b."branchId"=${transfer.fromBranchId} AND b."inventoryLotId"=${line.sourceLotId} AND b."stockLocationId"=${line.sourceStockLocationId} AND b."disposition"='IN_TRANSIT'`
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
    // FIN-01: the missing units' value leaves transit as a loss in the same
    // transaction, or a short-closed transfer keeps a phantom transit asset.
    await postInterbranchTransferLossEntry(db, scope, {
      transferLineId: step.line.id,
      stockMovementId: movement.id,
      at: movement.occurredAt,
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
    await recordWriteOffWitnessEvidence(db, scope, witness!, movement.id);
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

  /** DEV-692: parsed DRAP recall alerts waiting for a person, plus recent decisions. */
  drapRecallQueue: regulatory.query(async ({ ctx }) =>
    drapRecallReviewQueue(ctx.db, actorFor(ctx))
  ),

  /** DEV-692: the only path from a recall draft to a recall notice and quarantine. */
  confirmDrapRecall: regulatory
    .input(
      z
        .object({ ingestId: z.string().min(1), note: z.string().trim().max(500).optional() })
        .strict()
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db
        .$transaction(async (tx) =>
          confirmDrapRecall(txDb(tx), actorFor(ctx), input.ingestId, input.note)
        )
        .catch(domainError)
    ),

  dismissDrapRecall: regulatory
    .input(
      z.object({ ingestId: z.string().min(1), reason: z.string().trim().min(1).max(500) }).strict()
    )
    .mutation(async ({ ctx, input }) =>
      ctx.db
        .$transaction(async (tx) =>
          dismissDrapRecall(txDb(tx), actorFor(ctx), input.ingestId, input.reason)
        )
        .catch(domainError)
    ),

  // DEV-832: recall contact tracing is regulatory work. Phones are masked unless
  // the caller also holds the patient-record grant (`pharmacy:prescriptions`).
  drapRecallActions: regulatory
    .input(z.object({ recallNoticeId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const rows = await recallActionList(ctx.db, actorFor(ctx), input.recallNoticeId);
      const patientRecords = await can(
        subjectFromSession(ctx.session!.user),
        'pharmacy:prescriptions',
        undefined,
        { db: ctx.db, source: 'TRPC', ip: ctx.requestMeta.ip }
      );
      return patientRecords
        ? rows
        : rows.map((row) => ({ ...row, patientPhone: maskPhone(row.patientPhone) }));
    }),

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

  createLocation: inventoryControl
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
      const scope = await admittedScopeFor(ctx, input.branchId);
      return ctx.db.pharmacyStockLocation.create({
        data: { ...input, organizationId: scope.organizationId },
      });
    }),

  recordTemperature: inventoryControl
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
      const scope = await admittedScopeFor(ctx, input.branchId);
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

  importTemperatureCsv: inventoryControl
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
      const scope = await admittedScopeFor(ctx, input.branchId);
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

  /**
   * DEV-82 — live cold-chain sensors. Like the storage zones and readings they
   * feed, they belong to whoever runs the stock (`pharmacy:inventory`) AND is
   * admitted to the branch, not just to a branch of the tenant. A push secret
   * is returned once and only its hash is stored; every call is audited.
   */
  coldChainSensors: inventoryControl
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) =>
      listColdChainSensors(ctx.db, await admittedScopeFor(ctx, input.branchId))
    ),

  enrollColdChainSensor: inventoryControl
    .input(
      z
        .object({
          branchId,
          stockLocationId: z.string().min(1).max(128),
          name: z.string().trim().min(1).max(120),
          deviceIdentifier: z.string().trim().min(1).max(120),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await admittedScopeFor(ctx, input.branchId);
      try {
        return await enrollColdChainSensor(ctx.db, scope, input);
      } catch (error) {
        domainError(error);
      }
    }),

  rotateColdChainSensorSecret: inventoryControl
    .input(z.object({ branchId, sensorId: z.string().min(1).max(128) }).strict())
    .mutation(async ({ ctx, input }) => {
      const scope = await admittedScopeFor(ctx, input.branchId);
      try {
        return await rotateColdChainSensorSecret(ctx.db, scope, input.sensorId);
      } catch (error) {
        domainError(error);
      }
    }),

  revokeColdChainSensor: inventoryControl
    .input(z.object({ branchId, sensorId: z.string().min(1).max(128) }).strict())
    .mutation(async ({ ctx, input }) => {
      const scope = await admittedScopeFor(ctx, input.branchId);
      try {
        return await revokeColdChainSensor(ctx.db, scope, input.sensorId, new Date());
      } catch (error) {
        domainError(error);
      }
    }),

  temperatureZoneStatuses: auditedProtectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await admittedScopeFor(ctx, input.branchId);
      return loadTemperatureZoneStatuses(ctx.db, scope, new Date());
    }),

  configureTemperatureMonitoring: inventoryControl
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
      const scope = await admittedScopeFor(ctx, input.branchId);
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

  registerBatch: inventoryControl
    .input(
      z
        .object({
          medicineId: z.string().min(1),
          batchNumber: z
            .string()
            .trim()
            .min(1)
            .max(120)
            .regex(
              /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$/u,
              'Batch number cannot contain control characters.'
            ),
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
          state: z.enum(['ACTIVE', 'RECALLED', 'QUARANTINED']),
          reason: z.string().trim().max(500).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      if (input.state !== 'ACTIVE' && !input.reason) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Blocking a batch requires a reason.',
        });
      }
      return ctx.db.$transaction(async (tx) => {
        try {
          return await setManufacturingBatchState(txDb(tx), actorFor(ctx).organizationId, input);
        } catch (error) {
          if (error instanceof OpenRecallConflictError) {
            throw new TRPCError({ code: 'CONFLICT', message: error.message });
          }
          domainError(error);
        }
      });
    }),

  receiveLot: inventoryControl
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
      const scope = await admittedScopeFor(ctx, input.branchId);
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

  allocateForSale: inventoryControl
    .input(
      z
        .object({
          branchId,
          medicineId: z.string().min(1),
          requiredUnits: z.number().int().positive(),
          idempotencyKeyPrefix: z.string().trim().min(1).max(160),
          // #520: the approver is proven by a PIN the server verifies, never named by the caller.
          override: z
            .object({
              inventoryLotId: z.string().min(1),
              reason: z.string().trim().min(1).max(500),
              approval: z
                .object({
                  staffProfileId: z.string().trim().min(1).max(128),
                  pin: z.string().regex(/^\d{4,8}$/),
                })
                .strict()
                .optional(),
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
      const scope = await admittedScopeFor(ctx, input.branchId);
      try {
        // #520: a FEFO override needs the pharmacist on duty or a pharmacist's PIN, verified
        // before the stock transaction takes a connection and re-checked inside it.
        const approval = input.override
          ? await authorizeCounterApproval(
              ctx.db as unknown as ScopedDb,
              scope,
              'FEFO_OVERRIDE',
              input.override.approval
            )
          : null;
        // One transaction: the FOR UPDATE locks the allocator takes over the
        // candidate balances are what stop two counters overselling the same
        // last unit, and they only hold until this transaction ends (INV-02).
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          if (approval) await confirmCounterApproval(db, scope, 'FEFO_OVERRIDE', approval);
          return allocateForSale(db, scope, {
            medicineId: input.medicineId,
            requiredUnits: input.requiredUnits,
            at: new Date(),
            idempotencyKeyPrefix: input.idempotencyKeyPrefix,
            override:
              input.override && approval
                ? {
                    inventoryLotId: input.override.inventoryLotId,
                    reason: input.override.reason,
                    approvalPolicy: fefoOverrideApprovalPolicy(approval, scope.actorId),
                  }
                : undefined,
            emergency: input.emergency,
          });
        });
      } catch (error) {
        domainError(error);
      }
    }),

  breakPack: inventoryControl
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
        return await breakPack(ctx.db, await admittedScopeFor(ctx, input.branchId), {
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

  transfer: inventoryControl
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
        // AVAILABLE at the origin and at the destination at once (DEV-608).
        return await ctx.db.$transaction(async (tx) =>
          transferStock(txDb(tx), await admittedScopeFor(ctx, input.branchId), {
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

  createCount: inventoryControl
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
          createCount(txDb(tx), await admittedScopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        domainError(error);
      }
    }),

  /**
   * DEV-682: today's cycle-count list — fast movers and high-value positions,
   * ranked in SQL. It is a read; nothing is saved until a person submits the
   * counted quantities (`createCount`) and confirms the variance (`approveCount`).
   */
  dailyCycleCountList: inventoryControl
    .input(
      z
        .object({
          branchId,
          size: z.number().int().min(1).max(CYCLE_COUNT_MAX_SIZE).default(CYCLE_COUNT_DEFAULT_SIZE),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      try {
        return await dailyCycleCountList(
          ctx.db,
          await admittedScopeFor(ctx, input.branchId),
          new Date(),
          input.size
        );
      } catch (error) {
        domainError(error);
      }
    }),

  approveCount: inventoryControl
    .input(
      z
        .object({
          branchId,
          countId: z.string().min(1),
          idempotencyKeyPrefix: z.string().trim().min(1).max(160),
          // DEV-682: required (server-side) whenever the count has a variance.
          varianceReason: z.string().trim().max(CYCLE_COUNT_REASON_MAX).optional(),
          // DEV-682 solo-pharmacy rule: a sole owner co-authorizes their own
          // above-threshold variance with a fresh PIN instead of a second person.
          soloPin: z
            .string()
            .regex(/^\d{4,8}$/)
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await admittedScopeFor(ctx, input.branchId);
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          if (input.soloPin === undefined)
            return approveCount(
              db,
              scope,
              input.countId,
              input.idempotencyKeyPrefix,
              input.varianceReason
            );
          if (
            !(await soloOwnerApprovalAllowed(
              db,
              scope.organizationId,
              scope.actorId,
              scope.branchId
            ))
          )
            throw new TRPCError({ code: 'FORBIDDEN', message: SOLO_COUNT_APPROVAL_REFUSED });
          const pin = await verifyPurchaseApprover(db, {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            approverId: scope.actorId,
            pin: input.soloPin,
          });
          if ('blocked' in pin)
            throw new TRPCError({ code: 'FORBIDDEN', message: SOLO_COUNT_APPROVAL_REFUSED });
          const approved = await approveCount(
            db,
            scope,
            input.countId,
            input.idempotencyKeyPrefix,
            input.varianceReason,
            { soloSelfApproval: true }
          );
          await db.auditLog.create({
            data: {
              organizationId: scope.organizationId,
              actorId: scope.actorId,
              actorType: 'USER',
              source: 'TRPC',
              category: 'PHARMACY_INVENTORY',
              operation: 'OTHER',
              action: 'pharmacy.inventoryCountSoloApproval',
              targetType: 'PharmacyInventoryCount',
              targetId: input.countId,
              metadata: {
                branchId: scope.branchId,
                approverId: scope.actorId,
                pinVerified: true,
                policy: SOLO_OWNER_POLICY,
              },
            },
          });
          return approved;
        });
      } catch (error) {
        domainError(error);
      }
    }),

  writeOff: inventoryControl
    .input(
      z
        .object({
          branchId,
          inventoryLotId: z.string().min(1),
          stockLocationId: z.string().min(1),
          units: z.number().int().positive(),
          witnessId: z.string().trim().min(1),
          // DEV-628: the witness confirms with their own PIN at the point of write-off.
          witnessPin: z.string().regex(/^\d{4,8}$/),
          reason: z.string().trim().min(1).max(500),
          evidenceRef: z.string().trim().min(1).max(500),
          idempotencyKey: z.string().trim().min(1).max(200),
          disposition: z.enum(['AVAILABLE', 'QUARANTINE', 'DAMAGED']).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          const scope = await admittedScopeFor(ctx, input.branchId);
          const { witnessPin, ...writeOffInput } = input;
          const witness = await authorizeWriteOffWitness(db, scope, {
            witnessId: input.witnessId,
            witnessPin,
          });
          const written = await writeOff(db, scope, writeOffInput, {
            soloSelfWitness: witness.soloSelfWitness,
          });
          await recordWriteOffWitnessEvidence(db, scope, witness, written.movement.id);
          await postWriteOffEntry(db, scope, {
            stockMovementId: written.movement.id,
            at: written.movement.occurredAt,
          });
          return written;
        });
      } catch (error) {
        domainError(error);
      }
    }),

  quarantinePart: regulatory
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

  releaseQuarantinedPart: inventoryControl
    .input(
      z
        .object({
          branchId,
          inventoryLotId: z.string().min(1),
          stockLocationId: z.string().min(1),
          units: z.number().int().positive(),
          reason: z.string().trim().min(1).max(500),
          idempotencyKeyPrefix: z.string().trim().min(1).max(160),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction(async (tx) =>
          releaseQuarantinedPart(txDb(tx), await admittedScopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        domainError(error);
      }
    }),

  allocateTransfer: inventoryControl
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
        return await allocateTransfer(ctx.db, await admittedScopeFor(ctx, input.branchId), input);
      } catch (error) {
        domainError(error);
      }
    }),

  approveTransfer: inventoryControl
    .input(z.object({ branchId, transferId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await approveTransfer(
          ctx.db,
          await admittedScopeFor(ctx, input.branchId),
          input.transferId
        );
      } catch (error) {
        domainError(error);
      }
    }),

  dispatchTransfer: inventoryControl
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
            await admittedScopeFor(ctx, input.branchId),
            input.transferId,
            input.idempotencyKeyPrefix
          )
        );
      } catch (error) {
        domainError(error);
      }
    }),

  receiveTransferLine: inventoryControl
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
          receiveTransferLine(txDb(tx), await admittedScopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        domainError(error);
      }
    }),

  // Raising a recall moves every matching batch to RECALLED, the same regulated
  // state change as setBatchState, so it needs the same exact pharmacy:safety grant.
  createRecall: regulatory
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
        const scope = await scopeFor(ctx, input.branchId);
        return await ctx.db.$transaction(async (tx) =>
          acknowledgeRecall(txDb(tx), scope, input.recallNoticeId)
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

  reserveSupplierClaim: inventoryControl
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
        const scope = await admittedScopeFor(ctx, input.branchId);
        return await ctx.db.$transaction(async (tx) =>
          reserveSupplierClaim(txDb(tx), scope, input)
        );
      } catch (error) {
        domainError(error);
      }
    }),

  /**
   * DEV-90: shelf and price sticker content for one branch, from a posted goods
   * receipt, a medicine list, or a search. Prices and lot codes come only from
   * here; the operator chooses how many to print.
   */
  shelfLabels: inventoryControl
    .input(
      z
        .object({
          branchId,
          source: z.discriminatedUnion('kind', [
            z
              .object({ kind: z.literal('RECEIPT'), goodsReceiptId: z.string().min(1).max(128) })
              .strict(),
            z
              .object({
                kind: z.literal('MEDICINES'),
                medicineIds: z.array(z.string().min(1).max(128)).min(1).max(100),
              })
              .strict(),
            z
              .object({ kind: z.literal('SEARCH'), query: z.string().trim().min(2).max(120) })
              .strict(),
          ]),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const scope = await admittedScopeFor(ctx, input.branchId);
      try {
        return await readShelfLabelSheet(
          ctx.db,
          { organizationId: scope.organizationId, branchId: scope.branchId },
          input.source
        );
      } catch (error) {
        if (error instanceof ShelfLabelSourceError) {
          throw new TRPCError({
            code: error.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST',
            message:
              error.reason === 'NOT_FOUND'
                ? 'Goods receipt not found in this branch.'
                : 'Only a posted goods receipt has lots to label.',
          });
        }
        if (error instanceof PharmacyCounterError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Type at least two characters.' });
        }
        throw error;
      }
    }),

  nearExpiryBoard: auditedProtectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) =>
      nearExpiryBoard(ctx.db, await admittedScopeFor(ctx, input.branchId), new Date())
    ),

  onHand: auditedProtectedProcedure
    .input(z.object({ branchId, medicineId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await admittedScopeFor(ctx, input.branchId);
      return onHand(
        ctx.db,
        { organizationId: scope.organizationId, branchId: scope.branchId },
        input.medicineId,
        new Date()
      );
    }),

  // ── PUR-07 — the deterministic stock action centre ────────────────────────

  /** The approved threshold a stock-level signal is measured against. */
  approveSafetyStock: inventoryControl
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
      const scope = await admittedScopeFor(ctx, input.branchId);
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
  refreshStockSignals: inventoryControl
    .input(z.object({ branchId }).strict())
    .mutation(async ({ ctx, input }) => {
      const scope = await admittedScopeFor(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) =>
          refreshStockSignals(txDb(tx), scope, new Date())
        );
      } catch (error) {
        domainError(error);
      }
    }),

  markStaleSignals: inventoryControl
    .input(z.object({ branchId }).strict())
    .mutation(async ({ ctx, input }) =>
      markStaleSignals(ctx.db, await admittedScopeFor(ctx, input.branchId), new Date())
    ),

  acknowledgeSignal: inventoryControl
    .input(z.object({ branchId, signalId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await acknowledgeSignal(ctx.db, await admittedScopeFor(ctx, input.branchId), {
          signalId: input.signalId,
          at: new Date(),
        });
      } catch (error) {
        domainError(error);
      }
    }),

  /** §8A invariant 29: a snooze is only auditable with its reason attached. */
  snoozeSignal: inventoryControl
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
        return await snoozeSignal(ctx.db, await admittedScopeFor(ctx, input.branchId), {
          signalId: input.signalId,
          until: input.until,
          reason: input.reason,
          at: new Date(),
        });
      } catch (error) {
        domainError(error);
      }
    }),

  dismissSignal: inventoryControl
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
        return await dismissSignal(ctx.db, await admittedScopeFor(ctx, input.branchId), {
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
  createDraftAction: inventoryControl
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
      const scope = await admittedScopeFor(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) => createDraftAction(txDb(tx), scope, input));
      } catch (error) {
        if (error instanceof PharmacyDraftIntentError) {
          throw new TRPCError({ code: error.code, message: error.message });
        }
        domainError(error);
      }
    }),

  /**
   * PUR-07 role dashboards: live signals per kind and accountable owner.
   * DEV-660: audited like the other branch stock reads, so a tenant ADMIN's
   * branch-assignment exception is recorded. Same session and module checks.
   */
  stockSignalDashboard: auditedProtectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await admittedScopeFor(ctx, input.branchId);
      return roleDashboard(
        ctx.db,
        { organizationId: scope.organizationId, branchId: scope.branchId },
        new Date()
      );
    }),

  /** PUR-07 owner digest payload. DEV-660: audited, as stockSignalDashboard. */
  stockSignalDigest: auditedProtectedProcedure
    .input(z.object({ branchId, ownerUserId: z.string().trim().min(1).max(200) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await admittedScopeFor(ctx, input.branchId);
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
   *
   * DEV-627: landed unit cost never leaves the server (not on a row, not inside a
   * mark-down draft), and the PKR value at risk
   * derived from it is released only to a caller holding `reports:financial`
   * (owner or finance). Everyone else still gets the operational board — units,
   * expiry, MRP, drafts — with `costVisible: false`, a null value at risk and no
   * PKR risk buckets.
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
      const scope = await admittedScopeFor(ctx, input.branchId);
      await assertBranch(ctx.db, scope);
      const costVisible = await can(
        subjectFromSession(ctx.session!.user),
        'reports:financial',
        undefined,
        { db: ctx.db, source: 'TRPC', ip: ctx.requestMeta?.ip ?? null }
      );
      const at = new Date();
      const { withinDays } = input;
      // Always read through 90 days so the headline recovery ledger can show
      // the same cumulative 30/60/90 comparison regardless of the list filter.
      const horizon = new Date(at.getTime() + Math.max(withinDays, 90) * DAY_MS);
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
                    medicine: {
                      select: {
                        productName: true,
                        brandName: true,
                        rx: true,
                        otc: true,
                        restricted: true,
                        controlled: true,
                        productFamily: true,
                      },
                    },
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
          select: {
            id: true,
            name: true,
            relationships: {
              where: { branchId: scope.branchId, active: true },
              select: { expiryReturnWindowDays: true },
              take: 1,
            },
          },
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
        PublicExpiryMarkdownDraft & { eventId: string; reason: string | null; recordedAt: Date }
      >();
      for (const event of markdownEvents) {
        const draft = parseMarkdownDraft(event.detail);
        const key = draft ? `${draft.inventoryLotId}:${draft.stockLocationId}` : null;
        if (draft && key && !markdownByPosition.has(key))
          markdownByPosition.set(key, {
            ...publicMarkdownDraft(draft),
            eventId: event.id,
            reason: event.reason,
            recordedAt: event.createdAt,
          });
      }
      const supplierIds = new Set(suppliers.map((supplier) => supplier.id));
      const supplierByName = new Map(
        suppliers.map((supplier) => [supplier.name.trim().toLowerCase(), supplier.id])
      );
      const relationshipBySupplier = new Map(
        suppliers.map((supplier) => [
          supplier.id,
          supplier.relationships[0]?.expiryReturnWindowDays ?? null,
        ])
      );

      const riskBuckets = expiryRiskBuckets(
        balances.map((row) => ({
          daysLeft: Math.ceil((row.lot.batch.expiresAt.getTime() - at.getTime()) / DAY_MS),
          valueAtRiskMinor: row.onHandUnits * row.lot.unitCostMinor,
        }))
      );
      const rows = balances
        .map((row) => {
          const { lot } = row;
          const expiresAt = lot.batch.expiresAt;
          const receiptSupplier = lot.receiptLines[0]?.goodsReceipt.supplierId ?? null;
          const suggestedSupplierId =
            receiptSupplier && supplierIds.has(receiptSupplier)
              ? receiptSupplier
              : (supplierByName.get(lot.supplierName.trim().toLowerCase()) ?? null);
          const returnDates = supplierReturnDates(
            expiresAt,
            suggestedSupplierId ? (relationshipBySupplier.get(suggestedSupplierId) ?? null) : null
          );
          const markdownEligible = maySuggestExpiryMarkdown(lot.batch.medicine);
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
            printedMrpMinor: lot.printedMrpMinor,
            valueAtRiskMinor: (row.onHandUnits * lot.unitCostMinor) as number | null,
            supplierName: lot.supplierName,
            suggestedSupplierId,
            markdownEligible,
            returnWindowOpensAt: returnDates?.opensAt ?? null,
            returnDeadlineAt: returnDates?.deadlineAt ?? null,
            markdown:
              markdownByPosition.get(`${row.inventoryLotId}:${row.stockLocationId}`) ?? null,
            returnDraft: returnByLot.get(row.inventoryLotId) ?? null,
          };
        })
        .filter((row) => row.expired || row.daysLeft <= withinDays)
        .sort(
          (left, right) =>
            left.expiresAt.getTime() - right.expiresAt.getTime() ||
            // Without cost access the order must not hint at relative cost either.
            (costVisible ? (right.valueAtRiskMinor ?? 0) - (left.valueAtRiskMinor ?? 0) : 0) ||
            left.key.localeCompare(right.key)
        );
      if (!costVisible) {
        return {
          generatedAt: at,
          withinDays,
          costVisible,
          riskBuckets: [] as typeof riskBuckets,
          rows: rows.map((row) => ({ ...row, valueAtRiskMinor: null })),
          suppliers,
        };
      }
      return { generatedAt: at, withinDays, costVisible, riskBuckets, rows, suppliers };
    }),

  /**
   * A mark-down DRAFT: the proposed pack price, recorded against the lot's
   * NEAR_EXPIRY signal. It changes no price — the counter keeps selling at the
   * printed MRP until a person applies the mark-down through pricing.
   */
  draftExpiryMarkdown: inventoryControl
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
      const scope = await admittedScopeFor(ctx, input.branchId);
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
          if (!maySuggestExpiryMarkdown(lot.batch.medicine)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Mark-down suggestions are limited to OTC and non-drug stock.',
            });
          }
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
            return {
              created: false,
              signalId: signal.id,
              eventId: latest.id,
              draft: publicMarkdownDraft(latest.draft),
            };
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
          return {
            created: true,
            signalId: signal.id,
            eventId: event.id,
            draft: publicMarkdownDraft(draft),
          };
        });
      } catch (error) {
        expiryError(error);
      }
    }),

  /**
   * A supplier return DRAFT (EXPIRY_CLAIM) for one near-expiry lot position. It
   * reserves nothing; submitting it in Purchasing → Returns is what holds stock.
   */
  draftExpiryReturn: inventoryControl
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
      const scope = await admittedScopeFor(ctx, input.branchId);
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
   * DEV-728: one EXPIRY_CLAIM DRAFT to a distributor covering every listed
   * near-expiry position it can still take. Each position is checked exactly as
   * `draftExpiryReturn` checks one: branch-locked lot, inside the action horizon,
   * no open return already on the lot, and only units not reserved for a claim.
   * Every lot must also have come from that distributor, or the claim is refused.
   * Expired lots are skipped too: a line's return window ends at the lot's expiry,
   * and submitting refuses the whole return if any line's window has closed.
   * Positions that fail those checks are skipped, never forced onto the claim.
   * Like any draft it reserves nothing until it is submitted in Purchasing.
   */
  draftExpiryReturnClaim: inventoryControl
    .input(
      z
        .object({
          branchId,
          supplierId: z.string().min(1).max(128),
          positions: z
            .array(
              z
                .object({
                  inventoryLotId: z.string().min(1).max(128),
                  stockLocationId: z.string().min(1).max(128),
                })
                .strict()
            )
            .min(1)
            .max(EXPIRY_CLAIM_MAX_POSITIONS)
            .refine(
              (positions) =>
                new Set(positions.map((p) => `${p.inventoryLotId}:${p.stockLocationId}`)).size ===
                positions.length,
              'Each stock position may appear once.'
            ),
          reason: z.string().trim().min(1).max(500),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await admittedScopeFor(ctx, input.branchId);
      const at = new Date();
      try {
        return await ctx.db.$transaction(async (transaction) => {
          const tx = txDb(transaction);
          await assertBranch(tx, scope);
          const supplier = await tx.pharmacySupplier.findFirst({
            where: { id: input.supplierId, organizationId: scope.organizationId, active: true },
            select: { id: true, name: true },
          });
          if (!supplier) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Supplier is outside this workspace.',
            });
          }
          // Lock in a stable order so two claims over overlapping lots cannot deadlock.
          const positions = [...input.positions].sort(
            (left, right) =>
              left.inventoryLotId.localeCompare(right.inventoryLotId) ||
              left.stockLocationId.localeCompare(right.stockLocationId)
          );
          const lines: Array<Parameters<typeof createPurchaseReturn>[2]['lines'][number]> = [];
          const alreadyOpen: Array<{ id: string; reference: string; status: string }> = [];
          let windowClosed = 0;
          for (const position of positions) {
            const lot = await lockExpiringLot(tx, scope, position.inventoryLotId);
            assertOnBoard(lot.batch.expiresAt, at);
            // The lot must have come from this distributor, matched the way the
            // board groups it: the supplier on its posted goods receipt while that
            // supplier is active, otherwise the supplier name recorded on the lot.
            const receipt = await tx.pharmacyGoodsReceiptLine.findFirst({
              where: {
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                inventoryLotId: position.inventoryLotId,
                goodsReceipt: { status: 'POSTED' },
              },
              select: {
                goodsReceipt: {
                  select: { supplierId: true, supplier: { select: { active: true } } },
                },
              },
            });
            const fromSupplier = receipt?.goodsReceipt.supplier.active
              ? receipt.goodsReceipt.supplierId === supplier.id
              : sameSupplierName(lot.supplierName, supplier.name);
            if (!fromSupplier) {
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: 'A lot on this claim did not come from that supplier.',
              });
            }
            if (lot.batch.expiresAt.getTime() <= at.getTime()) {
              windowClosed += 1;
              continue;
            }
            const open = await tx.pharmacyPurchaseReturnLine.findFirst({
              where: {
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                inventoryLotId: position.inventoryLotId,
                purchaseReturn: { status: { in: ['DRAFT', 'SUBMITTED'] } },
              },
              orderBy: { createdAt: 'desc' },
              select: { purchaseReturn: { select: { id: true, reference: true, status: true } } },
            });
            if (open) {
              alreadyOpen.push(open.purchaseReturn);
              continue;
            }
            const [onHandUnits, reserved] = await Promise.all([
              availableAt(tx, scope, position.inventoryLotId, position.stockLocationId),
              tx.pharmacySupplierClaim.aggregate({
                where: {
                  organizationId: scope.organizationId,
                  branchId: scope.branchId,
                  inventoryLotId: position.inventoryLotId,
                  status: 'RESERVED',
                },
                _sum: { reservedUnits: true },
              }),
            ]);
            const units = Math.min(onHandUnits, onHandUnits - (reserved._sum.reservedUnits ?? 0));
            if (units <= 0) continue;
            lines.push({
              inventoryLotId: position.inventoryLotId,
              stockLocationId: position.stockLocationId,
              quantityUnits: units,
              reason: input.reason,
              returnWindowEndsAt: lot.batch.expiresAt,
              expectedCreditMinor: units * lot.unitCostMinor,
            });
          }
          if (lines.length === 0) {
            if (alreadyOpen[0]) {
              return { created: false, purchaseReturn: alreadyOpen[0], lineCount: 0, skipped: 0 };
            }
            if (windowClosed > 0) throw new PharmacySupplierReturnError('RETURN_WINDOW_CLOSED');
            throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
          }
          const stamp = at.toISOString().slice(0, 10).replaceAll('-', '');
          const created = await createPurchaseReturn(tx, scope, {
            supplierId: supplier.id,
            kind: 'EXPIRY_CLAIM',
            reference: `EXPC-${stamp}-${at.getTime().toString(36).toUpperCase()}`,
            note: `Expiry claim to ${supplier.name}, drafted from the near-expiry board. A draft reserves nothing; submit it to hold the stock for the supplier.`,
            lines,
          });
          return {
            created: true,
            purchaseReturn: {
              id: created.id,
              reference: created.reference,
              status: created.status,
            },
            lineCount: lines.length,
            skipped: positions.length - lines.length,
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
  quarantineExpiring: inventoryControl
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
      const scope = await admittedScopeFor(ctx, input.branchId);
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
  // PR J (#979): the transfer board shows every movement between branches, so it
  // needs the same `pharmacy:inventory` capability its allocate/approve/dispatch/
  // receive actions already need, not just the module.
  transferBoard: inventoryControl
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) =>
      transferBoard(ctx.db, await admittedScopeFor(ctx, input.branchId))
    ),

  /** WHA-1603 INV-07: close a transfer, posting any shortfall as a custody write-off. */
  receiveTransferWithVariance: inventoryControl
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
              witnessPin: z.string().regex(/^\d{4,8}$/),
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
          receiveTransferWithVariance(txDb(tx), await admittedScopeFor(ctx, input.branchId), input)
        );
      } catch (error) {
        domainError(error);
      }
    }),
});
