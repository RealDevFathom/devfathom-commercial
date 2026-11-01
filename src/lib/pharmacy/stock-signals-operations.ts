import { capabilityMatches } from '@/lib/abac/capabilities';
/**
 * PUR-07 — the database half of the stock action centre: reading exact ledger
 * facts, persisting the deduplicated signals `stock-signals.evaluateStockSignals`
 * derives from them, recording human decisions, and creating DRAFT-only actions
 * (PRD §6.3 PUR-07; §8A invariant 29).
 *
 * §8A INVARIANT 29 IS STRUCTURAL HERE, NOT ADVISORY. `createDraftAction` is the
 * only function in this module that writes anything outside the signal tables,
 * and the three things it can write are a DRAFT requisition, a DRAFT transfer
 * and a DRAFT purchase return. It never touches `pharmacy_stock_movements` and
 * it never creates a `PharmacyPurchaseOrder`; a DRAFT transfer cannot be
 * approved (`approveTransfer` requires ALLOCATED) and a DRAFT return holds no
 * reservation, so neither has a path to stock without a separate human step.
 *
 * CLOSING IS AN ABSENCE, NOT A RULE. `refreshStockSignals` closes every live
 * signal the evaluator did not re-produce from the current facts. That is what
 * makes "closes when on-hand plus approved inbound covers the need" fall out of
 * one place: once inbound covers the need the evaluator emits INBOUND_COVERAGE
 * instead of the shortfall, so the shortfall signal is absent and closes. There
 * is no second closing rule that could disagree with the raising rule.
 */
import { createHash, randomUUID } from 'node:crypto';

import { Prisma, type PharmacyStockSignalAction } from '@/generated/prisma/client';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import type { LedgerScope } from './stock-ledger';
import { packConversions } from './pack-conversion';
import { loadTemperatureZoneStatuses } from './temperature-log';
import {
  DEFAULT_SIGNAL_POLICY,
  evaluateStockSignals,
  isStale,
  PharmacyStockSignalError,
} from './stock-signals';
import type {
  CountVarianceFact,
  DraftSignal,
  InboundFact,
  LotFact,
  SafetyStockFact,
  SignalFacts,
  SignalPolicy,
  StockSignalKind,
} from './stock-signals';

/** Statuses a signal can still be refreshed, closed or acted on from. */
const LIVE_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'SNOOZED', 'STALE'] as const;

type LotRow = {
  inventoryLotId: string;
  medicineId: string;
  stockLocationId: string;
  expiresAt: Date;
  receivedAt: Date | null;
  disposition: LotFact['disposition'];
  batchState: LotFact['batchState'];
  onHandUnits: number;
  reservedUnits: number;
  returnWindowEndsAt: Date | null;
  medicineColdChain: boolean;
  locationColdChain: boolean;
  recallReference: string | null;
  unsettled: boolean;
};

/**
 * Every fact the evaluator needs, in one pass over the ledger projection.
 *
 * `unsettled` is computed here rather than guessed: a lot is unsettled when an
 * inventory count covering it has not been approved, or when it carries a
 * recorded discrepancy. Those are the two states in which the on-hand number is
 * genuinely still in dispute, and they are the only thing that lowers a signal
 * from EXACT to PARTIAL confidence.
 */
export async function loadSignalFacts(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  at: Date,
  policy: SignalPolicy = DEFAULT_SIGNAL_POLICY
): Promise<SignalFacts> {
  const lots = await db.$queryRaw<LotRow[]>(Prisma.sql`
    SELECT
      balance."inventoryLotId"                 AS "inventoryLotId",
      batch."medicineId"                       AS "medicineId",
      balance."stockLocationId"                AS "stockLocationId",
      batch."expiresAt"                        AS "expiresAt",
      lot."receivedAt"                         AS "receivedAt",
      balance."disposition"::text              AS "disposition",
      batch."state"::text                      AS "batchState",
      balance."onHandUnits"                    AS "onHandUnits",
      COALESCE((
        SELECT SUM(claim."reservedUnits") FROM "pharmacy_supplier_claims" claim
        WHERE claim."organizationId" = balance."organizationId"
          AND claim."branchId" = balance."branchId"
          AND claim."inventoryLotId" = balance."inventoryLotId"
          AND claim."status" = 'RESERVED'), 0)  AS "reservedUnits",
      (SELECT MIN(claim."returnBy") FROM "pharmacy_supplier_claims" claim
        WHERE claim."organizationId" = balance."organizationId"
          AND claim."branchId" = balance."branchId"
          AND claim."inventoryLotId" = balance."inventoryLotId"
          AND claim."status" = 'RESERVED')      AS "returnWindowEndsAt",
      medicine."coldChain"                     AS "medicineColdChain",
      location."coldChain"                     AS "locationColdChain",
      (SELECT notice."reference" FROM "pharmacy_recall_notices" notice
        WHERE notice."organizationId" = batch."organizationId"
          AND notice."status" = 'OPEN'
          AND (notice."batchId" = batch."id" OR notice."medicineId" = batch."medicineId")
        ORDER BY notice."reference" ASC LIMIT 1)  AS "recallReference",
      (EXISTS (
        SELECT 1 FROM "pharmacy_inventory_count_lines" line
        JOIN "pharmacy_inventory_counts" count
          ON count."organizationId" = line."organizationId" AND count."id" = line."countId"
        WHERE line."organizationId" = balance."organizationId"
          AND line."inventoryLotId" = balance."inventoryLotId"
          AND count."status" <> 'APPROVED')
       OR EXISTS (
        SELECT 1 FROM "pharmacy_stock_discrepancies" gap
        WHERE gap."organizationId" = balance."organizationId"
          AND gap."inventoryLotId" = balance."inventoryLotId"))  AS "unsettled"
    FROM "pharmacy_stock_balances" balance
    JOIN "pharmacy_inventory_lots" lot
      ON lot."id" = balance."inventoryLotId" AND lot."organizationId" = balance."organizationId"
    JOIN "pharmacy_manufacturing_batches" batch
      ON batch."id" = lot."manufacturingBatchId" AND batch."organizationId" = lot."organizationId"
    JOIN "pharmacy_medicines" medicine
      ON medicine."id" = batch."medicineId" AND medicine."organizationId" = batch."organizationId"
    JOIN "pharmacy_stock_locations" location
      ON location."id" = balance."stockLocationId" AND location."organizationId" = balance."organizationId"
    WHERE balance."organizationId" = ${scope.organizationId}
      AND balance."branchId" = ${scope.branchId}
      AND balance."onHandUnits" > 0
    ORDER BY balance."inventoryLotId" ASC, balance."stockLocationId" ASC, balance."disposition" ASC`);

  // Feed a sustained temperature excursion into the existing location fact.
  // The PUR-07 evaluator and its COLD_CHAIN rule remain unchanged: the reading
  // seam only makes a currently breached validated zone fail that existing
  // effective-location predicate. Pending single readings and monitoring gaps
  // are surfaced by the temperature status query, not invented as new signals.
  const temperatureStatuses = await loadTemperatureZoneStatuses(db, scope, at, [
    ...new Set(lots.filter((lot) => lot.locationColdChain).map((lot) => lot.stockLocationId)),
  ]);
  const excursionLocations = new Set(
    temperatureStatuses
      .filter((status) => status.status === 'EXCURSION')
      .map((status) => status.stockLocationId)
  );

  // Approved, not-yet-received quantity. A purchase order counts only once it is
  // approved (§6.3 PUR-07 says "approved inbound"), and only for what has not
  // already arrived on a POSTED receipt — otherwise received stock would be
  // counted twice, on hand and inbound.
  const purchaseInbound = await db.$queryRaw<
    Array<{ medicineId: string; units: number; reference: string }>
  >(
    Prisma.sql`
      SELECT line."medicineId" AS "medicineId", po."reference" AS "reference",
        SUM(line."orderedCanonicalUnits" + line."bonusCanonicalUnits" - COALESCE((
          SELECT SUM(receipt_line."acceptedCanonicalUnits")
          FROM "pharmacy_goods_receipt_lines" receipt_line
          JOIN "pharmacy_goods_receipts" receipt
            ON receipt."organizationId" = receipt_line."organizationId" AND receipt."id" = receipt_line."goodsReceiptId"
          WHERE receipt_line."organizationId" = line."organizationId"
            AND receipt_line."purchaseOrderLineId" = line."id"
            AND receipt."status" = 'POSTED'), 0))::int AS units
      FROM "pharmacy_purchase_order_lines" line
      JOIN "pharmacy_purchase_orders" po
        ON po."organizationId" = line."organizationId" AND po."id" = line."purchaseOrderId"
      WHERE line."organizationId" = ${scope.organizationId}
        AND po."branchId" = ${scope.branchId}
        AND po."status" IN ('APPROVED','SENT','RECEIVING')
      GROUP BY line."medicineId", po."reference"
      ORDER BY po."reference" ASC, line."medicineId" ASC`
  );

  const transferInbound = await db.$queryRaw<
    Array<{ medicineId: string; units: number; reference: string }>
  >(
    Prisma.sql`
      SELECT batch."medicineId" AS "medicineId", transfer."id" AS "reference",
        SUM(line."quantityUnits" - line."receivedUnits")::int AS units
      FROM "pharmacy_interbranch_transfer_lines" line
      JOIN "pharmacy_interbranch_transfers" transfer
        ON transfer."organizationId" = line."organizationId" AND transfer."id" = line."transferId"
      JOIN "pharmacy_inventory_lots" lot
        ON lot."organizationId" = line."organizationId" AND lot."id" = line."sourceLotId"
      JOIN "pharmacy_manufacturing_batches" batch
        ON batch."organizationId" = lot."organizationId" AND batch."id" = lot."manufacturingBatchId"
      WHERE line."organizationId" = ${scope.organizationId}
        AND transfer."toBranchId" = ${scope.branchId}
        AND transfer."status" IN ('APPROVED','DISPATCHED','PARTIALLY_RECEIVED')
      GROUP BY batch."medicineId", transfer."id"
      HAVING SUM(line."quantityUnits" - line."receivedUnits") > 0
      ORDER BY transfer."id" ASC, batch."medicineId" ASC`
  );

  const [safetyStockRows, countVarianceRows, observed] = await Promise.all([
    db.pharmacySafetyStock.findMany({
      where: { organizationId: scope.organizationId, branchId: scope.branchId },
      orderBy: { medicineId: 'asc' },
    }),
    db.$queryRaw<
      Array<{
        inventoryLotId: string;
        medicineId: string;
        stockLocationId: string;
        varianceUnits: number;
        varianceThreshold: number;
        observedAt: Date;
      }>
    >(Prisma.sql`
      SELECT line."inventoryLotId" AS "inventoryLotId", batch."medicineId" AS "medicineId",
        line."stockLocationId" AS "stockLocationId", line."varianceUnits" AS "varianceUnits",
        count."varianceThreshold" AS "varianceThreshold", count."approvedAt" AS "observedAt"
      FROM "pharmacy_inventory_count_lines" line
      JOIN "pharmacy_inventory_counts" count
        ON count."organizationId" = line."organizationId" AND count."id" = line."countId"
      JOIN "pharmacy_inventory_lots" lot
        ON lot."organizationId" = line."organizationId" AND lot."id" = line."inventoryLotId"
      JOIN "pharmacy_manufacturing_batches" batch
        ON batch."organizationId" = lot."organizationId" AND batch."id" = lot."manufacturingBatchId"
      WHERE line."organizationId" = ${scope.organizationId}
        AND line."branchId" = ${scope.branchId}
        AND count."status" = 'APPROVED'
        AND count."approvedAt" >= ${new Date(at.getTime() - policy.dataWindowDays * 86_400_000)}
        AND line."varianceUnits" IS NOT NULL
      ORDER BY line."inventoryLotId" ASC, line."stockLocationId" ASC`),
    db.pharmacyStockMovement.aggregate({
      where: { organizationId: scope.organizationId, branchId: scope.branchId },
      _max: { occurredAt: true },
    }),
  ]);

  const toInbound = (
    rows: Array<{ medicineId: string; units: number; reference: string }>,
    source: InboundFact['source']
  ): InboundFact[] =>
    rows
      .map((row) => ({
        medicineId: row.medicineId,
        units: Number(row.units),
        source,
        reference: row.reference,
      }))
      .filter((row) => row.units > 0);

  const safetyStocks: SafetyStockFact[] = safetyStockRows.map((row) => ({
    medicineId: row.medicineId,
    safetyStockUnits: row.safetyStockUnits,
    coverageDays: row.coverageDays,
    approvedAt: row.approvedAt,
  }));

  const countVariances: CountVarianceFact[] = countVarianceRows.map((row) => ({
    inventoryLotId: row.inventoryLotId,
    medicineId: row.medicineId,
    stockLocationId: row.stockLocationId,
    varianceUnits: Number(row.varianceUnits),
    varianceThreshold: Number(row.varianceThreshold),
    observedAt: row.observedAt,
  }));

  return {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    at,
    sourceObservedAt: observed._max.occurredAt ?? at,
    lots: lots.map((row) => ({
      ...row,
      locationColdChain: row.locationColdChain && !excursionLocations.has(row.stockLocationId),
      onHandUnits: Number(row.onHandUnits),
      reservedUnits: Number(row.reservedUnits),
    })),
    safetyStocks,
    inbound: [
      ...toInbound(purchaseInbound, 'PURCHASE_ORDER'),
      ...toInbound(transferInbound, 'TRANSFER'),
    ],
    countVariances,
  };
}

export type RefreshResult = {
  raised: number;
  refreshed: number;
  closed: number;
  signals: Array<{ id: string; kind: StockSignalKind; dedupKey: string }>;
};

function signalData(draft: DraftSignal, scope: Pick<LedgerScope, 'organizationId' | 'branchId'>) {
  return {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    kind: draft.kind,
    dedupKey: draft.dedupKey,
    medicineId: draft.medicineId,
    stockLocationId: draft.stockLocationId,
    inventoryLotId: draft.inventoryLotId,
    cause: draft.cause,
    ownerUserId: draft.ownerUserId,
    dueAt: draft.dueAt,
    explanation: draft.explanation,
    dataWindowStart: draft.dataWindowStart,
    dataWindowEnd: draft.dataWindowEnd,
    sourceObservedAt: draft.sourceObservedAt,
    freshnessSeconds: draft.freshnessSeconds,
    confidence: draft.confidence,
    neededUnits: draft.neededUnits,
    onHandUnits: draft.onHandUnits,
    inboundUnits: draft.inboundUnits,
    computedAt: draft.computedAt,
  };
}

/**
 * Recompute the branch's signals and reconcile them with what is already
 * persisted. Deduplication is by `dedupKey` over the live statuses only, so a
 * dismissed signal stays dismissed on the record while the same condition
 * remains free to be raised again later.
 *
 * A snoozed signal is refreshed but keeps its snooze: deferring a decision does
 * not mean the underlying number stops being maintained.
 */
export async function refreshStockSignals(
  db: ScopedDb,
  scope: LedgerScope,
  at: Date,
  policy: SignalPolicy = DEFAULT_SIGNAL_POLICY
): Promise<RefreshResult> {
  const facts = await loadSignalFacts(db, scope, at, policy);
  const drafts = evaluateStockSignals(facts, policy);

  const live = await db.pharmacyStockSignal.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: { in: [...LIVE_STATUSES] },
    },
  });
  const byKey = new Map(live.map((signal) => [signal.dedupKey, signal]));

  const result: RefreshResult = { raised: 0, refreshed: 0, closed: 0, signals: [] };
  for (const draft of drafts) {
    const existing = byKey.get(draft.dedupKey);
    if (existing) {
      const updated = await db.pharmacyStockSignal.update({
        where: { id: existing.id },
        data: {
          ...signalData(draft, scope),
          // A STALE signal recovers on recomputation; an acknowledged or
          // snoozed one keeps the decision its owner already made.
          status: existing.status === 'STALE' ? 'OPEN' : existing.status,
          markedStaleAt: null,
        },
      });
      await db.pharmacyStockSignalEvent.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          signalId: updated.id,
          kind: 'REFRESHED',
          actorId: scope.actorId,
          detail: draft.explanation,
        },
      });
      result.refreshed += 1;
      result.signals.push({ id: updated.id, kind: draft.kind, dedupKey: draft.dedupKey });
      continue;
    }
    const created = await db.pharmacyStockSignal.create({ data: signalData(draft, scope) });
    await db.pharmacyStockSignalEvent.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        signalId: created.id,
        kind: 'RAISED',
        actorId: scope.actorId,
        detail: draft.explanation,
      },
    });
    result.raised += 1;
    result.signals.push({ id: created.id, kind: draft.kind, dedupKey: draft.dedupKey });
  }

  const produced = new Set(drafts.map((draft) => draft.dedupKey));
  for (const signal of live) {
    if (produced.has(signal.dedupKey)) continue;
    await db.pharmacyStockSignal.update({
      where: { id: signal.id },
      data: { status: 'CLOSED', closedAt: at, markedStaleAt: null },
    });
    await db.pharmacyStockSignalEvent.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        signalId: signal.id,
        kind: 'CLOSED',
        actorId: scope.actorId,
        detail: 'The condition no longer holds against current ledger facts.',
      },
    });
    result.closed += 1;
  }
  return result;
}

/**
 * Mark every live signal whose snapshot has aged past its own freshness policy.
 * The comparison uses the `freshnessSeconds` stored on the row, so a later
 * policy change never rewrites whether a past signal was trustworthy.
 */
export async function markStaleSignals(
  db: ScopedDb,
  scope: LedgerScope,
  now: Date
): Promise<number> {
  const candidates = await db.pharmacyStockSignal.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: { in: ['OPEN', 'ACKNOWLEDGED', 'SNOOZED'] },
    },
  });
  let marked = 0;
  for (const signal of candidates) {
    if (!isStale(signal, now)) continue;
    await db.pharmacyStockSignal.update({
      where: { id: signal.id },
      data: { status: 'STALE', markedStaleAt: now },
    });
    await db.pharmacyStockSignalEvent.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        signalId: signal.id,
        kind: 'MARKED_STALE',
        actorId: scope.actorId,
        detail: `Source data older than the ${signal.freshnessSeconds}s freshness policy in force when this signal was computed.`,
      },
    });
    marked += 1;
  }
  return marked;
}

async function loadSignal(db: ScopedDb, scope: LedgerScope, signalId: string) {
  const signal = await db.pharmacyStockSignal.findFirst({
    where: { id: signalId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!signal) throw new PharmacyStockSignalError('NOT_FOUND');
  return signal;
}

export async function acknowledgeSignal(
  db: ScopedDb,
  scope: LedgerScope,
  input: { signalId: string; at: Date }
) {
  const signal = await loadSignal(db, scope, input.signalId);
  if (signal.status === 'DISMISSED' || signal.status === 'CLOSED') {
    throw new PharmacyStockSignalError('INVALID_STATE');
  }
  const updated = await db.pharmacyStockSignal.update({
    where: { id: signal.id },
    data: {
      status: 'ACKNOWLEDGED',
      acknowledgedAt: input.at,
      acknowledgedByUserId: scope.actorId,
      markedStaleAt: null,
    },
  });
  await db.pharmacyStockSignalEvent.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      signalId: signal.id,
      kind: 'ACKNOWLEDGED',
      actorId: scope.actorId,
    },
  });
  return updated;
}

/** A snooze defers with a reason and a return date; it never deletes a signal. */
export async function snoozeSignal(
  db: ScopedDb,
  scope: LedgerScope,
  input: { signalId: string; until: Date; reason: string; at: Date }
) {
  if (input.reason.trim().length === 0) throw new PharmacyStockSignalError('INVALID_STATE');
  if (input.until.getTime() <= input.at.getTime()) {
    throw new PharmacyStockSignalError('INVALID_STATE');
  }
  const signal = await loadSignal(db, scope, input.signalId);
  if (signal.status === 'DISMISSED' || signal.status === 'CLOSED') {
    throw new PharmacyStockSignalError('INVALID_STATE');
  }
  const updated = await db.pharmacyStockSignal.update({
    where: { id: signal.id },
    data: {
      status: 'SNOOZED',
      snoozedUntil: input.until,
      snoozeReason: input.reason,
      markedStaleAt: null,
    },
  });
  await db.pharmacyStockSignalEvent.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      signalId: signal.id,
      kind: 'SNOOZED',
      actorId: scope.actorId,
      reason: input.reason,
    },
  });
  return updated;
}

export async function dismissSignal(
  db: ScopedDb,
  scope: LedgerScope,
  input: { signalId: string; reason: string; at: Date }
) {
  if (input.reason.trim().length === 0) throw new PharmacyStockSignalError('INVALID_STATE');
  const signal = await loadSignal(db, scope, input.signalId);
  if (signal.status === 'CLOSED') throw new PharmacyStockSignalError('INVALID_STATE');
  const updated = await db.pharmacyStockSignal.update({
    where: { id: signal.id },
    data: {
      status: 'DISMISSED',
      dismissedAt: input.at,
      dismissedByUserId: scope.actorId,
      dismissReason: input.reason,
      markedStaleAt: null,
    },
  });
  await db.pharmacyStockSignalEvent.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      signalId: signal.id,
      kind: 'DISMISSED',
      actorId: scope.actorId,
      reason: input.reason,
    },
  });
  return updated;
}

export class PharmacyDraftIntentError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'CONFLICT' | 'BAD_REQUEST',
    message: string
  ) {
    super(message);
    this.name = 'PharmacyDraftIntentError';
  }
}

export type DraftActionInput = { idempotencyKey?: string } & (
  | {
      kind: 'DRAFT_REQUISITION';
      signalId: string;
      reference: string;
      medicineId: string;
      packLevelId: string;
      canonicalUnitsPerPack: number;
      quantityPacks: number;
      neededBy?: Date;
    }
  | {
      kind: 'DRAFT_TRANSFER';
      signalId: string;
      fromBranchId: string;
      lines: ReadonlyArray<{
        sourceLotId: string;
        sourceStockLocationId: string;
        destinationStockLocationId: string;
        quantityUnits: number;
      }>;
    }
  | {
      kind: 'DRAFT_CLAIM';
      signalId: string;
      reference: string;
      supplierId: string;
      lines: ReadonlyArray<{
        inventoryLotId: string;
        stockLocationId: string;
        quantityUnits: number;
        reason: string;
        returnWindowEndsAt: Date;
        expectedCreditMinor: number;
      }>;
    }
);

/**
 * §8A invariant 29 — the one-click action. Creates exactly one DRAFT document
 * and the audit rows that link it to the signal.
 *
 * What is NOT reachable from here, by construction and not by convention: a
 * purchase order (nothing in this function writes `pharmacy_purchase_orders`),
 * a stock movement (nothing writes `pharmacy_stock_movements`), and a stock
 * reservation (a DRAFT return takes none — the INV-09 claim is taken at
 * submission, by a human, in `submitPurchaseReturn`).
 */
type DraftIntentAction = PharmacyStockSignalAction & {
  idempotencyKey: string;
  payloadHash: string;
};

/** Explicit fields keep transport metadata and object insertion order out of identity. */
function normalizeDraftInput(input: DraftActionInput): DraftActionInput {
  if (input.kind === 'DRAFT_REQUISITION') {
    return {
      kind: input.kind,
      signalId: input.signalId,
      reference: input.reference.trim(),
      medicineId: input.medicineId,
      packLevelId: input.packLevelId,
      canonicalUnitsPerPack: input.canonicalUnitsPerPack,
      quantityPacks: input.quantityPacks,
      neededBy: input.neededBy,
    };
  }
  if (input.kind === 'DRAFT_TRANSFER') {
    return {
      kind: input.kind,
      signalId: input.signalId,
      fromBranchId: input.fromBranchId.trim(),
      lines: input.lines.map((line) => ({
        sourceLotId: line.sourceLotId,
        sourceStockLocationId: line.sourceStockLocationId,
        destinationStockLocationId: line.destinationStockLocationId,
        quantityUnits: line.quantityUnits,
      })),
    };
  }
  return {
    kind: input.kind,
    signalId: input.signalId,
    reference: input.reference.trim(),
    supplierId: input.supplierId,
    // Line order is semantic: it determines the saved claim line numbers.
    lines: input.lines.map((line) => ({
      inventoryLotId: line.inventoryLotId,
      stockLocationId: line.stockLocationId,
      quantityUnits: line.quantityUnits,
      reason: line.reason.trim(),
      returnWindowEndsAt: line.returnWindowEndsAt,
      expectedCreditMinor: line.expectedCreditMinor,
    })),
  };
}

async function authorizeDraftIntent(
  db: ScopedDb,
  scope: LedgerScope,
  input: DraftActionInput,
  at: Date
) {
  const [binding] = await db.$queryRaw<Array<{ organizationId: string; branchId: string | null }>>(
    Prisma.sql`SELECT current_setting('app.current_organization_id', true) AS "organizationId",
      NULLIF(current_setting('app.current_branch_id', true), '') AS "branchId"`
  );
  if (
    binding?.organizationId !== scope.organizationId ||
    (binding.branchId !== null &&
      (binding.branchId !== scope.branchId ||
        (input.kind === 'DRAFT_TRANSFER' && binding.branchId !== input.fromBranchId)))
  )
    throw new PharmacyDraftIntentError('FORBIDDEN', 'Draft scope is not authorized.');

  const user = await db.user.findFirst({
    where: { id: scope.actorId, organizationId: scope.organizationId },
    select: {
      status: true,
      organization: { select: { status: true, vertical: true } },
      organizationRole: { select: { permissions: { select: { capability: true, effect: true } } } },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (
    !user ||
    !ACTIVE_STATUSES.has(user.status) ||
    user.organization.vertical !== 'PHARMACY' ||
    !['ONBOARDING', 'ACTIVE', 'GRACE'].includes(user.organization.status)
  )
    throw new PharmacyDraftIntentError('FORBIDDEN', 'Draft actor is not authorized.');

  // These are the native PHARMACY_ROLE_TEMPLATES grants, not Restaurant actions.
  // Preserve the established override-before-role, deny-before-allow precedence.
  const capability =
    input.kind === 'DRAFT_TRANSFER' ? 'pharmacy:inventory' : 'pharmacy:procurement';
  const matches = (rule: { capability: string }) => capabilityMatches(rule.capability, capability);
  const overrides = user.permissionOverrides.filter(matches);
  const rules = overrides.length
    ? overrides
    : (user.organizationRole?.permissions ?? []).filter(matches);
  if (
    rules.some((rule) => rule.effect === 'DENY') ||
    !rules.some((rule) => rule.effect === 'ALLOW')
  ) {
    throw new PharmacyDraftIntentError('FORBIDDEN', 'Draft capability is not authorized.');
  }
  const branches =
    input.kind === 'DRAFT_TRANSFER' ? [scope.branchId, input.fromBranchId] : [scope.branchId];
  for (const branchId of branches) {
    const branch = await db.pharmacyBranch.findFirst({
      where: { id: branchId, organizationId: scope.organizationId, active: true },
    });
    if (!branch) throw new PharmacyDraftIntentError('FORBIDDEN', 'Draft branch is not authorized.');
  }
}

async function assertDraftEligible(
  db: ScopedDb,
  scope: LedgerScope,
  input: DraftActionInput,
  signal: Awaited<ReturnType<typeof loadSignal>>,
  at: Date
) {
  if (
    !['OPEN', 'ACKNOWLEDGED', 'SNOOZED'].includes(signal.status) ||
    isStale(signal, at) ||
    (signal.status === 'SNOOZED' && (!signal.snoozedUntil || signal.snoozedUntil > at))
  )
    throw new PharmacyStockSignalError('INVALID_STATE');
  const kinds =
    input.kind === 'DRAFT_CLAIM'
      ? ['NEAR_EXPIRY', 'RETURN_WINDOW']
      : ['LOW_STOCK', 'STOCKOUT', 'PROJECTED_STOCKOUT'];
  const facts = await loadSignalFacts(db, scope, at);
  if (
    !kinds.includes(signal.kind) ||
    !evaluateStockSignals(facts).some((current) => current.dedupKey === signal.dedupKey)
  ) {
    throw new PharmacyStockSignalError('INVALID_STATE');
  }
  const medicine = await db.medicine.findFirst({
    where: { id: signal.medicineId, organizationId: scope.organizationId },
  });
  if (!medicine) throw new PharmacyStockSignalError('NOT_FOUND');
  const positive = (value: number) =>
    Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
  if (input.kind === 'DRAFT_REQUISITION') {
    if (input.medicineId !== signal.medicineId) throw new PharmacyStockSignalError('INVALID_STATE');
    if (
      !input.reference ||
      !positive(input.quantityPacks * input.canonicalUnitsPerPack) ||
      !positive(input.quantityPacks) ||
      !positive(input.canonicalUnitsPerPack) ||
      (input.neededBy && !Number.isFinite(input.neededBy.getTime()))
    ) {
      throw new PharmacyStockSignalError('INVALID_UNITS');
    }
    const pack = await db.packLevel.findFirst({
      where: {
        id: input.packLevelId,
        organizationId: scope.organizationId,
        presentation: { organizationId: scope.organizationId, medicineId: input.medicineId },
      },
    });
    if (!pack) throw new PharmacyStockSignalError('NOT_FOUND');
    const levels = await db.packLevel.findMany({
      where: { organizationId: scope.organizationId, presentationId: pack.presentationId },
    });
    const conversion = packConversions(levels, at).find((row) => row.packLevelId === pack.id);
    if (conversion?.canonicalUnitsPerPack !== input.canonicalUnitsPerPack) {
      throw new PharmacyStockSignalError('INVALID_UNITS');
    }
    return;
  }
  if (!input.lines.length) throw new PharmacyStockSignalError('INVALID_UNITS');
  if (input.kind === 'DRAFT_TRANSFER' && input.fromBranchId === scope.branchId) {
    throw new PharmacyStockSignalError('INVALID_STATE');
  }
  if (input.kind === 'DRAFT_CLAIM') {
    const supplier = await db.pharmacySupplier.findFirst({
      where: { id: input.supplierId, organizationId: scope.organizationId, active: true },
    });
    if (!supplier || !input.reference) throw new PharmacyStockSignalError('NOT_FOUND');
  }
  const lotTotals = new Map<string, number>();
  const locationTotals = new Map<string, number>();
  for (const line of input.lines) {
    const transfer = 'sourceLotId' in line;
    const branchId = input.kind === 'DRAFT_TRANSFER' ? input.fromBranchId : scope.branchId;
    const lotId = transfer ? line.sourceLotId : line.inventoryLotId;
    const locationId = transfer ? line.sourceStockLocationId : line.stockLocationId;
    const lot = await db.pharmacyInventoryLot.findFirst({
      where: { id: lotId, organizationId: scope.organizationId, branchId },
      include: { batch: true },
    });
    const location = await db.pharmacyStockLocation.findFirst({
      where: { id: locationId, organizationId: scope.organizationId, branchId, active: true },
    });
    if (
      !lot ||
      !location ||
      lot.batch.medicineId !== signal.medicineId ||
      (!transfer &&
        ((signal.inventoryLotId && signal.inventoryLotId !== lotId) ||
          (signal.stockLocationId && signal.stockLocationId !== locationId)))
    ) {
      throw new PharmacyStockSignalError('NOT_FOUND');
    }
    if (!positive(line.quantityUnits)) throw new PharmacyStockSignalError('INVALID_UNITS');
    const balance = await db.pharmacyStockBalance.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId,
        inventoryLotId: lotId,
        stockLocationId: locationId,
        disposition: 'AVAILABLE',
      },
    });
    const reserved = await db.pharmacySupplierClaim.aggregate({
      where: {
        organizationId: scope.organizationId,
        branchId,
        inventoryLotId: lotId,
        status: 'RESERVED',
      },
      _sum: { reservedUnits: true },
    });
    const stock = await db.pharmacyStockBalance.aggregate({
      where: {
        organizationId: scope.organizationId,
        branchId,
        inventoryLotId: lotId,
        disposition: 'AVAILABLE',
      },
      _sum: { onHandUnits: true },
    });
    const lotUnits = (lotTotals.get(lotId) ?? 0) + line.quantityUnits;
    const locationKey = JSON.stringify([lotId, locationId]);
    const locationUnits = (locationTotals.get(locationKey) ?? 0) + line.quantityUnits;
    lotTotals.set(lotId, lotUnits);
    locationTotals.set(locationKey, locationUnits);
    if (
      !balance ||
      locationUnits > balance.onHandUnits ||
      lotUnits > (stock._sum.onHandUnits ?? 0) - (reserved._sum.reservedUnits ?? 0)
    ) {
      throw new PharmacyStockSignalError('INVALID_UNITS');
    }
    if (transfer) {
      const destination = await db.pharmacyStockLocation.findFirst({
        where: {
          id: line.destinationStockLocationId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          active: true,
        },
      });
      const recall = await db.pharmacyRecallNotice.findFirst({
        where: {
          organizationId: scope.organizationId,
          status: 'OPEN',
          OR: [{ batchId: lot.manufacturingBatchId }, { medicineId: signal.medicineId }],
        },
      });
      if (
        !destination ||
        lot.batch.state !== 'ACTIVE' ||
        lot.batch.expiresAt <= at ||
        recall ||
        (medicine.coldChain && (!location.coldChain || !destination.coldChain))
      ) {
        throw new PharmacyStockSignalError('INVALID_STATE');
      }
      if (medicine.coldChain) {
        for (const [temperatureBranch, stockLocationId] of [
          [branchId, locationId],
          [scope.branchId, destination.id],
        ]) {
          const statuses = await loadTemperatureZoneStatuses(
            db,
            { organizationId: scope.organizationId, branchId: temperatureBranch },
            at,
            [stockLocationId]
          );
          if (statuses.some((status) => status.status === 'EXCURSION'))
            throw new PharmacyStockSignalError('INVALID_STATE');
        }
      }
    } else {
      if (
        !line.reason ||
        !Number.isFinite(line.returnWindowEndsAt.getTime()) ||
        line.returnWindowEndsAt <= at ||
        !Number.isSafeInteger(line.expectedCreditMinor) ||
        line.expectedCreditMinor < 0 ||
        line.expectedCreditMinor > 2_147_483_647
      ) {
        throw new PharmacyStockSignalError('INVALID_STATE');
      }
      // The native receipt links establish supplier ownership; a typed name does not.
      const receipt = await db.pharmacyGoodsReceiptLine.findFirst({
        where: {
          organizationId: scope.organizationId,
          inventoryLotId: lotId,
          goodsReceipt: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            supplierId: input.kind === 'DRAFT_CLAIM' ? input.supplierId : '',
            status: 'POSTED',
          },
        },
      });
      if (!receipt) throw new PharmacyStockSignalError('NOT_FOUND');
    }
  }
}

/** Caller must supply the owning tenant transaction; errors must escape it. */
export async function createDraftAction(
  db: ScopedDb,
  scope: LedgerScope,
  supplied: DraftActionInput
) {
  const input = normalizeDraftInput(supplied);
  // Requisitions/claims already have a stable native unique reference. Transfers
  // do not, so an explicit operation key is mandatory for that native draft.
  const idempotencyKey =
    supplied.idempotencyKey?.trim() ?? (input.kind === 'DRAFT_TRANSFER' ? '' : input.reference);
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new PharmacyDraftIntentError('BAD_REQUEST', 'A stable idempotencyKey is required.');
  }
  await db.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(
    ${JSON.stringify(['pharmacy-draft', scope.organizationId, scope.branchId, idempotencyKey])}, 0))`);
  await authorizeDraftIntent(db, scope, input, new Date());
  // Match after acquiring the transaction lock. No P2002 catch inside a failed
  // PostgreSQL transaction, no in-memory cache, and no second draft on replay.
  const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const [previous] = await db.$queryRaw<DraftIntentAction[]>(Prisma.sql`
    SELECT * FROM "pharmacy_stock_signal_actions"
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
      AND "idempotencyKey" = ${idempotencyKey}`);
  if (previous) {
    if (previous.payloadHash !== payloadHash) {
      throw new PharmacyDraftIntentError('CONFLICT', 'IDEMPOTENCY_CONFLICT');
    }
    // Recheck visibility even when the original signal has since closed.
    await loadSignal(db, scope, previous.signalId);
    return previous;
  }
  await db.$queryRaw(Prisma.sql`SELECT "id" FROM "pharmacy_stock_signals"
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
      AND "id" = ${input.signalId} FOR UPDATE`);
  const signal = await loadSignal(db, scope, input.signalId);
  await assertDraftEligible(db, scope, input, signal, new Date());

  let requisitionId: string | null = null;
  let transferId: string | null = null;
  let purchaseReturnId: string | null = null;
  let detail: string;

  if (input.kind === 'DRAFT_REQUISITION') {
    if (!Number.isSafeInteger(input.quantityPacks) || input.quantityPacks <= 0) {
      throw new PharmacyStockSignalError('INVALID_UNITS');
    }
    if (!Number.isSafeInteger(input.canonicalUnitsPerPack) || input.canonicalUnitsPerPack <= 0) {
      throw new PharmacyStockSignalError('INVALID_UNITS');
    }
    const requisition = await db.pharmacyRequisition.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        reference: input.reference,
        // DRAFT is the default, but it is stated here because it is the whole
        // point of this function rather than an incidental initial value.
        status: 'DRAFT',
        requestedByUserId: scope.actorId,
        neededBy: input.neededBy,
      },
    });
    await db.pharmacyRequisitionLine.create({
      data: {
        organizationId: scope.organizationId,
        requisitionId: requisition.id,
        lineNumber: 1,
        medicineId: input.medicineId,
        packLevelId: input.packLevelId,
        quantityPacks: input.quantityPacks,
        canonicalUnitsPerPack: input.canonicalUnitsPerPack,
        canonicalUnits: input.quantityPacks * input.canonicalUnitsPerPack,
        note: `Drafted from stock signal ${signal.dedupKey}`,
      },
    });
    requisitionId = requisition.id;
    detail = `DRAFT requisition ${requisition.reference}`;
  } else if (input.kind === 'DRAFT_TRANSFER') {
    if (input.lines.length === 0) throw new PharmacyStockSignalError('INVALID_UNITS');
    if (input.fromBranchId === scope.branchId) throw new PharmacyStockSignalError('INVALID_STATE');
    const transfer = await db.pharmacyInterbranchTransfer.create({
      data: {
        organizationId: scope.organizationId,
        fromBranchId: input.fromBranchId,
        toBranchId: scope.branchId,
        status: 'DRAFT',
        allocatedById: scope.actorId,
      },
    });
    await db.pharmacyInterbranchTransferLine.createMany({
      data: input.lines.map((line) => ({
        organizationId: scope.organizationId,
        transferId: transfer.id,
        sourceBranchId: input.fromBranchId,
        ...line,
      })),
    });
    transferId = transfer.id;
    detail = `DRAFT inter-branch transfer from ${input.fromBranchId}`;
  } else {
    if (input.lines.length === 0) throw new PharmacyStockSignalError('INVALID_UNITS');
    const purchaseReturn = await db.pharmacyPurchaseReturn.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        supplierId: input.supplierId,
        kind: 'EXPIRY_CLAIM',
        status: 'DRAFT',
        reference: input.reference,
        createdByUserId: scope.actorId,
        note: `Drafted from stock signal ${signal.dedupKey}`,
      },
    });
    await db.pharmacyPurchaseReturnLine.createMany({
      data: input.lines.map((line, index) => ({
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        purchaseReturnId: purchaseReturn.id,
        lineNumber: index + 1,
        ...line,
      })),
    });
    purchaseReturnId = purchaseReturn.id;
    detail = `DRAFT expiry claim ${purchaseReturn.reference}`;
  }

  const [action] = await db.$queryRaw<DraftIntentAction[]>(Prisma.sql`
    INSERT INTO "pharmacy_stock_signal_actions"
      ("id", "organizationId", "branchId", "signalId", "kind", "actorId",
       "requisitionId", "transferId", "purchaseReturnId", "idempotencyKey", "payloadHash", "createdAt")
    VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${signal.id},
      ${input.kind}::"PharmacyStockSignalActionKind", ${scope.actorId}, ${requisitionId},
      ${transferId}, ${purchaseReturnId}, ${idempotencyKey}, ${payloadHash}, CURRENT_TIMESTAMP)
    RETURNING *`);
  if (!action) throw new Error('Draft action insert returned no reference.');
  await db.pharmacyStockSignalEvent.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      signalId: signal.id,
      kind: 'DRAFT_ACTION',
      actorId: scope.actorId,
      detail,
    },
  });
  return action;
}

export type RoleDashboardRow = {
  kind: StockSignalKind;
  ownerUserId: string;
  open: number;
  acknowledged: number;
  snoozed: number;
  stale: number;
  overdue: number;
};

/**
 * PUR-07 role dashboard: what each accountable owner is carrying, by kind. Only
 * live signals are counted — a dismissed or closed one is history, not work.
 */
export async function roleDashboard(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  at: Date
): Promise<RoleDashboardRow[]> {
  const signals = await db.pharmacyStockSignal.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: { in: [...LIVE_STATUSES] },
    },
    orderBy: [{ kind: 'asc' }, { ownerUserId: 'asc' }],
  });
  const rows = new Map<string, RoleDashboardRow>();
  for (const signal of signals) {
    const key = `${signal.kind}:${signal.ownerUserId}`;
    const row =
      rows.get(key) ??
      ({
        kind: signal.kind as StockSignalKind,
        ownerUserId: signal.ownerUserId,
        open: 0,
        acknowledged: 0,
        snoozed: 0,
        stale: 0,
        overdue: 0,
      } satisfies RoleDashboardRow);
    if (signal.status === 'OPEN') row.open += 1;
    if (signal.status === 'ACKNOWLEDGED') row.acknowledged += 1;
    if (signal.status === 'SNOOZED') row.snoozed += 1;
    if (signal.status === 'STALE') row.stale += 1;
    if (signal.dueAt.getTime() < at.getTime() && signal.status !== 'ACKNOWLEDGED') row.overdue += 1;
    rows.set(key, row);
  }
  return [...rows.values()];
}

export type OwnerDigestEntry = {
  signalId: string;
  kind: StockSignalKind;
  dedupKey: string;
  explanation: string;
  dueAt: Date;
  confidence: 'EXACT' | 'PARTIAL';
  status: string;
};

export type OwnerDigest = {
  ownerUserId: string;
  branchId: string;
  generatedAt: Date;
  counts: { overdue: number; dueSoon: number; stale: number; snoozed: number };
  overdue: OwnerDigestEntry[];
  dueSoon: OwnerDigestEntry[];
  stale: OwnerDigestEntry[];
  /** Snoozed signals whose deferral has run out and are due back. */
  resuming: OwnerDigestEntry[];
};

/**
 * The owner digest payload. Buckets are disjoint and ordered by `dueAt` so the
 * same signals always appear in the same place: a digest that reshuffles is a
 * digest nobody reads twice.
 *
 * A STALE signal is listed separately rather than mixed into `overdue`, because
 * the action it needs is different — recompute it, do not act on it.
 */
export async function ownerDigest(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  ownerUserId: string,
  at: Date,
  dueSoonHours = 24
): Promise<OwnerDigest> {
  const signals = await db.pharmacyStockSignal.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      ownerUserId,
      status: { in: [...LIVE_STATUSES] },
    },
    orderBy: [{ dueAt: 'asc' }, { dedupKey: 'asc' }],
  });
  const entry = (signal: (typeof signals)[number]): OwnerDigestEntry => ({
    signalId: signal.id,
    kind: signal.kind as StockSignalKind,
    dedupKey: signal.dedupKey,
    explanation: signal.explanation,
    dueAt: signal.dueAt,
    confidence: signal.confidence,
    status: signal.status,
  });
  const horizon = at.getTime() + dueSoonHours * 3_600_000;

  const stale = signals.filter((signal) => signal.status === 'STALE').map(entry);
  const actionable = signals.filter((signal) => signal.status !== 'STALE');
  const overdue = actionable
    .filter((signal) => signal.status !== 'SNOOZED' && signal.dueAt.getTime() < at.getTime())
    .map(entry);
  const dueSoon = actionable
    .filter(
      (signal) =>
        signal.status !== 'SNOOZED' &&
        signal.dueAt.getTime() >= at.getTime() &&
        signal.dueAt.getTime() <= horizon
    )
    .map(entry);
  const resuming = actionable
    .filter(
      (signal) =>
        signal.status === 'SNOOZED' &&
        signal.snoozedUntil !== null &&
        signal.snoozedUntil.getTime() <= at.getTime()
    )
    .map(entry);

  return {
    ownerUserId,
    branchId: scope.branchId,
    generatedAt: at,
    counts: {
      overdue: overdue.length,
      dueSoon: dueSoon.length,
      stale: stale.length,
      snoozed: actionable.filter((signal) => signal.status === 'SNOOZED').length,
    },
    overdue,
    dueSoon,
    stale,
    resuming,
  };
}
