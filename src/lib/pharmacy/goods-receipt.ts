/**
 * PH-PUR — PRD §6.3 PUR-02 (receiving), PUR-04 (three-way match exceptions and
 * reversal) and PUR-05 (direct purchase). The database half of receiving.
 *
 * This module owns one job: turning a drafted goods receipt into ledger
 * postings, exactly once, with every refusal made before anything is written.
 * It decides nothing that the pure kernel already decides — the fail-closed
 * evidence rule and the match itself live in `receiving.ts` — and it writes no
 * stock of its own: `receiveLot` and `reverseMovements` in `stock-ledger.ts`
 * remain the only writers of lots and movements, so the projection, the
 * non-negative balance and the branch checks all still come from the one place
 * that enforces them (INV-01).
 *
 * ALL OR NOTHING. Posting must run inside the caller's transaction. A receipt
 * that created a lot, posted half its movements and then failed the supplier
 * check would be stock nobody ordered, so the transaction is the unit: either
 * the lot, both dispositions, every exception, the receipt status and the
 * purchase order's move to RECEIVING all commit, or none of them do.
 *
 * PUR-05 PARITY. The direct path is not a second implementation. It reaches
 * `postGoodsReceipt` through the same function, runs the same evidence
 * assertions and produces the same postings; the only difference is that it has
 * no ordered line to match against, and a bypass reason and approver recorded
 * in its place.
 */
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { can } from '@/lib/abac';
import { appendControlledPurchaseEntries } from './controlled-register';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';

import { PharmacyInventoryError } from './inventory';
import {
  assertGoodsReceiptTransition,
  assertSaleableOnReceipt,
  matchReceiptLine,
  PharmacyReceivingError,
  type MatchException,
  type OrderedTerms,
} from './receiving';
import { nearExpiryWarning, packIsExpired } from './gs1-datamatrix';
import { expiryInstant, receiveLot, reverseMovements } from './stock-ledger';
import type { LedgerScope } from './stock-ledger';

export type ReceivingScope = LedgerScope;

/** Deterministic, so a reversal can find exactly the postings a receipt made. */
function acceptedKey(receiptLineId: string): string {
  return `pharmacy-receipt:${receiptLineId}:accepted`;
}

function quarantineKey(receiptLineId: string): string {
  return `pharmacy-receipt:${receiptLineId}:quarantine`;
}

export type PostGoodsReceiptResult = {
  goodsReceiptId: string;
  postedAt: Date;
  lines: ReadonlyArray<{
    goodsReceiptLineId: string;
    inventoryLotId: string;
    acceptedMovementId: string | null;
    quarantineMovementId: string | null;
  }>;
  /** Raised by this posting and OPEN until a human resolves them (PUR-04). */
  exceptions: ReadonlyArray<{ id: string; kind: MatchException['kind']; detail: string }>;
};

/**
 * PUR-02 receiving / PUR-05: post a drafted goods receipt into the batch ledger.
 *
 * Must run inside the caller's transaction.
 */
const WITNESS_BLOCKED = 'A different qualified person must enter their PIN.';

/**
 * PIN witness for a controlled purchase. A receipt with no controlled line
 * returns `{ pharmacistId: null }`. A failed PIN updates the lockout counter
 * and returns `{ blocked }` so the caller can commit that counter without
 * posting stock.
 */
export async function verifyControlledPurchaseWitness(
  db: ScopedDb,
  scope: ReceivingScope,
  input: { goodsReceiptId: string; staffProfileId?: string; pin?: string }
): Promise<{ blocked: string } | { pharmacistId: string | null }> {
  const receipt = await db.pharmacyGoodsReceipt.findFirst({
    where: { id: input.goodsReceiptId, organizationId: scope.organizationId },
    select: {
      branchId: true,
      qualifiedPersonUserId: true,
      lines: { select: { medicineId: true, acceptedCanonicalUnits: true } },
    },
  });
  if (!receipt || receipt.branchId !== scope.branchId) return { pharmacistId: null };
  const controlled = await db.medicine.findMany({
    where: {
      organizationId: scope.organizationId,
      id: { in: receipt.lines.map((line) => line.medicineId) },
      controlled: true,
    },
    select: { id: true },
  });
  const controlledIds = new Set(controlled.map((medicine) => medicine.id));
  const needsRegister = receipt.lines.some(
    (line) => controlledIds.has(line.medicineId) && line.acceptedCanonicalUnits > 0
  );
  if (!needsRegister) return { pharmacistId: null };
  if (!input.staffProfileId || !input.pin || !receipt.qualifiedPersonUserId) {
    return { blocked: WITNESS_BLOCKED };
  }
  await db.$queryRaw`SELECT id FROM restaurant_operator_credentials WHERE "organizationId"=${scope.organizationId} AND "staffProfileId"=${input.staffProfileId} AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: scope.organizationId,
      staffProfileId: input.staffProfileId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
    },
    include: { staffProfile: { include: { user: true } } },
  });
  const pharmacist = credential?.staffProfile.user;
  const now = new Date();
  const eligible =
    credential &&
    credential.staffProfile.status === 'ACTIVE' &&
    pharmacist &&
    pharmacist.id === receipt.qualifiedPersonUserId &&
    pharmacist.organizationId === scope.organizationId &&
    pharmacist.status === 'ACTIVE' &&
    pharmacist.id !== scope.actorId &&
    !isLockedOut(credential, now) &&
    (await can(pharmacist, 'pharmacy:dispense', undefined, { db, now }));
  if (!eligible || !credential || !pharmacist) return { blocked: WITNESS_BLOCKED };
  if (!(await verifyOperatorCredential('PIN', input.pin, credential.credentialHash))) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return { blocked: WITNESS_BLOCKED };
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  return { pharmacistId: pharmacist.id };
}

export async function postGoodsReceipt(
  db: ScopedDb,
  scope: ReceivingScope,
  input: { goodsReceiptId: string; at: Date; staffProfileId?: string; pin?: string }
): Promise<PostGoodsReceiptResult> {
  const receipt = await db.pharmacyGoodsReceipt.findFirst({
    where: { id: input.goodsReceiptId, organizationId: scope.organizationId },
    include: {
      supplier: { include: { licences: true } },
      lines: { orderBy: { lineNumber: 'asc' } },
    },
  });
  if (!receipt) throw new PharmacyReceivingError('NOT_FOUND');
  if (receipt.branchId !== scope.branchId) {
    throw new PharmacyReceivingError('CROSS_BRANCH_REFERENCE');
  }
  assertGoodsReceiptTransition(receipt.status, 'POSTED');
  if (receipt.lines.length === 0) throw new PharmacyReceivingError('INVALID_QUANTITY');

  const controlledMedicines = await db.medicine.findMany({
    where: {
      organizationId: scope.organizationId,
      id: { in: receipt.lines.map((line) => line.medicineId) },
      controlled: true,
    },
    select: { id: true, manufacturer: true },
  });
  const controlledIds = new Set(controlledMedicines.map((medicine) => medicine.id));
  const needsRegister = receipt.lines.some(
    (line) => controlledIds.has(line.medicineId) && line.acceptedCanonicalUnits > 0
  );
  const witness = await verifyControlledPurchaseWitness(db, scope, input);
  if ('blocked' in witness) throw new PharmacyReceivingError('CONTROLLED_WITNESS_REQUIRED');
  if (needsRegister && !witness.pharmacistId) {
    throw new PharmacyReceivingError('CONTROLLED_WITNESS_REQUIRED');
  }

  // Fail closed on the whole receipt before a single lot exists: a receipt that
  // posted three good lines and then refused the fourth would leave stock on
  // the shelf for a delivery the operator never finished accepting.
  for (const line of receipt.lines) {
    if (
      line.ocrFieldEvidence &&
      (!line.ocrRegulatedConfirmedAt || !line.ocrRegulatedConfirmedById)
    ) {
      throw new PharmacyReceivingError('OCR_CONFIRMATION_REQUIRED');
    }
    if (line.acceptedCanonicalUnits > 0 && packIsExpired(line.printedExpiry, input.at)) {
      throw new PharmacyReceivingError('EXPIRED_PACK');
    }
    assertSaleableOnReceipt({
      batchNumber: line.batchNumber,
      printedExpiry: line.printedExpiry,
      supplierInvoiceRef: receipt.supplierInvoiceRef,
      warrantyEvidenceRef: receipt.warrantyEvidenceRef,
      canonicalUnitsPerPack: line.canonicalUnitsPerPack,
      printedMrpMinor: line.printedMrpMinor,
      supplier: {
        authorized: receipt.supplier.authorized,
        licences: receipt.supplier.licences.map((licence) => ({
          expiresAt: licence.expiresAt,
          verified: licence.verifiedAt !== null,
          superseded: receipt.supplier.licences.some(
            (candidate) => candidate.supersedesId === licence.id
          ),
        })),
      },
      at: input.at,
    });
  }

  const lines: PostGoodsReceiptResult['lines'][number][] = [];
  const exceptions: PostGoodsReceiptResult['exceptions'][number][] = [];

  for (const line of receipt.lines) {
    const batch = await resolveManufacturingBatch(db, scope, {
      medicineId: line.medicineId,
      batchNumber: line.batchNumber,
      printedExpiry: line.printedExpiry,
      expiryPrecision: line.expiryPrecision,
    });

    const posted = await receiveLot(db, scope, {
      manufacturingBatchId: batch.id,
      packLevelId: line.packLevelId,
      stockLocationId: line.stockLocationId,
      unitsPerPack: line.canonicalUnitsPerPack,
      supplierName: receipt.supplier.name,
      // The lot's invoice reference is the receipt's, so two lots from the same
      // invoice and batch collide on the ledger's own uniqueness rule rather
      // than silently duplicating stock.
      supplierInvoiceRef: `${receipt.supplierInvoiceRef}#${line.lineNumber}`,
      unitCostMinor: line.unitCostMinor,
      printedMrpMinor: line.printedMrpMinor,
      receivedExpiresAt: batch.expiresAt,
      receivedExpiryPrecision: line.expiryPrecision,
      quantityUnits: line.acceptedCanonicalUnits,
      idempotencyKey: acceptedKey(line.id),
      receivedAt: receipt.receivedAt,
      quarantine:
        line.rejectedCanonicalUnits > 0 && line.quarantineLocationId
          ? {
              units: line.rejectedCanonicalUnits,
              stockLocationId: line.quarantineLocationId,
              idempotencyKey: quarantineKey(line.id),
              reason: line.rejectionReason ?? 'Rejected at receipt.',
            }
          : undefined,
    });

    const expiryDate = line.printedExpiry.toISOString().slice(0, 10);
    const near = line.acceptedCanonicalUnits > 0 ? nearExpiryWarning(expiryDate, input.at) : null;
    await db.pharmacyGoodsReceiptLine.update({
      where: { id: line.id },
      data: {
        inventoryLotId: posted.lot.id,
        ...(near && !line.gs1Warnings.includes(near.code)
          ? { gs1Warnings: [...line.gs1Warnings, near.code] }
          : {}),
      },
    });
    lines.push({
      goodsReceiptLineId: line.id,
      inventoryLotId: posted.lot.id,
      acceptedMovementId: posted.movement?.id ?? null,
      quarantineMovementId: posted.quarantineMovement?.id ?? null,
    });

    for (const exception of matchReceiptLine({
      ordered: await orderedTermsFor(db, scope, line.purchaseOrderLineId, receipt.id),
      received: {
        canonicalUnitsPerPack: line.canonicalUnitsPerPack,
        arrivedCanonicalUnits: line.receivedCanonicalUnits + line.bonusCanonicalUnits,
        rejectedCanonicalUnits: line.rejectedCanonicalUnits,
        rejectionReason: line.rejectionReason,
        invoicedPricePerPackMinor: line.invoicedPricePerPackMinor,
      },
    })) {
      const created = await db.pharmacyReceivingException.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          goodsReceiptId: receipt.id,
          goodsReceiptLineId: line.id,
          purchaseOrderLineId: line.purchaseOrderLineId,
          kind: exception.kind,
          detail: exception.detail,
          expectedUnits: exception.expectedUnits,
          observedUnits: exception.observedUnits,
          expectedMinor: exception.expectedMinor,
          observedMinor: exception.observedMinor,
        },
      });
      exceptions.push({ id: created.id, kind: exception.kind, detail: exception.detail });
    }
  }

  if (needsRegister && witness.pharmacistId) {
    const purchaseLines = [];
    for (const posted of lines) {
      const source = receipt.lines.find((line) => line.id === posted.goodsReceiptLineId);
      const medicine = controlledMedicines.find((item) => item.id === source?.medicineId);
      if (!source || !medicine || source.acceptedCanonicalUnits <= 0) continue;
      if (!posted.acceptedMovementId) throw new PharmacyReceivingError('INVALID_QUANTITY');
      purchaseLines.push({
        medicineId: medicine.id,
        manufacturer: medicine.manufacturer,
        inventoryLotId: posted.inventoryLotId,
        stockMovementId: posted.acceptedMovementId,
        batchNumber: source.batchNumber,
        quantityCanonicalUnits: source.acceptedCanonicalUnits,
        counterpartyName: receipt.supplier.name,
      });
    }
    await appendControlledPurchaseEntries(db, {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      recordedByUserId: scope.actorId,
      witnessedByUserId: witness.pharmacistId,
      signatureRef: `pin:${witness.pharmacistId}`,
      lines: purchaseLines,
    });
  }

  await db.pharmacyGoodsReceipt.update({
    where: { id: receipt.id },
    data: { status: 'POSTED', postedAt: input.at },
  });

  // PUR-02: the order is now being received against. SENT → RECEIVING is the
  // last transition of that status machine, so a second receipt against the
  // same order finds it already there and leaves it alone.
  if (receipt.purchaseOrderId) {
    const order = await db.pharmacyPurchaseOrder.findFirst({
      where: { id: receipt.purchaseOrderId, organizationId: scope.organizationId },
    });
    if (order?.status === 'SENT') {
      await db.pharmacyPurchaseOrder.update({
        where: { id: order.id },
        data: { status: 'RECEIVING' },
      });
    }
  }

  return { goodsReceiptId: receipt.id, postedAt: input.at, lines, exceptions };
}

/**
 * §8A invariant 18: one manufacturing batch, many inventory lots. A second
 * delivery of the same batch number for the same medicine joins the existing
 * batch — which is what makes a recall reach every lot of it at once — so the
 * batch is resolved, not blindly created.
 *
 * A batch that already exists with a different expiry is a contradiction about
 * the same physical goods, not a new batch, and is refused rather than
 * silently preferring one of the two dates.
 */
async function resolveManufacturingBatch(
  db: ScopedDb,
  scope: ReceivingScope,
  input: {
    medicineId: string;
    batchNumber: string;
    printedExpiry: Date;
    expiryPrecision: 'DAY' | 'MONTH';
  }
) {
  const expiresAt = expiryInstant(input.printedExpiry, input.expiryPrecision);
  const existing = await db.pharmacyManufacturingBatch.findFirst({
    where: {
      organizationId: scope.organizationId,
      medicineId: input.medicineId,
      batchNumber: input.batchNumber,
    },
  });
  if (existing) {
    if (existing.expiresAt.getTime() !== expiresAt.getTime()) {
      throw new PharmacyReceivingError('BATCH_EXPIRY_CONFLICT');
    }
    return existing;
  }
  return db.pharmacyManufacturingBatch.create({
    data: {
      organizationId: scope.organizationId,
      medicineId: input.medicineId,
      batchNumber: input.batchNumber,
      expiresAt,
      expiryPrecision: input.expiryPrecision,
    },
  });
}

/**
 * The order leg of the three-way match, with the quantity already booked
 * against this order line by *other* posted receipts — so partial deliveries
 * accumulate instead of each one reporting the full shortage again.
 */
async function orderedTermsFor(
  db: ScopedDb,
  scope: ReceivingScope,
  purchaseOrderLineId: string | null,
  currentReceiptId: string
): Promise<OrderedTerms | null> {
  if (!purchaseOrderLineId) return null;
  const orderLine = await db.pharmacyPurchaseOrderLine.findFirst({
    where: { id: purchaseOrderLineId, organizationId: scope.organizationId },
  });
  if (!orderLine) throw new PharmacyReceivingError('CROSS_TENANT_REFERENCE');

  const earlier = await db.pharmacyGoodsReceiptLine.findMany({
    where: {
      organizationId: scope.organizationId,
      purchaseOrderLineId,
      goodsReceiptId: { not: currentReceiptId },
      goodsReceipt: { status: 'POSTED' },
    },
    select: { receivedCanonicalUnits: true, bonusCanonicalUnits: true },
  });

  return {
    canonicalUnitsPerPack: orderLine.canonicalUnitsPerPack,
    orderedCanonicalUnits: orderLine.orderedCanonicalUnits,
    bonusCanonicalUnits: orderLine.bonusCanonicalUnits,
    listPricePerPackMinor: orderLine.listPricePerPackMinor,
    previouslyReceivedUnits: earlier.reduce(
      (total, line) => total + line.receivedCanonicalUnits + line.bonusCanonicalUnits,
      0
    ),
  };
}

export type ReverseGoodsReceiptResult = {
  goodsReceiptId: string;
  reversedAt: Date;
  /** One compensating movement per posting, each linked to what it cancels. */
  reversalMovementIds: readonly string[];
};

/**
 * PUR-04 acceptance: "reversal creates linked movements/postings".
 *
 * Nothing about the original receipt is rewritten. Its lines, its lot and its
 * movements stay exactly as posted; what changes is that a negating ADJUSTMENT
 * now names each of them, and the receipt itself moves to REVERSED with an
 * actor and a reason. If the stock has already moved on, the ledger's
 * non-negative balance refuses the reversal rather than inventing a negative
 * shelf (§8A invariant 6) — the operator has to write off or return instead.
 *
 * Open exceptions are deliberately left open: a shortage that was really
 * reported is still a fact about the delivery after the paperwork is undone,
 * and closing it silently would hide it.
 *
 * Must run inside the caller's transaction.
 */
export async function reverseGoodsReceipt(
  db: ScopedDb,
  scope: ReceivingScope,
  input: { goodsReceiptId: string; reason: string; at: Date }
): Promise<ReverseGoodsReceiptResult> {
  if (input.reason.trim().length === 0) {
    throw new PharmacyReceivingError('BYPASS_EVIDENCE_MISSING');
  }
  const receipt = await db.pharmacyGoodsReceipt.findFirst({
    where: { id: input.goodsReceiptId, organizationId: scope.organizationId },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
  if (!receipt) throw new PharmacyReceivingError('NOT_FOUND');
  if (receipt.branchId !== scope.branchId) {
    throw new PharmacyReceivingError('CROSS_BRANCH_REFERENCE');
  }
  assertGoodsReceiptTransition(receipt.status, 'REVERSED');

  // The keys are derived, not stored, so this finds precisely the movements
  // this receipt posted and nothing that happened to the lot afterwards.
  const keys = receipt.lines.flatMap((line) => [acceptedKey(line.id), quarantineKey(line.id)]);
  const posted = await db.pharmacyStockMovement.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      idempotencyKey: { in: keys },
    },
    orderBy: { idempotencyKey: 'asc' },
    select: { id: true },
  });
  if (posted.length === 0) throw new PharmacyInventoryError('NOT_FOUND');

  const reversals = await reverseMovements(db, scope, {
    movementIds: posted.map((movement) => movement.id),
    reason: input.reason,
    at: input.at,
  });

  await db.pharmacyGoodsReceipt.update({
    where: { id: receipt.id },
    data: {
      status: 'REVERSED',
      reversedAt: input.at,
      reversedByUserId: scope.actorId,
      reversalReason: input.reason,
    },
  });

  return {
    goodsReceiptId: receipt.id,
    reversedAt: input.at,
    reversalMovementIds: reversals.map((movement) => movement.id),
  };
}

/**
 * PUR-04: an exception is closed by a named actor with a note, or it stays
 * open. There is no third option — which is what "visible until resolved"
 * means in practice.
 */
export async function resolveReceivingException(
  db: ScopedDb,
  scope: ReceivingScope,
  input: { receivingExceptionId: string; resolutionNote: string; at: Date }
) {
  if (input.resolutionNote.trim().length === 0) {
    throw new PharmacyReceivingError('BYPASS_EVIDENCE_MISSING');
  }
  const exception = await db.pharmacyReceivingException.findFirst({
    where: { id: input.receivingExceptionId, organizationId: scope.organizationId },
  });
  if (!exception) throw new PharmacyReceivingError('NOT_FOUND');
  if (exception.branchId !== scope.branchId) {
    throw new PharmacyReceivingError('CROSS_BRANCH_REFERENCE');
  }
  if (exception.status !== 'OPEN') throw new PharmacyReceivingError('INVALID_TRANSITION');

  return db.pharmacyReceivingException.update({
    where: { id: exception.id },
    data: {
      status: 'RESOLVED',
      resolvedAt: input.at,
      resolvedByUserId: scope.actorId,
      resolutionNote: input.resolutionNote,
    },
  });
}

/**
 * PUR-04: the queue. Open by default, because an exception that has scrolled
 * out of a filtered view is not visible in any sense the acceptance criterion
 * would recognise.
 */
export function listReceivingExceptions(
  db: ScopedDb,
  scope: Pick<ReceivingScope, 'organizationId' | 'branchId'>,
  filter: { status?: 'OPEN' | 'RESOLVED'; goodsReceiptId?: string } = {}
) {
  return db.pharmacyReceivingException.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: filter.status ?? 'OPEN',
      ...(filter.goodsReceiptId ? { goodsReceiptId: filter.goodsReceiptId } : {}),
    },
    orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }],
  });
}
