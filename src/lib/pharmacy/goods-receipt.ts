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
import {
  appendControlledPurchaseEntries,
  appendControlledPurchaseReversals,
  assignedRegisterBranchIds,
  lockRegister,
} from './controlled-register';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';

import { PharmacyInventoryError } from './inventory';
import {
  authorizeControlledRestoration,
  ControlledRestorationDenied,
  SOLO_PHARMACIST_WITNESS_POLICY,
  type ControlledRestorationPin,
} from './controlled-restoration-authorization';
import {
  assertGoodsReceiptTransition,
  assertSaleableOnReceipt,
  matchReceiptLine,
  PharmacyReceivingError,
  type MatchException,
  type OrderedTerms,
} from './receiving';
import { nearExpiryWarning, packIsExpired } from './gs1-datamatrix';
import { assertSupplierEligible } from './purchasing';
import {
  readSupplierCompliancePolicy,
  recordSupplierComplianceSkip,
  strictLicenceEvidence,
} from './supplier-compliance-policy';
import {
  expiryInstant,
  normalizeExpiryBoundary,
  receiveLot,
  reverseMovements,
} from './stock-ledger';
import type { LedgerScope } from './stock-ledger';
import { acceptedKey, goodsReceiptMovementKeys, quarantineKey } from './goods-receipt-keys';
import {
  PharmacyFinanceError,
  postGoodsReceiptEntry,
  reversePostingForSource,
} from './finance-postings';

export type ReceivingScope = LedgerScope;

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

/** Lock and validate a PO for the full transaction that creates its receipt. */
export async function lockReceivablePurchaseOrder(
  db: ScopedDb,
  scope: ReceivingScope,
  input: { purchaseOrderId: string; supplierId: string }
) {
  await db.$queryRaw`SELECT id FROM pharmacy_purchase_orders WHERE id=${input.purchaseOrderId} AND "organizationId"=${scope.organizationId} FOR UPDATE`;
  const order = await db.pharmacyPurchaseOrder.findFirst({
    where: {
      id: input.purchaseOrderId,
      organizationId: scope.organizationId,
      supplierId: input.supplierId,
    },
  });
  if (!order) throw new PharmacyReceivingError('CROSS_TENANT_REFERENCE');
  // A null branch denotes an organization-wide order; its receipts still
  // belong to the branch receiving the delivery.
  if (order.branchId !== null && order.branchId !== scope.branchId) {
    throw new PharmacyReceivingError('CROSS_BRANCH_REFERENCE');
  }
  if (order.status !== 'SENT' && order.status !== 'RECEIVING') {
    throw new PharmacyReceivingError('INVALID_TRANSITION');
  }
  return order;
}

export async function postGoodsReceipt(
  db: ScopedDb,
  scope: ReceivingScope,
  input: { goodsReceiptId: string; at: Date; staffProfileId?: string; pin?: string }
): Promise<PostGoodsReceiptResult> {
  // Serialize posting with every other receipt transition before reading its
  // state. The linked order is locked below, before any inventory write.
  await db.$queryRaw`SELECT id FROM pharmacy_goods_receipts WHERE id=${input.goodsReceiptId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`;
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
  let purchaseOrder: {
    id: string;
    branchId: string | null;
    supplierId: string;
    status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'SENT' | 'RECEIVING' | 'CANCELLED';
  } | null = null;
  if (receipt.purchaseOrderId) {
    const [lockedOrder] = await db.$queryRaw<
      Array<{
        id: string;
        branchId: string | null;
        supplierId: string;
        status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'SENT' | 'RECEIVING' | 'CANCELLED';
      }>
    >`SELECT id, "branchId", "supplierId", status FROM pharmacy_purchase_orders WHERE id=${receipt.purchaseOrderId} AND "organizationId"=${scope.organizationId} FOR UPDATE`;
    purchaseOrder = lockedOrder ?? null;
    if (!purchaseOrder) throw new PharmacyReceivingError('CROSS_TENANT_REFERENCE');
    if (purchaseOrder.supplierId !== receipt.supplierId) {
      throw new PharmacyReceivingError('CROSS_TENANT_REFERENCE');
    }
    if (purchaseOrder.branchId !== null && purchaseOrder.branchId !== scope.branchId) {
      throw new PharmacyReceivingError('CROSS_BRANCH_REFERENCE');
    }
    if (purchaseOrder.status !== 'SENT' && purchaseOrder.status !== 'RECEIVING') {
      throw new PharmacyReceivingError('INVALID_TRANSITION');
    }
  }

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

  // PUR-01 / DEV-753: the owner's supplier-compliance policy at the moment of
  // posting, under a share lock so a concurrent owner change waits for this
  // posting to commit. Supersession is read strictly across the register (DEV-466).
  // The policy covers supplier licence and authorization only, for every medicine. The
  // controlled-drug witness PIN and register above are independent and never read it.
  const supplierCompliance = await readSupplierCompliancePolicy(db, scope.organizationId, {
    lock: 'share',
  });
  const supplierEvidence = {
    authorized: receipt.supplier.authorized,
    licences: await strictLicenceEvidence(db, scope.organizationId, receipt.supplier.licences),
  };

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
      supplier: supplierEvidence,
      supplierCompliance,
      at: input.at,
    });
  }
  // With the checks off the receipt posts unchecked on supplier licence and trade
  // authorization only; it says so, immutably, in this same transaction.
  const supplierOutcome = assertSupplierEligible({
    ...supplierEvidence,
    at: input.at,
    policy: supplierCompliance,
  });
  if (!supplierOutcome.checked) {
    await recordSupplierComplianceSkip(db, scope, {
      operation: 'GOODS_RECEIPT_POST',
      supplierId: receipt.supplierId,
      goodsReceiptId: receipt.id,
      purchaseOrderId: receipt.purchaseOrderId,
      reference: receipt.reference,
      outcome: supplierOutcome,
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
      // The receipt keeps the calendar date keyed on it (UTC midnight). Stock being posted is
      // on hand now, so the lot is never received later than the posting instant: a GRN keyed
      // at 01:30 PKT for today's Karachi date must be sellable at once, not from 05:00 PKT.
      receivedAt: receipt.receivedAt > input.at ? input.at : receipt.receivedAt,
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

    // DEV-752: one order line may arrive as several lots on this receipt. The
    // quantity leg is cumulative across them and judged once, on the last lot,
    // so lots neither hide an over-receipt nor each report a false shortage.
    const siblings = line.purchaseOrderLineId
      ? receipt.lines.filter((other) => other.purchaseOrderLineId === line.purchaseOrderLineId)
      : [];
    const earlierOnReceipt = siblings
      .filter((other) => other.lineNumber < line.lineNumber)
      .reduce(
        (total, other) => total + other.receivedCanonicalUnits + other.bonusCanonicalUnits,
        0
      );
    const earlierBonusOnReceipt = siblings
      .filter((other) => other.lineNumber < line.lineNumber)
      .reduce((total, other) => total + other.bonusCanonicalUnits, 0);
    const lastLotOfOrderLine = !siblings.some((other) => other.lineNumber > line.lineNumber);
    const terms = await orderedTermsFor(db, scope, line.purchaseOrderLineId, receipt.id);
    for (const exception of matchReceiptLine({
      ordered: terms
        ? {
            ...terms,
            previouslyReceivedUnits: terms.previouslyReceivedUnits + earlierOnReceipt,
            previouslyReceivedBonusUnits:
              (terms.previouslyReceivedBonusUnits ?? 0) + earlierBonusOnReceipt,
          }
        : null,
      received: {
        canonicalUnitsPerPack: line.canonicalUnitsPerPack,
        arrivedCanonicalUnits: line.receivedCanonicalUnits + line.bonusCanonicalUnits,
        rejectedCanonicalUnits: line.rejectedCanonicalUnits,
        rejectionReason: line.rejectionReason,
        invoicedPricePerPackMinor: line.invoicedPricePerPackMinor,
        bonusCanonicalUnits: line.bonusCanonicalUnits,
        receivedAt: receipt.receivedAt,
      },
    }).filter(
      (exception) =>
        lastLotOfOrderLine ||
        (exception.kind !== 'SHORTAGE' &&
          exception.kind !== 'OVERAGE' &&
          exception.kind !== 'BONUS_SHORTAGE' &&
          exception.kind !== 'SCHEME_EXPIRED')
    )) {
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

  // FIN-01: the inventory the receipt just shelved and what is now owed for it
  // are journalled in this same transaction, so GL inventory never trails the
  // stock ledger. A receipt whose every unit was rejected without quarantine
  // shelved nothing of value and has nothing to journal.
  try {
    await postGoodsReceiptEntry(db, scope, { goodsReceiptId: receipt.id, at: input.at });
  } catch (error) {
    if (!(error instanceof PharmacyFinanceError && error.reason === 'NOTHING_TO_POST')) throw error;
  }

  // PUR-02: the order is now being received against. SENT → RECEIVING is the
  // last transition of that status machine, so a second receipt against the
  // same order finds it already there and leaves it alone.
  if (receipt.purchaseOrderId) {
    if (purchaseOrder?.status === 'SENT') {
      const transitioned = await db.pharmacyPurchaseOrder.updateMany({
        where: {
          id: purchaseOrder.id,
          organizationId: scope.organizationId,
          status: 'SENT',
        },
        data: { status: 'RECEIVING' },
      });
      if (transitioned.count !== 1) throw new PharmacyReceivingError('INVALID_TRANSITION');
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
    if (
      normalizeExpiryBoundary(existing.expiresAt).getTime() !==
      normalizeExpiryBoundary(expiresAt).getTime()
    ) {
      throw new PharmacyReceivingError('BATCH_EXPIRY_CONFLICT');
    }
    return { ...existing, expiresAt };
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
    include: { purchaseOrder: { select: { quote: { select: { validUntil: true } } } } },
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
    previouslyReceivedBonusUnits: earlier.reduce(
      (total, line) => total + line.bonusCanonicalUnits,
      0
    ),
    // The scheme comes from the distributor quote the order was raised from.
    schemeValidUntil: orderLine.purchaseOrder?.quote?.validUntil ?? null,
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
 * actor and a reason. If the stock has already moved on, the reversal is
 * refused with REVERSAL_STOCK_MOVED or REVERSAL_PACKS_OPENED rather than
 * inventing a negative shelf (§8A invariant 6) — the operator has to write off
 * or return instead.
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
  input: {
    goodsReceiptId: string;
    reason: string;
    at: Date;
    controlledWitness?: ControlledRestorationPin;
  }
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
  const keys = goodsReceiptMovementKeys(receipt.lines.map((line) => line.id));
  const posted = await db.pharmacyStockMovement.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      idempotencyKey: { in: keys },
    },
    orderBy: { idempotencyKey: 'asc' },
    select: {
      id: true,
      inventoryLotId: true,
      stockLocationId: true,
      disposition: true,
      quantityUnits: true,
      sealedPackDelta: true,
      looseUnitDelta: true,
    },
  });
  if (posted.length === 0) throw new PharmacyInventoryError('NOT_FOUND');

  const controlled = await db.pharmacyControlledRegisterEntry.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      entryKind: 'PURCHASE',
      stockMovementId: { in: posted.map((movement) => movement.id) },
    },
    select: { id: true },
  });
  let witness;
  if (controlled) {
    const assigned = await assignedRegisterBranchIds(db, scope.organizationId, scope.actorId);
    const branch = await db.pharmacyBranch.findFirst({
      where: { organizationId: scope.organizationId, id: scope.branchId, active: true },
      select: { id: true },
    });
    if (!assigned.includes(scope.branchId) || !branch) throw new ControlledRestorationDenied(true);
    witness = await authorizeControlledRestoration(
      db,
      scope,
      input.controlledWitness,
      'pharmacy:safety',
      { allowSoloSelfWitness: true }
    );
    if (witness.soloSelfWitness) {
      // Solo-pharmacy rule: the self-witness is lawful only with this record,
      // written in the same transaction as the reversal it authorizes.
      await db.auditLog.create({
        data: {
          organizationId: scope.organizationId,
          actorId: scope.actorId,
          actorType: 'USER',
          source: 'TRPC',
          category: 'PHARMACY_PURCHASING',
          operation: 'OTHER',
          action: 'pharmacy.controlledReceiptReversalSelfWitness',
          targetType: 'PharmacyGoodsReceipt',
          targetId: receipt.id,
          metadata: {
            policy: SOLO_PHARMACIST_WITNESS_POLICY,
            pinVerified: true,
            branchId: scope.branchId,
            signatureRef: witness.signatureRef,
          },
        },
      });
    }
    // Dispensing takes the branch register lock before any stock balance lock.
    // Use the same order even when a receipt has multiple movements to reverse.
    await lockRegister(db, scope.organizationId, scope.branchId);
  }

  await assertReceiptStockStillOnHand(db, scope, posted);

  // Reverse one movement, then write its register row, before the next one.
  // The register trigger checks each row's running balance against sellable
  // stock at insert time, so two posted lines landing on the same controlled
  // lot only reconcile if each correction is written right after its movement.
  const reversals: Awaited<ReturnType<typeof reverseMovements>> = [];
  for (const movement of posted) {
    reversals.push(
      ...(await reverseMovements(db, scope, {
        movementIds: [movement.id],
        reason: input.reason,
        at: input.at,
      }))
    );
    if (!controlled) continue;
    try {
      await appendControlledPurchaseReversals(db, {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        recordedByUserId: scope.actorId,
        reason: input.reason,
        reversedMovementIds: [movement.id],
        witness,
      });
    } catch (error) {
      // The register refuses when stock has moved on since posting; surface
      // that as a domain error instead of a generic server failure.
      if (error instanceof Error && (error.message === 'STOCK' || error.message === 'BALANCE')) {
        throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
      }
      throw error;
    }
  }

  await db.pharmacyGoodsReceipt.update({
    where: { id: receipt.id },
    data: {
      status: 'REVERSED',
      reversedAt: input.at,
      reversedByUserId: scope.actorId,
      reversalReason: input.reason,
    },
  });

  // FIN-01 / §8A invariant 15: the receipt's journal entry is negated by a new
  // linked entry, never edited. A receipt that journalled nothing (zero value,
  // or posted before receipts were journalled) has nothing to negate.
  try {
    await reversePostingForSource(db, scope, {
      sourceKind: 'PHARMACY_GOODS_RECEIPT',
      sourceId: receipt.id,
      reason: input.reason,
      at: input.at,
    });
  } catch (error) {
    if (!(error instanceof PharmacyFinanceError && error.reason === 'NOT_FOUND')) throw error;
  }

  return {
    goodsReceiptId: receipt.id,
    reversedAt: input.at,
    reversalMovementIds: reversals.map((movement) => movement.id),
  };
}

type PostedReceiptMovement = {
  inventoryLotId: string;
  stockLocationId: string;
  disposition: string;
  quantityUnits: number;
  sealedPackDelta: number;
  looseUnitDelta: number;
};

/**
 * PUR-04 / §8A invariant 6. A reversal is the exact negation of each receipt
 * movement at the same lot, location and disposition, so it is only possible
 * while that bucket still holds what the receipt put there. Check that first,
 * under the balance row locks, and refuse with a reason the operator can act
 * on instead of letting the non-negative CHECK surface as a server error.
 * The CHECK stays the backstop behind this.
 */
async function assertReceiptStockStillOnHand(
  db: ScopedDb,
  scope: ReceivingScope,
  movements: readonly PostedReceiptMovement[]
) {
  const needed = new Map<string, PostedReceiptMovement>();
  for (const movement of movements) {
    const key = `${movement.inventoryLotId}:${movement.stockLocationId}:${movement.disposition}`;
    const total = needed.get(key);
    needed.set(
      key,
      total
        ? {
            ...total,
            quantityUnits: total.quantityUnits + movement.quantityUnits,
            sealedPackDelta: total.sealedPackDelta + movement.sealedPackDelta,
            looseUnitDelta: total.looseUnitDelta + movement.looseUnitDelta,
          }
        : { ...movement }
    );
  }
  const buckets = [...needed.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, bucket]) => bucket);

  // Lock in a deterministic order, then read in a separate statement so the
  // read sees anything that committed while the lock was waited on.
  for (const bucket of buckets) {
    await db.$queryRaw`
      SELECT "inventoryLotId" FROM "pharmacy_stock_balances"
      WHERE "organizationId" = ${scope.organizationId}
        AND "inventoryLotId" = ${bucket.inventoryLotId}
        AND "stockLocationId" = ${bucket.stockLocationId}
        AND "disposition"::text = ${bucket.disposition}
      FOR UPDATE`;
  }
  const balances = await db.pharmacyStockBalance.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: { in: [...new Set(buckets.map((bucket) => bucket.inventoryLotId))] },
    },
    select: {
      inventoryLotId: true,
      stockLocationId: true,
      disposition: true,
      onHandUnits: true,
      sealedPacks: true,
      looseUnits: true,
    },
  });

  for (const bucket of buckets) {
    const balance = balances.find(
      (row) =>
        row.inventoryLotId === bucket.inventoryLotId &&
        row.stockLocationId === bucket.stockLocationId &&
        row.disposition === bucket.disposition
    );
    const onHand = balance?.onHandUnits ?? 0;
    if (onHand < bucket.quantityUnits) {
      throw new PharmacyReceivingError('REVERSAL_STOCK_MOVED');
    }
    if (
      (balance?.sealedPacks ?? 0) < bucket.sealedPackDelta ||
      (balance?.looseUnits ?? 0) < bucket.looseUnitDelta
    ) {
      throw new PharmacyReceivingError('REVERSAL_PACKS_OPENED');
    }
  }
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
