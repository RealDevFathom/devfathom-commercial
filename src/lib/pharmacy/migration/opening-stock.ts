import { enforceOperatingMode } from '../operating-mode';
import { can } from '@/lib/abac';
import 'server-only';

/**
 * PH-MIG / MIG-03 — opening stock via physical count, with batch reconciliation
 * and signed opening ledgers.
 *
 * The shape is INV-06's count session: expected on one side, counted on the
 * other, a variance per line and a materiality threshold on the session. The one
 * difference is where "expected" comes from. An INV-06 count compares the shelf
 * against a balance this system already holds; an opening count has no such
 * balance yet, so the expected side is the incumbent's mapped migration row.
 * Everything after that — what posts, what a variance means, what sign-off
 * requires — is the same idea.
 *
 * WHAT POSTS IS THE COUNT, NOT THE EXPORT. The incumbent's quantity is evidence
 * of what it *claimed*; the physical count is evidence of what is *there*. So the
 * lot is created from the counted units and the difference is recorded as a
 * variance to be explained, never reconciled by adjusting the count to match the
 * export.
 *
 * MIG-02's "missing batch/expiry/MRP is never silently defaulted" is carried
 * through here without exception: `draftLine` writes exactly what it was given,
 * nullable columns receive `null`, and the matching exception row is written in
 * the SAME transaction. There is no code path in this module that invents a
 * batch number, an expiry, an MRP, a cost, a location or a source ref. The
 * database backs it up — a line cannot reach POSTED while any of them is null.
 */
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { expiryInstant } from '../stock-ledger';
import type { LedgerScope } from '../stock-ledger';

export class PharmacyOpeningError extends Error {
  constructor(
    readonly reason:
      | 'NOT_FOUND'
      | 'CROSS_BRANCH_REFERENCE'
      | 'INVALID_STATE'
      | 'INVALID_UNITS'
      | 'INVALID_AMOUNT'
      | 'INCOMPLETE_LINE'
      | 'OPEN_EXCEPTIONS'
      | 'UNEXPLAINED_VARIANCE'
      | 'COAUTH_REQUIRED'
  ) {
    super(reason);
    this.name = 'PharmacyOpeningError';
  }
}

/** The six attributes every opening lot needs, per MIG-03. */
export type OpeningLineAttributes = {
  sourceRef: string | null;
  manufacturingBatchId: string | null;
  batchNumber: string | null;
  expiryDate: Date | null;
  expiryPrecision: 'DAY' | 'MONTH' | null;
  printedMrpMinor: number | null;
  unitCostMinor: number | null;
  stockLocationId: string | null;
  packLevelId: string | null;
  unitsPerPack: number | null;
  expectedUnits: number | null;
  countedUnits: number | null;
};

export type OpeningExceptionBucket =
  | 'MISSING_BATCH'
  | 'MISSING_EXPIRY'
  | 'MISSING_MRP'
  | 'MISSING_COST'
  | 'MISSING_LOCATION'
  | 'MISSING_SOURCE_REF'
  | 'MISSING_COUNT';

/**
 * Which required attributes this line is missing, as exception buckets.
 *
 * Pure, and deliberately exhaustive rather than short-circuiting: an operator
 * fixing a line wants every gap at once, not the first one.
 */
export function missingAttributes(
  line: Pick<
    OpeningLineAttributes,
    | 'sourceRef'
    | 'manufacturingBatchId'
    | 'batchNumber'
    | 'expiryDate'
    | 'expiryPrecision'
    | 'printedMrpMinor'
    | 'unitCostMinor'
    | 'stockLocationId'
    | 'packLevelId'
    | 'unitsPerPack'
    | 'countedUnits'
  >
): OpeningExceptionBucket[] {
  const gaps: OpeningExceptionBucket[] = [];
  if (line.sourceRef === null || line.sourceRef.trim() === '') gaps.push('MISSING_SOURCE_REF');
  if (line.manufacturingBatchId === null || line.batchNumber === null) gaps.push('MISSING_BATCH');
  if (line.expiryDate === null || line.expiryPrecision === null) gaps.push('MISSING_EXPIRY');
  if (line.printedMrpMinor === null) gaps.push('MISSING_MRP');
  if (line.unitCostMinor === null) gaps.push('MISSING_COST');
  if (line.stockLocationId === null || line.packLevelId === null || line.unitsPerPack === null) {
    gaps.push('MISSING_LOCATION');
  }
  if (line.countedUnits === null) gaps.push('MISSING_COUNT');
  return gaps;
}

const BUCKET_DETAIL: Record<OpeningExceptionBucket, string> = {
  MISSING_SOURCE_REF: 'The incumbent row supplied no source reference for this opening lot.',
  MISSING_BATCH: 'The incumbent row supplied no batch number, so no manufacturing batch resolved.',
  MISSING_EXPIRY: 'The incumbent row supplied no printed expiry.',
  MISSING_MRP: 'The incumbent row supplied no printed MRP.',
  MISSING_COST: 'The incumbent row supplied no unit cost.',
  MISSING_LOCATION: 'No stock location or pack level was resolved for this opening lot.',
  MISSING_COUNT: 'The physical count has not recorded this lot yet.',
};

/** The D05 materiality threshold. Absent a row it is zero, never "no limit". */
export type MaterialityThreshold = { thresholdMinor: bigint; thresholdUnits: number };

export const DEFAULT_MATERIALITY_THRESHOLD: MaterialityThreshold = {
  thresholdMinor: BigInt(0),
  thresholdUnits: 0,
};

/**
 * Resolve the branch's D05 threshold.
 *
 * An unset threshold resolves to zero, which makes every variance material. That
 * is the conservative direction: until the contract sets a figure, an unset
 * threshold delays finality rather than granting it.
 */
export async function materialityThreshold(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>
): Promise<MaterialityThreshold> {
  const row = await db.pharmacyMaterialityThreshold.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!row) return DEFAULT_MATERIALITY_THRESHOLD;
  return { thresholdMinor: row.thresholdMinor, thresholdUnits: row.thresholdUnits };
}

/** Record the contract's D05 threshold for one branch. */
export async function setMaterialityThreshold(
  db: ScopedDb,
  scope: LedgerScope,
  input: { thresholdMinor: bigint; thresholdUnits: number }
) {
  if (input.thresholdMinor < BigInt(0)) throw new PharmacyOpeningError('INVALID_AMOUNT');
  if (!Number.isSafeInteger(input.thresholdUnits) || input.thresholdUnits < 0) {
    throw new PharmacyOpeningError('INVALID_UNITS');
  }
  return db.pharmacyMaterialityThreshold.upsert({
    where: {
      organizationId_branchId: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
      },
    },
    create: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      thresholdMinor: input.thresholdMinor,
      thresholdUnits: input.thresholdUnits,
      setByActorId: scope.actorId,
    },
    update: {
      thresholdMinor: input.thresholdMinor,
      thresholdUnits: input.thresholdUnits,
      setByActorId: scope.actorId,
      setAt: new Date(),
    },
  });
}

/** Open an opening-stock reconciliation for one branch. */
export async function createOpeningSession(
  db: ScopedDb,
  scope: LedgerScope,
  input: { openingAt: Date; migrationBatchId?: string }
) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId },
  });
  if (!branch) throw new PharmacyOpeningError('CROSS_BRANCH_REFERENCE');

  return db.pharmacyOpeningSession.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      migrationBatchId: input.migrationBatchId,
      openingAt: input.openingAt,
      createdByActorId: scope.actorId,
    },
  });
}

/**
 * State one opening lot candidate and, in the same transaction, every exception
 * its gaps raise.
 *
 * The line is written verbatim. A gap makes the line an EXCEPTION, which cannot
 * post; it never makes the line a guess.
 */
export async function draftLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: { sessionId: string; migrationRowId?: string } & OpeningLineAttributes
) {
  const session = await requireSession(db, scope, input.sessionId, ['DRAFT', 'COUNTED']);

  for (const value of [input.printedMrpMinor, input.unitCostMinor]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new PharmacyOpeningError('INVALID_AMOUNT');
    }
  }
  for (const value of [input.expectedUnits, input.countedUnits]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new PharmacyOpeningError('INVALID_UNITS');
    }
  }
  if (
    input.unitsPerPack !== null &&
    (!Number.isSafeInteger(input.unitsPerPack) || input.unitsPerPack <= 0)
  ) {
    throw new PharmacyOpeningError('INVALID_UNITS');
  }

  // A location must belong to this session's own branch. The composite foreign
  // key refuses another tenant's; this refuses a sibling branch's, which is
  // inside the tenant and so invisible to row-level security.
  if (input.stockLocationId !== null) {
    const location = await db.pharmacyStockLocation.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: session.branchId,
        id: input.stockLocationId,
      },
    });
    if (!location) throw new PharmacyOpeningError('CROSS_BRANCH_REFERENCE');
  }

  const gaps = missingAttributes(input);
  const varianceUnits =
    input.expectedUnits === null || input.countedUnits === null
      ? null
      : input.countedUnits - input.expectedUnits;

  const line = await db.pharmacyOpeningStockLine.create({
    data: {
      organizationId: scope.organizationId,
      sessionId: session.id,
      branchId: session.branchId,
      migrationRowId: input.migrationRowId,
      sourceRef: input.sourceRef,
      manufacturingBatchId: input.manufacturingBatchId,
      batchNumber: input.batchNumber,
      expiryDate: input.expiryDate,
      expiryPrecision: input.expiryPrecision,
      printedMrpMinor: input.printedMrpMinor,
      unitCostMinor: input.unitCostMinor,
      stockLocationId: input.stockLocationId,
      packLevelId: input.packLevelId,
      unitsPerPack: input.unitsPerPack,
      expectedUnits: input.expectedUnits,
      countedUnits: input.countedUnits,
      varianceUnits,
      status: gaps.length > 0 ? 'EXCEPTION' : 'READY',
    },
  });

  if (gaps.length > 0) {
    await db.pharmacyOpeningException.createMany({
      data: gaps.map((bucket) => ({
        organizationId: scope.organizationId,
        sessionId: session.id,
        lineId: line.id,
        bucket,
        detail: BUCKET_DETAIL[bucket],
      })),
    });
  }

  return { line, gaps };
}

/** Explain a variance. Required before sign-off for any material variance. */
export async function explainVariance(
  db: ScopedDb,
  scope: LedgerScope,
  input: { lineId: string; note: string }
) {
  if (!input.note.trim()) throw new PharmacyOpeningError('INVALID_STATE');
  const updated = await db.pharmacyOpeningStockLine.updateMany({
    where: { id: input.lineId, organizationId: scope.organizationId, branchId: scope.branchId },
    data: { varianceNote: input.note.trim() },
  });
  if (updated.count === 0) throw new PharmacyOpeningError('NOT_FOUND');
}

/**
 * Post the session: one OPENING lot and one OPENING movement per ready line,
 * then the branch's signed opening totals.
 *
 * `receivedAt` is the session's opening instant, because migrated stock IS on
 * the shelf — leaving it null would make the ledger refuse to move it (INV-03),
 * which is exactly the wrong answer for stock a pharmacist is standing next to.
 *
 * A line with an open gap is skipped, not defaulted. Posting a session whose
 * lines all have gaps posts nothing and still writes a zero total, which is an
 * honest statement of the opening position.
 */
export async function postOpeningSession(
  db: ScopedDb,
  scope: LedgerScope,
  input: { sessionId: string; idempotencyKeyPrefix: string }
) {
  const session = await requireSession(db, scope, input.sessionId, ['DRAFT', 'COUNTED']);

  const lines = await db.pharmacyOpeningStockLine.findMany({
    where: { organizationId: scope.organizationId, sessionId: session.id, status: 'READY' },
    orderBy: { id: 'asc' },
  });

  let totalUnits = 0;
  let totalValueMinor = BigInt(0);
  let postedLineCount = 0;

  for (const [index, line] of lines.entries()) {
    // Re-check rather than trust the stored status: the status is a cache of
    // this predicate, and the lot about to be created cannot be built from nulls.
    if (missingAttributes(line).length > 0) throw new PharmacyOpeningError('INCOMPLETE_LINE');

    const unitsPerPack = line.unitsPerPack as number;
    const countedUnits = line.countedUnits as number;
    const sealedPacks = Math.floor(countedUnits / unitsPerPack);
    const looseUnits = countedUnits - sealedPacks * unitsPerPack;

    const lot = await db.pharmacyInventoryLot.create({
      data: {
        organizationId: scope.organizationId,
        branchId: session.branchId,
        manufacturingBatchId: line.manufacturingBatchId as string,
        packLevelId: line.packLevelId as string,
        unitsPerPack,
        // Opening stock has no supplier and no invoice. The source ref is what
        // it does have, and it is unique per line, so the lot's
        // (supplier, invoice, batch) uniqueness still holds.
        supplierName: 'OPENING',
        supplierInvoiceRef: line.sourceRef as string,
        unitCostMinor: line.unitCostMinor as number,
        printedMrpMinor: line.printedMrpMinor as number,
        receivedExpiresAt: expiryInstant(
          line.expiryDate as Date,
          line.expiryPrecision as 'DAY' | 'MONTH'
        ),
        receivedExpiryPrecision: line.expiryPrecision as 'DAY' | 'MONTH',
        receivedAt: session.openingAt,
      },
    });

    // A zero-unit opening line is legal — the incumbent listed the lot and the
    // shelf held none of it — but the ledger's direction CHECK requires an
    // OPENING movement to be positive, so there is nothing to post.
    let movementId: string | null = null;
    if (countedUnits > 0) {
      const movement = await db.pharmacyStockMovement.create({
        data: {
          organizationId: scope.organizationId,
          branchId: session.branchId,
          inventoryLotId: lot.id,
          stockLocationId: line.stockLocationId as string,
          kind: 'OPENING',
          disposition: 'AVAILABLE',
          quantityUnits: countedUnits,
          sealedPackDelta: sealedPacks,
          looseUnitDelta: looseUnits,
          actorId: scope.actorId,
          reason: `Opening stock ${session.id}`,
          idempotencyKey: `${input.idempotencyKeyPrefix}:${index}`,
          occurredAt: session.openingAt,
        },
      });
      movementId = movement.id;
    }

    await db.pharmacyOpeningStockLine.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: line.id } },
      data: {
        // A POSTED line must name both a lot and a movement. A zero-unit line
        // has a lot but no movement, so it stays READY rather than claiming a
        // posting it does not have.
        status: movementId === null ? 'READY' : 'POSTED',
        postedLotId: lot.id,
        postedMovementId: movementId,
      },
    });

    if (movementId !== null) postedLineCount += 1;
    totalUnits += countedUnits;
    totalValueMinor += BigInt(countedUnits) * BigInt(line.unitCostMinor as number);
  }

  const postedAt = new Date();
  await db.pharmacyOpeningSession.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: session.id } },
    data: { status: 'POSTED', postedAt, postedByActorId: scope.actorId },
  });

  const total = await db.pharmacyOpeningTotal.create({
    data: {
      organizationId: scope.organizationId,
      branchId: session.branchId,
      sessionId: session.id,
      totalUnits,
      totalValueMinor,
      lineCount: postedLineCount,
      actorId: scope.actorId,
      postedAt,
    },
  });

  return { total, postedLineCount };
}

export type OpeningLedgerAccount = 'ACCOUNTS_PAYABLE' | 'ACCOUNTS_RECEIVABLE' | 'CASH' | 'BANK';

/**
 * MIG-03 — post the opening AP / AR / cash / bank balances as signed totals.
 *
 * THE STABLE INTERFACE FOR THE FIN LANE. Finance reads opening balances through
 * `openingLedger` below; it does not re-derive them and it does not fork its own
 * opening-balance path. Balances are signed minor units, so a credit balance is
 * negative and the caller never has to know which accounts are "normally"
 * credits.
 */
export async function postOpeningLedger(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    sessionId: string;
    balances: ReadonlyArray<{
      account: OpeningLedgerAccount;
      balanceMinor: bigint;
      sourceRef: string;
    }>;
  }
) {
  const session = await requireSession(db, scope, input.sessionId, ['DRAFT', 'COUNTED', 'POSTED']);

  for (const balance of input.balances) {
    if (!balance.sourceRef.trim()) throw new PharmacyOpeningError('INVALID_STATE');
  }

  const postedAt = new Date();
  await db.pharmacyOpeningLedgerEntry.createMany({
    data: input.balances.map((balance) => ({
      organizationId: scope.organizationId,
      branchId: session.branchId,
      sessionId: session.id,
      account: balance.account,
      balanceMinor: balance.balanceMinor,
      sourceRef: balance.sourceRef.trim(),
      actorId: scope.actorId,
      postedAt,
    })),
  });

  return openingLedger(db, scope, session.id);
}

/**
 * The opening ledger for one session, as the FIN lane consumes it: signed minor
 * totals per account, each with the actor and time that posted it.
 */
export async function openingLedger(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  sessionId: string
): Promise<
  Array<{
    account: OpeningLedgerAccount;
    balanceMinor: bigint;
    sourceRef: string;
    actorId: string;
    postedAt: Date;
  }>
> {
  const rows = await db.pharmacyOpeningLedgerEntry.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, sessionId },
    orderBy: { account: 'asc' },
  });
  return rows.map((row) => ({
    account: row.account,
    balanceMinor: row.balanceMinor,
    sourceRef: row.sourceRef,
    actorId: row.actorId,
    postedAt: row.postedAt,
  }));
}

export type OpeningVarianceRow = {
  lineId: string;
  sourceRef: string | null;
  batchNumber: string | null;
  expectedUnits: number | null;
  countedUnits: number | null;
  varianceUnits: number;
  varianceValueMinor: bigint;
  material: boolean;
  explained: boolean;
  note: string | null;
};

export type OpeningVarianceReport = {
  threshold: MaterialityThreshold;
  rows: OpeningVarianceRow[];
  openExceptionCount: number;
  materialCount: number;
  unexplainedMaterialCount: number;
  /** MIG-03 acceptance: zero unexplained material variance. */
  reconciled: boolean;
};

/**
 * MIG-03's variance report, as a query.
 *
 * A variance is MATERIAL when it exceeds the D05 threshold in units OR in value
 * — either dimension is enough, because a small quantity of an expensive
 * medicine and a large quantity of a cheap one are both worth an explanation.
 * A material variance is EXPLAINED only if it carries a note. `reconciled` is
 * the acceptance criterion itself: no open exceptions and nothing material left
 * unexplained.
 */
export async function openingVarianceReport(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  sessionId: string
): Promise<OpeningVarianceReport> {
  const [threshold, lines, openExceptionCount] = await Promise.all([
    materialityThreshold(db, scope),
    db.pharmacyOpeningStockLine.findMany({
      where: { organizationId: scope.organizationId, sessionId, branchId: scope.branchId },
      orderBy: { id: 'asc' },
    }),
    db.pharmacyOpeningException.count({
      where: { organizationId: scope.organizationId, sessionId, resolvedAt: null },
    }),
  ]);

  const rows: OpeningVarianceRow[] = [];
  for (const line of lines) {
    if (line.varianceUnits === null || line.varianceUnits === 0) continue;
    const varianceValueMinor = BigInt(line.varianceUnits) * BigInt(line.unitCostMinor ?? 0);
    const material =
      Math.abs(line.varianceUnits) > threshold.thresholdUnits ||
      abs(varianceValueMinor) > threshold.thresholdMinor;
    const explained = line.varianceNote !== null && line.varianceNote.trim() !== '';
    rows.push({
      lineId: line.id,
      sourceRef: line.sourceRef,
      batchNumber: line.batchNumber,
      expectedUnits: line.expectedUnits,
      countedUnits: line.countedUnits,
      varianceUnits: line.varianceUnits,
      varianceValueMinor,
      material,
      explained,
      note: line.varianceNote,
    });
  }

  const materialCount = rows.filter((row) => row.material).length;
  const unexplainedMaterialCount = rows.filter((row) => row.material && !row.explained).length;

  return {
    threshold,
    rows,
    openExceptionCount,
    materialCount,
    unexplainedMaterialCount,
    reconciled: unexplainedMaterialCount === 0 && openExceptionCount === 0,
  };
}

function abs(value: bigint): bigint {
  return value < BigInt(0) ? -value : value;
}

/**
 * MIG-03 acceptance: "zero unexplained material variance at sign-off".
 *
 * Sign-off is refused, not warned about, while anything material is unexplained
 * or any exception is still open. Co-authored like INV-06's count approval: the
 * pharmacist who opened the session needs either another signer or fresh
 * audited solo-owner PIN proof.
 */
export async function signOffOpeningSession(
  db: ScopedDb,
  scope: LedgerScope,
  sessionId: string,
  pin?: string
) {
  const session = await requireSession(db, scope, sessionId, ['POSTED']);
  if (
    !(await can(
      { id: scope.actorId, role: 'EMPLOYEE', organizationId: scope.organizationId },
      'pharmacy:inventory',
      undefined,
      { db }
    ))
  )
    throw new PharmacyOpeningError('COAUTH_REQUIRED');
  try {
    await enforceOperatingMode(db, scope, {
      kind: 'ADJUSTMENT',
      makerIds: [session.createdByActorId],
      targetType: 'PharmacyOpeningSession',
      targetId: session.id,
      pin,
    });
  } catch {
    throw new PharmacyOpeningError('COAUTH_REQUIRED');
  }

  const report = await openingVarianceReport(db, scope, sessionId);
  if (report.openExceptionCount > 0) throw new PharmacyOpeningError('OPEN_EXCEPTIONS');
  if (report.unexplainedMaterialCount > 0) {
    throw new PharmacyOpeningError('UNEXPLAINED_VARIANCE');
  }

  return db.pharmacyOpeningSession.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: session.id } },
    data: { status: 'SIGNED_OFF', signedOffBy: scope.actorId, signedOffAt: new Date() },
  });
}

/** Resolve one opening exception. One-way, and it never writes a value. */
export async function resolveOpeningException(
  db: ScopedDb,
  scope: LedgerScope,
  input: { exceptionId: string; note: string }
) {
  const updated = await db.pharmacyOpeningException.updateMany({
    where: { id: input.exceptionId, organizationId: scope.organizationId, resolvedAt: null },
    data: {
      resolvedBy: scope.actorId,
      resolvedAt: new Date(),
      resolutionNote: input.note.trim() || null,
    },
  });
  if (updated.count === 0) throw new PharmacyOpeningError('NOT_FOUND');
}

async function requireSession(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  sessionId: string,
  allowed: ReadonlyArray<'DRAFT' | 'COUNTED' | 'POSTED' | 'SIGNED_OFF'>
) {
  const session = await db.pharmacyOpeningSession.findFirst({
    where: { id: sessionId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!session) throw new PharmacyOpeningError('CROSS_BRANCH_REFERENCE');
  if (!allowed.includes(session.status)) throw new PharmacyOpeningError('INVALID_STATE');
  return session;
}
