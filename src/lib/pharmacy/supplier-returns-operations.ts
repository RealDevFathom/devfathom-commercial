/**
 * PH-PUR / PUR-06 — purchase returns and expiry claims against the append-only
 * ledger, with debit notes, supplier credit and settlement allocation.
 *
 * THE ONE MECHANISM. A claimed quantity is held by exactly one thing: the INV-09
 * `PharmacySupplierClaim` reservation that `stock-ledger.loadCandidates` already
 * subtracts from every allocation candidate. Nothing here invents a second
 * counter, so "a claimed quantity cannot be sold" and "a claimed quantity cannot
 * be claimed twice" are the same subtraction read two ways and cannot drift
 * apart.
 *
 * WHERE STOCK ACTUALLY MOVES. Only `dispatchPurchaseReturn` posts movements, and
 * it posts a matched pair — AVAILABLE out, RETURN_TO_SUPPLIER in — so the units
 * never leave the ledger and the claim stays reconcilable afterwards (§8A
 * invariant 8). A DRAFT return touches neither stock nor a reservation, which is
 * what makes it safe as a PUR-07 one-click action (§8A invariant 29).
 *
 * CONCURRENCY. `submitPurchaseReturn` locks the lot's AVAILABLE balance rows
 * FOR UPDATE before it measures what is still claimable, so two clerks claiming
 * the same last units serialize and the loser is refused rather than both
 * succeeding against a stale read.
 */
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import type { LedgerScope } from './stock-ledger';
import {
  assertAllocatable,
  assertClaimable,
  assertPurchaseReturnTransition,
  assertReturnWindowOpen,
  assertSettlementSegregation,
  creditPosition,
  expectedCreditForLines,
  PharmacySupplierReturnError,
} from './supplier-returns';
import type { CreditPosition, PurchaseReturnStatus } from './supplier-returns';

export type PurchaseReturnKind = 'PURCHASE_RETURN' | 'EXPIRY_CLAIM';

export type CreatePurchaseReturnInput = {
  supplierId: string;
  kind: PurchaseReturnKind;
  reference: string;
  note?: string;
  lines: ReadonlyArray<{
    inventoryLotId: string;
    stockLocationId: string;
    quantityUnits: number;
    reason: string;
    returnWindowEndsAt: Date;
    expectedCreditMinor: number;
  }>;
};

/**
 * Open a DRAFT return or expiry claim. Deliberately does not reserve: a draft is
 * a statement of intent, and PUR-07 must be able to produce one without touching
 * inventory.
 */
export async function createPurchaseReturn(
  db: ScopedDb,
  scope: LedgerScope,
  input: CreatePurchaseReturnInput
) {
  if (input.lines.length === 0) throw new PharmacySupplierReturnError('INVALID_QUANTITY');
  const supplier = await db.pharmacySupplier.findFirst({
    where: { id: input.supplierId, organizationId: scope.organizationId },
  });
  if (!supplier) throw new PharmacySupplierReturnError('CROSS_TENANT_REFERENCE');

  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.quantityUnits) || line.quantityUnits <= 0) {
      throw new PharmacySupplierReturnError('INVALID_QUANTITY');
    }
    const [lot, location] = await Promise.all([
      db.pharmacyInventoryLot.findFirst({
        where: {
          id: line.inventoryLotId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
      }),
      db.pharmacyStockLocation.findFirst({
        where: {
          id: line.stockLocationId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
      }),
    ]);
    if (!lot || !location) throw new PharmacySupplierReturnError('CROSS_BRANCH_REFERENCE');
  }

  const created = await db.pharmacyPurchaseReturn.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      supplierId: input.supplierId,
      kind: input.kind,
      reference: input.reference,
      note: input.note,
      createdByUserId: scope.actorId,
    },
  });
  await db.pharmacyPurchaseReturnLine.createMany({
    data: input.lines.map((line, index) => ({
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      purchaseReturnId: created.id,
      lineNumber: index + 1,
      inventoryLotId: line.inventoryLotId,
      stockLocationId: line.stockLocationId,
      quantityUnits: line.quantityUnits,
      reason: line.reason,
      returnWindowEndsAt: line.returnWindowEndsAt,
      expectedCreditMinor: line.expectedCreditMinor,
    })),
  });
  return db.pharmacyPurchaseReturn.findFirstOrThrow({
    where: { id: created.id },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
}

async function loadReturn(db: ScopedDb, scope: LedgerScope, purchaseReturnId: string) {
  const found = await db.pharmacyPurchaseReturn.findFirst({
    where: {
      id: purchaseReturnId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
  if (!found) throw new PharmacySupplierReturnError('CROSS_BRANCH_REFERENCE');
  return found;
}

type LockedLotRow = {
  onHandUnits: number;
  reservedUnits: number;
  unitsPerPack: number;
};

/**
 * Lock every AVAILABLE balance row of one lot and return the lot-level on-hand
 * and reserved totals. Lot-level, not location-level, because an INV-09
 * reservation is held against the lot — measuring claimability per location
 * would let the same units be claimed once from each location they sit in.
 */
async function lockLotForClaim(
  db: ScopedDb,
  scope: LedgerScope,
  inventoryLotId: string
): Promise<LockedLotRow | null> {
  const rows = await db.$queryRaw<Array<{ onHandUnits: number; unitsPerPack: number }>>(
    Prisma.sql`
      SELECT balance."onHandUnits" AS "onHandUnits", lot."unitsPerPack" AS "unitsPerPack"
      FROM "pharmacy_stock_balances" balance
      JOIN "pharmacy_inventory_lots" lot
        ON lot."id" = balance."inventoryLotId" AND lot."organizationId" = balance."organizationId"
      WHERE balance."organizationId" = ${scope.organizationId}
        AND balance."branchId" = ${scope.branchId}
        AND balance."inventoryLotId" = ${inventoryLotId}
        AND balance."disposition" = 'AVAILABLE'
      ORDER BY balance."stockLocationId" ASC
      FOR UPDATE OF balance`
  );
  if (rows.length === 0) return null;
  const reserved = await db.pharmacySupplierClaim.aggregate({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId,
      status: 'RESERVED',
    },
    _sum: { reservedUnits: true },
  });
  return {
    onHandUnits: rows.reduce((total, row) => total + Number(row.onHandUnits), 0),
    reservedUnits: reserved._sum.reservedUnits ?? 0,
    unitsPerPack: Number(rows[0]!.unitsPerPack),
  };
}

/**
 * Take the INV-09 reservation for every line and move the return to SUBMITTED.
 * From here the claimed quantity is invisible to sale allocation and to any
 * further claim.
 */
export async function submitPurchaseReturn(
  db: ScopedDb,
  scope: LedgerScope,
  input: { purchaseReturnId: string; at: Date }
) {
  const found = await loadReturn(db, scope, input.purchaseReturnId);
  assertPurchaseReturnTransition(found.status as PurchaseReturnStatus, 'SUBMITTED');

  for (const line of found.lines) {
    assertReturnWindowOpen({ returnWindowEndsAt: line.returnWindowEndsAt, at: input.at });
    const locked = await lockLotForClaim(db, scope, line.inventoryLotId);
    if (!locked) throw new PharmacySupplierReturnError('ALREADY_CLAIMED');
    assertClaimable({
      onHandUnits: locked.onHandUnits,
      reservedUnits: locked.reservedUnits,
      requestedUnits: line.quantityUnits,
    });
    const claim = await db.pharmacySupplierClaim.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        inventoryLotId: line.inventoryLotId,
        reservedUnits: line.quantityUnits,
        returnBy: line.returnWindowEndsAt,
        createdById: scope.actorId,
      },
    });
    await db.pharmacyPurchaseReturnLine.update({
      where: { id: line.id },
      data: { supplierClaimId: claim.id },
    });
  }

  return db.pharmacyPurchaseReturn.update({
    where: { id: found.id },
    data: {
      status: 'SUBMITTED',
      submittedAt: input.at,
      submittedByUserId: scope.actorId,
    },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
}

/**
 * The physical arrangement to remove from one location. Loose units go first so
 * a sealed pack is never notionally broken by a removal that did not break one
 * (§8A invariant 17).
 */
async function removalArrangement(
  db: ScopedDb,
  scope: LedgerScope,
  inventoryLotId: string,
  stockLocationId: string,
  units: number,
  unitsPerPack: number
) {
  const balance = await db.pharmacyStockBalance.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId,
      stockLocationId,
      disposition: 'AVAILABLE',
    },
  });
  if (!balance || balance.onHandUnits < units) {
    throw new PharmacySupplierReturnError('INVALID_QUANTITY');
  }
  const looseUnits = Math.min(balance.looseUnits, units);
  const sealedUnits = units - looseUnits;
  if (sealedUnits % unitsPerPack !== 0) throw new PharmacySupplierReturnError('INVALID_QUANTITY');
  return { sealedPacks: sealedUnits / unitsPerPack, looseUnits };
}

/**
 * Post the return. Each line becomes a matched movement pair in the same lot and
 * location: out of AVAILABLE, into RETURN_TO_SUPPLIER. The reservation is then
 * marked SUBMITTED — the units have physically left AVAILABLE, so leaving the
 * claim RESERVED would subtract them a second time from every later allocation.
 */
export async function dispatchPurchaseReturn(
  db: ScopedDb,
  scope: LedgerScope,
  input: { purchaseReturnId: string; at: Date; idempotencyKeyPrefix: string }
) {
  const found = await loadReturn(db, scope, input.purchaseReturnId);
  assertPurchaseReturnTransition(found.status as PurchaseReturnStatus, 'DISPATCHED');

  for (const [index, line] of found.lines.entries()) {
    const lot = await db.pharmacyInventoryLot.findFirst({
      where: {
        id: line.inventoryLotId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
      },
    });
    if (!lot) throw new PharmacySupplierReturnError('CROSS_BRANCH_REFERENCE');
    const arrangement = await removalArrangement(
      db,
      scope,
      line.inventoryLotId,
      line.stockLocationId,
      line.quantityUnits,
      lot.unitsPerPack
    );
    // ADJUSTMENT on both legs, exactly as `quarantinePart` does: this is a
    // disposition move within one lot and location, and the ledger's direction
    // CHECK requires a RETURN movement to be positive, so the outgoing leg could
    // not be a RETURN even though that is what the document is called. The
    // meaning lives in the disposition, which is where every reader of the
    // balance projection looks for it.
    const common = {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: line.inventoryLotId,
      stockLocationId: line.stockLocationId,
      kind: 'ADJUSTMENT' as const,
      actorId: scope.actorId,
      reason: line.reason,
      occurredAt: input.at,
    };
    await db.pharmacyStockMovement.create({
      data: {
        ...common,
        disposition: 'AVAILABLE',
        quantityUnits: -line.quantityUnits,
        sealedPackDelta: -arrangement.sealedPacks,
        looseUnitDelta: -arrangement.looseUnits,
        idempotencyKey: `${input.idempotencyKeyPrefix}:${index}:out`,
      },
    });
    await db.pharmacyStockMovement.create({
      data: {
        ...common,
        disposition: 'RETURN_TO_SUPPLIER',
        quantityUnits: line.quantityUnits,
        sealedPackDelta: arrangement.sealedPacks,
        looseUnitDelta: arrangement.looseUnits,
        idempotencyKey: `${input.idempotencyKeyPrefix}:${index}:returned`,
      },
    });
    if (line.supplierClaimId) {
      await db.pharmacySupplierClaim.update({
        where: { id: line.supplierClaimId },
        data: { status: 'SUBMITTED' },
      });
    }
  }

  return db.pharmacyPurchaseReturn.update({
    where: { id: found.id },
    data: {
      status: 'DISPATCHED',
      dispatchedAt: input.at,
      dispatchedByUserId: scope.actorId,
    },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
}

/**
 * Raise the debit note for a dispatched return. Its expected credit is frozen
 * from the return lines, so what the pharmacy claimed stays legible even after
 * the supplier has paid something different.
 */
export async function issueDebitNote(
  db: ScopedDb,
  scope: LedgerScope,
  input: { purchaseReturnId: string; reference: string; at: Date }
) {
  const found = await loadReturn(db, scope, input.purchaseReturnId);
  if (found.status !== 'DISPATCHED') throw new PharmacySupplierReturnError('INVALID_TRANSITION');
  return db.pharmacyDebitNote.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      supplierId: found.supplierId,
      purchaseReturnId: found.id,
      reference: input.reference,
      expectedCreditMinor: expectedCreditForLines(found.lines),
      issuedByUserId: scope.actorId,
      issuedAt: input.at,
    },
  });
}

/** Record a credit note the supplier actually issued. Append-only from here. */
export async function recordSupplierCredit(
  db: ScopedDb,
  scope: LedgerScope,
  input: { supplierId: string; reference: string; amountMinor: number; receivedAt: Date }
) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new PharmacySupplierReturnError('INVALID_MONEY');
  }
  const supplier = await db.pharmacySupplier.findFirst({
    where: { id: input.supplierId, organizationId: scope.organizationId },
  });
  if (!supplier) throw new PharmacySupplierReturnError('CROSS_TENANT_REFERENCE');
  return db.pharmacySupplierCredit.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      supplierId: input.supplierId,
      reference: input.reference,
      amountMinor: input.amountMinor,
      receivedAt: input.receivedAt,
      recordedByUserId: scope.actorId,
    },
  });
}

/**
 * Settle part or all of a debit note from a recorded credit. The two ceilings —
 * the credit's unallocated remainder and the note's outstanding balance — are
 * both enforced, and the actor who submitted the return may not be the one
 * closing the money on it (§8A invariant 26).
 */
export async function allocateSupplierCredit(
  db: ScopedDb,
  scope: LedgerScope,
  input: { supplierCreditId: string; debitNoteId: string; amountMinor: number; at: Date }
) {
  // Both rows are ceilings for the allocation. Lock them before reading either
  // balance so allocations sharing a credit or a note cannot validate against
  // the same stale remainder. The fixed credit-then-note order also prevents
  // competing allocations from acquiring these locks in opposite orders.
  const lockedCredits = await db.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM pharmacy_supplier_credits
      WHERE id = ${input.supplierCreditId}
        AND "organizationId" = ${scope.organizationId}
        AND "branchId" = ${scope.branchId}
      FOR UPDATE`
  );
  if (lockedCredits.length === 0) throw new PharmacySupplierReturnError('NOT_FOUND');

  const lockedNotes = await db.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM pharmacy_debit_notes
      WHERE id = ${input.debitNoteId}
        AND "organizationId" = ${scope.organizationId}
        AND "branchId" = ${scope.branchId}
      FOR UPDATE`
  );
  if (lockedNotes.length === 0) throw new PharmacySupplierReturnError('NOT_FOUND');

  const [credit, note] = await Promise.all([
    db.pharmacySupplierCredit.findFirst({
      where: {
        id: input.supplierCreditId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
      },
    }),
    db.pharmacyDebitNote.findFirst({
      where: {
        id: input.debitNoteId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
      },
      include: { allocations: true, purchaseReturn: true },
    }),
  ]);
  if (!credit || !note) throw new PharmacySupplierReturnError('NOT_FOUND');
  if (credit.supplierId !== note.supplierId) {
    throw new PharmacySupplierReturnError('CROSS_TENANT_REFERENCE');
  }
  if (note.status === 'CANCELLED') throw new PharmacySupplierReturnError('INVALID_TRANSITION');
  if (note.purchaseReturn.submittedByUserId) {
    assertSettlementSegregation({
      submittedByUserId: note.purchaseReturn.submittedByUserId,
      allocatedByUserId: scope.actorId,
    });
  }

  const creditAllocated = await db.pharmacySupplierCreditAllocation.aggregate({
    where: { organizationId: scope.organizationId, supplierCreditId: credit.id },
    _sum: { amountMinor: true },
  });
  const position = creditPosition({
    expectedCreditMinor: note.expectedCreditMinor,
    allocations: note.allocations,
  });
  assertAllocatable({
    amountMinor: input.amountMinor,
    creditAmountMinor: credit.amountMinor,
    creditAlreadyAllocatedMinor: creditAllocated._sum.amountMinor ?? 0,
    noteExpectedCreditMinor: note.expectedCreditMinor,
    noteAlreadyReceivedMinor: position.receivedCreditMinor,
  });

  const allocation = await db.pharmacySupplierCreditAllocation.create({
    data: {
      organizationId: scope.organizationId,
      supplierCreditId: credit.id,
      debitNoteId: note.id,
      amountMinor: input.amountMinor,
      allocatedByUserId: scope.actorId,
    },
  });
  const settled = creditPosition({
    expectedCreditMinor: note.expectedCreditMinor,
    allocations: [...note.allocations, allocation],
  });
  const updatedNote = await db.pharmacyDebitNote.update({
    where: { id: note.id },
    data: { status: settled.status },
  });
  if (settled.status === 'SETTLED') {
    assertPurchaseReturnTransition(note.purchaseReturn.status as PurchaseReturnStatus, 'SETTLED');
    await db.pharmacyPurchaseReturn.update({
      where: { id: note.purchaseReturnId },
      data: { status: 'SETTLED', settledAt: input.at },
    });
  }
  return { allocation, debitNote: updatedNote, position: settled };
}

export type DebitNotePosition = CreditPosition & {
  debitNoteId: string;
  reference: string;
  supplierId: string;
  purchaseReturnId: string;
};

/**
 * PUR-06 acceptance: expected vs received credit, visible side by side. The two
 * figures come from different tables — the frozen claim on the note, the sum of
 * what the supplier allocated beneath it — so neither can silently become the
 * other.
 */
export async function debitNotePositions(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  filter: { supplierId?: string } = {}
): Promise<DebitNotePosition[]> {
  const notes = await db.pharmacyDebitNote.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
    },
    include: { allocations: true },
    orderBy: { issuedAt: 'asc' },
  });
  return notes.map((note) => ({
    debitNoteId: note.id,
    reference: note.reference,
    supplierId: note.supplierId,
    purchaseReturnId: note.purchaseReturnId,
    ...creditPosition({
      expectedCreditMinor: note.expectedCreditMinor,
      allocations: note.allocations,
      cancelled: note.status === 'CANCELLED',
    }),
  }));
}
