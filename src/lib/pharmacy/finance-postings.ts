/**
 * PH-FIN / PRD §6.8 FIN-01 — the pharmacy posting adapters.
 *
 * One adapter per operational event that exists in the pharmacy domain today.
 * Each reads the operational row, derives money from it, and posts ONE balanced
 * entry through the shared journal in `src/lib/finance/journal.ts`. There is no
 * pharmacy ledger: the journal is shared, and this file is the mapping onto it.
 *
 * THREE RULES THIS FILE EXISTS TO KEEP.
 *
 *   1. COST IS THE ALLOCATED LOT'S LANDED COST. Cost of goods sold is computed
 *      per allocation from `PharmacyInventoryLot.unitCostMinor` — the exact lot
 *      the FEFO allocator drew from — never from the sale line's
 *      `unitCostMinor`, which is a rounded per-sale-unit average and would
 *      misstate margin whenever one line draws from two lots at different
 *      costs (FIN-03 acceptance).
 *
 *   2. BONUS UNITS ARE QUANTITY, NEVER REVENUE. A receipt posts the invoiced
 *      money once, against however many units arrived. `unitCostMinor` already
 *      carries the invoice spread over received + bonus units (PUR-03), so free
 *      goods raise quantity and lower unit cost, and no revenue account appears
 *      anywhere in a receipt posting.
 *
 *   3. EVERY LEG CARRIES ITS DIMENSIONS. Revenue and discount use each
 *      allocation's immutable charged amounts so that every leg — revenue,
 *      discount and cost alike — names a branch, a product, a lot and the sale
 *      line it came from. That is what makes FIN-03's "margin by
 *      line/batch/product/branch" four groupings of one query instead of four
 *      report implementations.
 *
 * TRANSACTIONS. Every adapter writes an entry and its legs, and the entry is
 * unbalanced in between, so each must run inside the caller's transaction —
 * the same one that wrote the operational row.
 */
import type { FinanceSourceKind } from '@/generated/prisma/client';
import {
  postJournalEntry,
  reverseJournalEntry,
  type JournalLineInput,
} from '@/lib/finance/journal';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { saleAllocationMoney } from './sale-line-money';
export { apportion } from './sale-line-money';

export { FinancePostingError } from '@/lib/finance/journal';

export type PostingScope = {
  organizationId: string;
  branchId: string;
  actorId: string;
};

export class PharmacyFinanceError extends Error {
  constructor(
    readonly reason: 'NOT_FOUND' | 'CROSS_BRANCH_REFERENCE' | 'INVALID_STATE' | 'NOTHING_TO_POST'
  ) {
    super(reason);
    this.name = 'PharmacyFinanceError';
  }
}

/** Deterministic, so the same event posts once however often it is retried. */
function postingKey(sourceKind: FinanceSourceKind, sourceId: string): string {
  return `finance:${sourceKind}:${sourceId}`;
}

/** Drop zero-value legs. A zero leg is not a fact; it is a rounding artefact. */
function nonZero(lines: readonly JournalLineInput[]): JournalLineInput[] {
  return lines.filter((line) => line.amountMinor > 0);
}

/**
 * FIN-01 (receipt, bonus): the goods receipt posting.
 *
 * Accepted and quarantined units are BOTH inventory — quarantined stock is
 * owned, merely unsellable — so both are valued and both name the location they
 * physically sit in, which is what keeps the FIN-03 valuation per lot AND
 * location honest.
 */
export async function postGoodsReceiptEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { goodsReceiptId: string; at: Date }
) {
  const receipt = await db.pharmacyGoodsReceipt.findFirst({
    where: { id: input.goodsReceiptId, organizationId: scope.organizationId },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
  if (!receipt) throw new PharmacyFinanceError('NOT_FOUND');
  if (receipt.branchId !== scope.branchId) throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');
  if (receipt.status !== 'POSTED') throw new PharmacyFinanceError('INVALID_STATE');

  const lines: JournalLineInput[] = [];
  let accrued = BigInt(0);

  for (const line of receipt.lines) {
    if (!line.inventoryLotId) throw new PharmacyFinanceError('INVALID_STATE');
    const shelved = BigInt(line.unitCostMinor) * BigInt(line.acceptedCanonicalUnits);
    const held = BigInt(line.unitCostMinor) * BigInt(line.rejectedCanonicalUnits);

    lines.push(
      ...journalLegs(shelved, {
        accountCode: 'INVENTORY',
        side: 'DEBIT',
        branchId: receipt.branchId,
        productId: line.medicineId,
        lotId: line.inventoryLotId,
        locationId: line.stockLocationId,
        sourceLineId: line.id,
        memo: 'Accepted at receipt',
      })
    );
    if (held > BigInt(0) && line.quarantineLocationId) {
      lines.push(
        ...journalLegs(held, {
          accountCode: 'INVENTORY',
          side: 'DEBIT',
          branchId: receipt.branchId,
          productId: line.medicineId,
          lotId: line.inventoryLotId,
          locationId: line.quarantineLocationId,
          sourceLineId: line.id,
          memo: 'Quarantined at receipt',
        })
      );
    }
    accrued += shelved + (line.quarantineLocationId ? held : BigInt(0));
  }

  if (accrued === BigInt(0)) return null;

  // Accrue the delivery per invoice, splitting only to fit the journal's Int column.
  lines.push(
    ...journalLegs(accrued, {
      accountCode: 'GOODS_RECEIVED_ACCRUAL',
      side: 'CREDIT',
      branchId: receipt.branchId,
      memo: receipt.supplierInvoiceRef,
    })
  );

  return postJournalEntry(
    db,
    { organizationId: scope.organizationId, actorId: scope.actorId },
    {
      sourceKind: 'PHARMACY_GOODS_RECEIPT',
      sourceId: receipt.id,
      description: `Goods receipt ${receipt.reference}`,
      occurredAt: input.at,
      idempotencyKey: postingKey('PHARMACY_GOODS_RECEIPT', receipt.id),
      branchId: receipt.branchId,
      lines: nonZero(lines),
    }
  );
}

/**
 * FIN-01 (sale, discount/complimentary) + FIN-03 (COGS at allocated lot cost):
 * the sale line posting.
 *
 * Revenue is recognised GROSS and the discount is posted as its own
 * contra-revenue leg, so a discounted or complimentary line states what was
 * given away instead of quietly reporting a smaller sale. A COMPLIMENTARY line
 * is the limit case of that same treatment: gross revenue, an equal discount,
 * and cost still relieved — the margin it reports is exactly minus the cost of
 * the goods, which is what giving stock away costs.
 */
export async function postSaleLineEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { saleLineId: string; at: Date }
) {
  const line = await db.pharmacySaleLine.findFirst({
    where: { id: input.saleLineId, organizationId: scope.organizationId },
    include: { allocations: { orderBy: { id: 'asc' } } },
  });
  if (!line) throw new PharmacyFinanceError('NOT_FOUND');
  if (line.branchId !== scope.branchId) throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');
  if (line.allocations.length === 0) throw new PharmacyFinanceError('NOTHING_TO_POST');

  const lots = await loadLots(
    db,
    scope,
    line.allocations.map((allocation) => allocation.inventoryLotId)
  );

  const chargedAllocations = saleAllocationMoney(line);

  const lines: JournalLineInput[] = [];
  for (const [index, allocation] of line.allocations.entries()) {
    const lot = lots.get(allocation.inventoryLotId);
    if (!lot) throw new PharmacyFinanceError('NOT_FOUND');

    const dimensions = {
      branchId: line.branchId,
      productId: line.medicineId,
      lotId: allocation.inventoryLotId,
      locationId: allocation.stockLocationId,
      sourceLineId: line.id,
    };
    const gross = chargedAllocations[index]!.grossMinor;
    const discount = chargedAllocations[index]!.discountMinor;
    // FIN-03: the exact landed cost of the lot this part of the line came from.
    const cost = lot.unitCostMinor * allocation.canonicalUnits;

    lines.push(
      { ...dimensions, accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: gross },
      { ...dimensions, accountCode: 'SALES_REVENUE', side: 'CREDIT', amountMinor: gross },
      {
        ...dimensions,
        accountCode: 'SALES_DISCOUNT',
        side: 'DEBIT',
        amountMinor: discount,
        memo: line.discountKind ?? undefined,
      },
      { ...dimensions, accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: discount },
      { ...dimensions, accountCode: 'COST_OF_GOODS_SOLD', side: 'DEBIT', amountMinor: cost },
      { ...dimensions, accountCode: 'INVENTORY', side: 'CREDIT', amountMinor: cost }
    );
  }

  return postJournalEntry(
    db,
    { organizationId: scope.organizationId, actorId: scope.actorId },
    {
      sourceKind: 'PHARMACY_SALE_LINE',
      sourceId: line.id,
      description: `Sale line ${line.id}`,
      occurredAt: input.at,
      idempotencyKey: postingKey('PHARMACY_SALE_LINE', line.id),
      branchId: line.branchId,
      lines: nonZero(lines),
    }
  );
}

/**
 * FIN-01 (return): the linked reversal of the part of a sale line that came
 * back.
 *
 * A return is not always the whole line, so this is not `reverseJournalEntry` —
 * it is a linked entry that negates the returned PROPORTION: revenue and
 * discount pro rata by units, and cost at the exact landed cost of the lot the
 * goods are being booked back into. Its legs carry the ORIGINAL sale line's id,
 * so margin by line nets the return against the sale it belongs to, while the
 * entry's own source reference points at the return line that caused it.
 *
 * The goods come back to the quarantine location the return recorded, never to
 * the shelf they left, so the FIN-03 valuation shows them where they are.
 */
export async function postSaleReturnEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { saleReturnLineId: string; at: Date }
) {
  const returnLine = await db.pharmacySaleReturnLine.findFirst({
    where: { id: input.saleReturnLineId, organizationId: scope.organizationId },
    include: { saleLine: true },
  });
  if (!returnLine) throw new PharmacyFinanceError('NOT_FOUND');
  if (returnLine.branchId !== scope.branchId) {
    throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');
  }

  const existing = await db.financeJournalEntry.findFirst({
    where: {
      organizationId: scope.organizationId,
      idempotencyKey: postingKey('PHARMACY_SALE_RETURN_LINE', returnLine.id),
    },
    include: { lines: true },
  });
  if (existing) return existing;

  const saleLine = returnLine.saleLine;
  const lots = await loadLots(db, scope, [returnLine.inventoryLotId]);
  const lot = lots.get(returnLine.inventoryLotId);
  if (!lot) throw new PharmacyFinanceError('NOT_FOUND');

  const grossMinor = saleLine.grossMinor;
  const returned = returnLine.canonicalUnits;
  const sold = saleLine.canonicalUnits;
  // returnSaleLine holds the sold-line lock and posts each newly inserted
  // allocation before inserting the next. Reverse cumulative deltas, so split
  // returns recover the final rounding minor unit instead of flooring it away.
  const cumulative = await db.pharmacySaleReturnLine.aggregate({
    where: { organizationId: scope.organizationId, saleLineId: saleLine.id },
    _sum: { canonicalUnits: true },
  });
  const unidentified = await db.pharmacyUnidentifiedReturnHold.aggregate({
    where: { organizationId: scope.organizationId, saleLineId: saleLine.id },
    _sum: { canonicalUnits: true },
  });
  const through = (cumulative._sum.canonicalUnits ?? 0) + (unidentified._sum.canonicalUnits ?? 0);
  const before = through - returned;
  if (before < 0 || through > sold) throw new PharmacyFinanceError('INVALID_STATE');
  const delta = (amount: number) =>
    Math.floor((amount * through) / sold) - Math.floor((amount * before) / sold);
  const discount = returnLine.discountMinor ?? delta(saleLine.discountMinor);
  // Refund authorization rounds cumulative NET. Derive gross from that same
  // net plus discount, so every partial reversal clears its authorized refund.
  const gross = returnLine.grossMinor ?? delta(grossMinor - saleLine.discountMinor) + discount;
  const cost = lot.unitCostMinor * returned;

  const dimensions = {
    branchId: returnLine.branchId,
    productId: saleLine.medicineId,
    lotId: returnLine.inventoryLotId,
    locationId: returnLine.stockLocationId,
    sourceLineId: saleLine.id,
  };
  const monetaryLines = nonZero([
    { ...dimensions, accountCode: 'SALES_REVENUE', side: 'DEBIT', amountMinor: gross },
    { ...dimensions, accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: gross },
    { ...dimensions, accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: discount },
    { ...dimensions, accountCode: 'SALES_DISCOUNT', side: 'CREDIT', amountMinor: discount },
    { ...dimensions, accountCode: 'INVENTORY', side: 'DEBIT', amountMinor: cost },
    { ...dimensions, accountCode: 'COST_OF_GOODS_SOLD', side: 'CREDIT', amountMinor: cost },
  ]);

  return postJournalEntry(
    db,
    { organizationId: scope.organizationId, actorId: scope.actorId },
    {
      sourceKind: 'PHARMACY_SALE_RETURN_LINE',
      sourceId: returnLine.id,
      description: `Return of sale line ${saleLine.id}`,
      occurredAt: input.at,
      idempotencyKey: postingKey('PHARMACY_SALE_RETURN_LINE', returnLine.id),
      branchId: returnLine.branchId,
      // A free, zero-cost allocation still needs a durable posting receipt.
      // Match unidentified returns with a balanced marker that changes no balance.
      lines:
        monetaryLines.length > 0
          ? monetaryLines
          : [
              { ...dimensions, accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: 1 },
              { ...dimensions, accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: 1 },
            ],
    }
  );
}

/** Reverse sale revenue when the returned pack cannot yet be tied to a lot.
 * Inventory and COGS remain untouched until that physical identity is known. */
export async function postUnidentifiedSaleReturnEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { holdingId: string; at: Date }
) {
  const holding = await db.pharmacyUnidentifiedReturnHold.findFirst({
    where: { id: input.holdingId, organizationId: scope.organizationId },
    include: {
      saleLine: { include: { returnLines: true, unidentifiedReturnHolds: true } },
    },
  });
  if (!holding) throw new PharmacyFinanceError('NOT_FOUND');
  if (holding.branchId !== scope.branchId) throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');

  const sourceKind: FinanceSourceKind = 'PHARMACY_UNIDENTIFIED_RETURN_HOLD';
  const existing = await db.financeJournalEntry.findFirst({
    where: {
      organizationId: scope.organizationId,
      idempotencyKey: postingKey(sourceKind, holding.id),
    },
    include: { lines: true },
  });
  if (existing) return existing;

  const saleLine = holding.saleLine;
  const through =
    saleLine.returnLines.reduce((sum, row) => sum + row.canonicalUnits, 0) +
    saleLine.unidentifiedReturnHolds.reduce((sum, row) => sum + row.canonicalUnits, 0);
  const before = through - holding.canonicalUnits;
  if (before < 0 || through > saleLine.canonicalUnits)
    throw new PharmacyFinanceError('INVALID_STATE');
  const delta = (amount: number) =>
    Math.floor((amount * through) / saleLine.canonicalUnits) -
    Math.floor((amount * before) / saleLine.canonicalUnits);
  const discount = holding.discountMinor ?? delta(saleLine.discountMinor);
  const gross =
    holding.grossMinor ?? delta(saleLine.grossMinor - saleLine.discountMinor) + discount;
  const dimensions = {
    branchId: holding.branchId,
    productId: saleLine.medicineId,
    locationId: holding.quarantineLocationId,
    sourceLineId: saleLine.id,
  };
  const monetaryLines = nonZero([
    {
      ...dimensions,
      accountCode: 'SALES_REVENUE' as const,
      side: 'DEBIT' as const,
      amountMinor: gross,
    },
    {
      ...dimensions,
      accountCode: 'SALES_CLEARING' as const,
      side: 'CREDIT' as const,
      amountMinor: gross,
    },
    {
      ...dimensions,
      accountCode: 'SALES_CLEARING' as const,
      side: 'DEBIT' as const,
      amountMinor: discount,
    },
    {
      ...dimensions,
      accountCode: 'SALES_DISCOUNT' as const,
      side: 'CREDIT' as const,
      amountMinor: discount,
    },
  ]);

  return postJournalEntry(
    db,
    { organizationId: scope.organizationId, actorId: scope.actorId },
    {
      sourceKind,
      sourceId: holding.id,
      description: `Unidentified return of sale line ${saleLine.id}`,
      occurredAt: input.at,
      idempotencyKey: postingKey(sourceKind, holding.id),
      branchId: holding.branchId,
      // Canonical units can be finer than a minor currency unit. Keep a
      // balanced, net-zero clearing marker for those slices: the journal row
      // remains the durable idempotency/completeness receipt without inventing
      // revenue, discount, inventory, or COGS.
      lines:
        monetaryLines.length > 0
          ? monetaryLines
          : [
              { ...dimensions, accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: 1 },
              { ...dimensions, accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: 1 },
            ],
    }
  );
}

/**
 * FIN-01 (expiry/damage): the write-off posting, taken straight off the
 * WRITE_OFF stock movement so the money and the units always name the same
 * event.
 */
export async function postWriteOffEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { stockMovementId: string; at: Date }
) {
  const movement = await db.pharmacyStockMovement.findFirst({
    where: { id: input.stockMovementId, organizationId: scope.organizationId },
  });
  if (!movement) throw new PharmacyFinanceError('NOT_FOUND');
  if (movement.branchId !== scope.branchId)
    throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');
  if (movement.kind !== 'WRITE_OFF') throw new PharmacyFinanceError('INVALID_STATE');

  const lots = await loadLots(db, scope, [movement.inventoryLotId]);
  const lot = lots.get(movement.inventoryLotId);
  if (!lot) throw new PharmacyFinanceError('NOT_FOUND');

  const amountMinor = lot.unitCostMinor * Math.abs(movement.quantityUnits);
  const dimensions = {
    branchId: movement.branchId,
    productId: lot.medicineId,
    lotId: movement.inventoryLotId,
    locationId: movement.stockLocationId,
    sourceLineId: movement.id,
  };

  return postJournalEntry(
    db,
    { organizationId: scope.organizationId, actorId: scope.actorId },
    {
      sourceKind: 'PHARMACY_STOCK_WRITE_OFF',
      sourceId: movement.id,
      description: movement.reason ?? 'Stock write-off',
      occurredAt: input.at,
      idempotencyKey: postingKey('PHARMACY_STOCK_WRITE_OFF', movement.id),
      branchId: movement.branchId,
      lines: nonZero([
        {
          ...dimensions,
          accountCode: 'INVENTORY_WRITE_OFF',
          side: 'DEBIT',
          amountMinor,
        },
        { ...dimensions, accountCode: 'INVENTORY', side: 'CREDIT', amountMinor },
      ]),
    }
  );
}

/**
 * FIN-01 (claim/credit): reserving units for a supplier claim moves their value
 * out of inventory and into what the supplier owes back.
 */
export async function postSupplierClaimEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { supplierClaimId: string; at: Date }
) {
  const claim = await db.pharmacySupplierClaim.findFirst({
    where: { id: input.supplierClaimId, organizationId: scope.organizationId },
  });
  if (!claim) throw new PharmacyFinanceError('NOT_FOUND');
  if (claim.branchId !== scope.branchId) throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');

  const lots = await loadLots(db, scope, [claim.inventoryLotId]);
  const lot = lots.get(claim.inventoryLotId);
  if (!lot) throw new PharmacyFinanceError('NOT_FOUND');

  const amountMinor = lot.unitCostMinor * claim.reservedUnits;
  const dimensions = {
    branchId: claim.branchId,
    productId: lot.medicineId,
    lotId: claim.inventoryLotId,
    sourceLineId: claim.id,
  };

  return postJournalEntry(
    db,
    { organizationId: scope.organizationId, actorId: scope.actorId },
    {
      sourceKind: 'PHARMACY_SUPPLIER_CLAIM',
      sourceId: claim.id,
      description: `Supplier claim ${claim.id}`,
      occurredAt: input.at,
      idempotencyKey: postingKey('PHARMACY_SUPPLIER_CLAIM', claim.id),
      branchId: claim.branchId,
      lines: nonZero([
        {
          ...dimensions,
          accountCode: 'SUPPLIER_CLAIM_RECEIVABLE',
          side: 'DEBIT',
          amountMinor,
        },
        { ...dimensions, accountCode: 'INVENTORY', side: 'CREDIT', amountMinor },
      ]),
    }
  );
}

/**
 * FIN-01 (transfer): value leaves the source branch's inventory and sits in
 * transit against the destination branch, at the source lot's cost.
 *
 * The two legs carry DIFFERENT branch dimensions on purpose. Nothing is earned
 * or lost by moving stock between one's own branches, so the entry balances
 * organization-wide while each branch's own inventory balance moves by exactly
 * the value that crossed the boundary.
 */
export async function postInterbranchTransferEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { transferLineId: string; at: Date }
) {
  const line = await db.pharmacyInterbranchTransferLine.findFirst({
    where: { id: input.transferLineId, organizationId: scope.organizationId },
    include: { transfer: true },
  });
  if (!line) throw new PharmacyFinanceError('NOT_FOUND');
  if (line.sourceBranchId !== scope.branchId) {
    throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');
  }

  const lots = await loadLots(db, scope, [line.sourceLotId]);
  const lot = lots.get(line.sourceLotId);
  if (!lot) throw new PharmacyFinanceError('NOT_FOUND');

  const amount = BigInt(lot.unitCostMinor) * BigInt(line.quantityUnits);
  if (amount === BigInt(0)) return null;

  return postJournalEntry(
    db,
    { organizationId: scope.organizationId, actorId: scope.actorId },
    {
      sourceKind: 'PHARMACY_INTERBRANCH_TRANSFER_LINE',
      sourceId: line.id,
      description: `Inter-branch transfer ${line.transferId}`,
      occurredAt: input.at,
      idempotencyKey: postingKey('PHARMACY_INTERBRANCH_TRANSFER_LINE', line.id),
      branchId: line.sourceBranchId,
      lines: [
        ...journalLegs(amount, {
          accountCode: 'INVENTORY_IN_TRANSIT',
          side: 'DEBIT',
          branchId: line.transfer.toBranchId,
          productId: lot.medicineId,
          lotId: line.sourceLotId,
          locationId: line.destinationStockLocationId,
          sourceLineId: line.id,
        }),
        ...journalLegs(amount, {
          accountCode: 'INVENTORY',
          side: 'CREDIT',
          branchId: line.sourceBranchId,
          productId: lot.medicineId,
          lotId: line.sourceLotId,
          locationId: line.sourceStockLocationId,
          sourceLineId: line.id,
        }),
      ],
    }
  );
}

/** Move each received slice out of transit and onto its actual destination lot. */
export async function postInterbranchTransferReceiptEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { transferLineId: string; stockMovementId: string; at: Date }
) {
  const line = await db.pharmacyInterbranchTransferLine.findFirst({
    where: { id: input.transferLineId, organizationId: scope.organizationId },
    include: { transfer: true },
  });
  if (!line) throw new PharmacyFinanceError('NOT_FOUND');
  if (line.transfer.toBranchId !== scope.branchId)
    throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');

  const movement = await db.pharmacyStockMovement.findFirst({
    where: { id: input.stockMovementId, organizationId: scope.organizationId },
  });
  if (!movement) throw new PharmacyFinanceError('NOT_FOUND');
  if (
    movement.branchId !== scope.branchId ||
    movement.kind !== 'TRANSFER_IN' ||
    movement.stockLocationId !== line.destinationStockLocationId
  )
    throw new PharmacyFinanceError('INVALID_STATE');

  const lots = await loadLots(db, scope, [movement.inventoryLotId]);
  const lot = lots.get(movement.inventoryLotId);
  if (!lot) throw new PharmacyFinanceError('NOT_FOUND');
  const amount = BigInt(lot.unitCostMinor) * BigInt(movement.quantityUnits);
  if (amount === BigInt(0)) return null;

  // Transfers dispatched before automatic journals have no transit value to
  // clear. Keep those receipts usable during an upgrade, like legacy GRNs.
  const dispatch = await db.financeJournalEntry.findFirst({
    where: {
      organizationId: scope.organizationId,
      idempotencyKey: postingKey('PHARMACY_INTERBRANCH_TRANSFER_LINE', line.id),
    },
  });
  if (!dispatch) return null;

  const dimensions = {
    branchId: scope.branchId,
    productId: lot.medicineId,
    locationId: movement.stockLocationId,
    sourceLineId: line.id,
  };
  return postJournalEntry(db, scope, {
    sourceKind: 'PHARMACY_INTERBRANCH_TRANSFER_LINE',
    sourceId: line.id,
    description: `Receipt of inter-branch transfer ${line.transferId}`,
    occurredAt: input.at,
    idempotencyKey: `${postingKey('PHARMACY_INTERBRANCH_TRANSFER_LINE', line.id)}:received:${movement.id}`,
    branchId: scope.branchId,
    lines: [
      ...journalLegs(amount, {
        ...dimensions,
        accountCode: 'INVENTORY',
        side: 'DEBIT',
        lotId: movement.inventoryLotId,
      }),
      ...journalLegs(amount, {
        ...dimensions,
        accountCode: 'INVENTORY_IN_TRANSIT',
        side: 'CREDIT',
        lotId: line.sourceLotId,
      }),
    ],
  });
}

/** Clear dispatched value for stock written off during the closing receipt. */
export async function postInterbranchTransferVarianceEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { transferLineId: string; stockMovementId: string; at: Date }
) {
  const line = await db.pharmacyInterbranchTransferLine.findFirst({
    where: { id: input.transferLineId, organizationId: scope.organizationId },
    include: { transfer: true },
  });
  if (!line) throw new PharmacyFinanceError('NOT_FOUND');
  if (line.transfer.toBranchId !== scope.branchId)
    throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');

  const movement = await db.pharmacyStockMovement.findFirst({
    where: { id: input.stockMovementId, organizationId: scope.organizationId },
  });
  if (!movement) throw new PharmacyFinanceError('NOT_FOUND');
  if (
    movement.branchId !== line.sourceBranchId ||
    movement.inventoryLotId !== line.sourceLotId ||
    movement.stockLocationId !== line.sourceStockLocationId ||
    movement.kind !== 'WRITE_OFF' ||
    movement.disposition !== 'IN_TRANSIT' ||
    movement.quantityUnits >= 0 ||
    movement.idempotencyKey !== `transfer-variance:${line.transferId}:${line.id}`
  )
    throw new PharmacyFinanceError('INVALID_STATE');

  // Legacy dispatches have no journal transit balance to relieve.
  const dispatch = await db.financeJournalEntry.findFirst({
    where: {
      organizationId: scope.organizationId,
      idempotencyKey: postingKey('PHARMACY_INTERBRANCH_TRANSFER_LINE', line.id),
    },
  });
  if (!dispatch) return null;

  const lots = await loadLots(db, { ...scope, branchId: line.sourceBranchId }, [line.sourceLotId]);
  const lot = lots.get(line.sourceLotId);
  if (!lot) throw new PharmacyFinanceError('NOT_FOUND');
  const amount = BigInt(lot.unitCostMinor) * BigInt(-movement.quantityUnits);
  if (amount === BigInt(0)) return null;
  // Dispatch carries transit against the destination, using the source lot.
  const dimensions = {
    branchId: scope.branchId,
    productId: lot.medicineId,
    lotId: line.sourceLotId,
    locationId: line.destinationStockLocationId,
    sourceLineId: line.id,
  };
  return postJournalEntry(db, scope, {
    sourceKind: 'PHARMACY_STOCK_WRITE_OFF',
    sourceId: movement.id,
    description: movement.reason ?? `Transfer ${line.transferId} receipt variance`,
    occurredAt: input.at,
    idempotencyKey: postingKey('PHARMACY_STOCK_WRITE_OFF', movement.id),
    branchId: scope.branchId,
    lines: [
      ...journalLegs(amount, { ...dimensions, accountCode: 'INVENTORY_WRITE_OFF', side: 'DEBIT' }),
      ...journalLegs(amount, {
        ...dimensions,
        accountCode: 'INVENTORY_IN_TRANSIT',
        side: 'CREDIT',
      }),
    ],
  });
}

/**
 * FIN-01 (count adjustment): a counted variance is a real gain or loss of
 * value, so it is posted rather than absorbed.
 *
 * A line that counted exactly what the book said posts nothing and returns
 * null — an entry recording that nothing happened is noise in a leakage report.
 */
export async function postCountAdjustmentEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { countLineId: string; at: Date }
) {
  const line = await db.pharmacyInventoryCountLine.findFirst({
    where: { id: input.countLineId, organizationId: scope.organizationId },
    include: { count: true },
  });
  if (!line) throw new PharmacyFinanceError('NOT_FOUND');
  if (line.branchId !== scope.branchId) throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');
  if (line.count.status !== 'APPROVED') throw new PharmacyFinanceError('INVALID_STATE');

  const variance = line.varianceUnits ?? 0;
  if (variance === 0) return null;

  const lots = await loadLots(db, scope, [line.inventoryLotId]);
  const lot = lots.get(line.inventoryLotId);
  if (!lot) throw new PharmacyFinanceError('NOT_FOUND');

  const amount = BigInt(lot.unitCostMinor) * BigInt(Math.abs(variance));
  if (amount === BigInt(0)) return null;
  const dimensions = {
    branchId: line.branchId,
    productId: lot.medicineId,
    lotId: line.inventoryLotId,
    locationId: line.stockLocationId,
    sourceLineId: line.id,
  };
  // Counted short: value leaves inventory as shrinkage. Counted long: inventory
  // gains it back, and the same shrinkage account carries the credit, so the
  // leakage report nets found stock against lost stock instead of reporting
  // only the losses.
  const shortfall = variance < 0;

  return postJournalEntry(
    db,
    { organizationId: scope.organizationId, actorId: scope.actorId },
    {
      sourceKind: 'PHARMACY_INVENTORY_COUNT_LINE',
      sourceId: line.id,
      description: `Inventory count ${line.countId}`,
      occurredAt: input.at,
      idempotencyKey: postingKey('PHARMACY_INVENTORY_COUNT_LINE', line.id),
      branchId: line.branchId,
      lines: [
        ...journalLegs(amount, {
          ...dimensions,
          accountCode: shortfall ? 'INVENTORY_SHRINKAGE' : 'INVENTORY',
          side: 'DEBIT',
        }),
        ...journalLegs(amount, {
          ...dimensions,
          accountCode: shortfall ? 'INVENTORY' : 'INVENTORY_SHRINKAGE',
          side: 'CREDIT',
        }),
      ],
    }
  );
}

/** POS-B: settle the receivable created by sale-line postings. */
export async function postTenderEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { tenderId: string; at: Date }
) {
  const tender = await db.pharmacyTender.findFirst({
    where: { id: input.tenderId, organizationId: scope.organizationId },
  });
  if (!tender) throw new PharmacyFinanceError('NOT_FOUND');
  if (tender.branchId !== scope.branchId) throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');
  const settlementAccount =
    tender.type === 'CASH'
      ? 'CASH'
      : tender.type === 'CREDIT'
        ? 'ACCOUNTS_RECEIVABLE'
        : tender.type === 'LOYALTY'
          ? 'LOYALTY_REDEMPTION'
          : 'BANK';
  return postJournalEntry(db, scope, {
    sourceKind: 'PHARMACY_TENDER',
    sourceId: tender.id,
    description: `Pharmacy tender ${tender.id}`,
    occurredAt: input.at,
    idempotencyKey: postingKey('PHARMACY_TENDER', tender.id),
    branchId: tender.branchId,
    lines: [
      {
        accountCode: settlementAccount,
        side: 'DEBIT',
        amountMinor: tender.amountMinor,
        branchId: tender.branchId,
      },
      {
        accountCode: 'SALES_CLEARING',
        side: 'CREDIT',
        amountMinor: tender.amountMinor,
        branchId: tender.branchId,
      },
    ],
  });
}

/** POS-B: additive reversal of the original tender settlement. */
export async function postTenderRefundEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { refundId: string; at: Date }
) {
  const refund = await db.pharmacyRefund.findFirst({
    where: { id: input.refundId, organizationId: scope.organizationId },
    include: { originalTender: { select: { type: true } } },
  });
  if (!refund) throw new PharmacyFinanceError('NOT_FOUND');
  if (refund.branchId !== scope.branchId) throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');
  const settlementAccount =
    refund.drawerSessionId || refund.originalTender.type === 'CASH'
      ? 'CASH'
      : refund.originalTender.type === 'CREDIT'
        ? 'ACCOUNTS_RECEIVABLE'
        : refund.originalTender.type === 'LOYALTY'
          ? 'LOYALTY_REDEMPTION'
          : 'BANK';
  return postJournalEntry(db, scope, {
    sourceKind: 'PHARMACY_REFUND',
    sourceId: refund.id,
    description: `Refund of tender ${refund.originalTenderId}`,
    occurredAt: input.at,
    idempotencyKey: postingKey('PHARMACY_REFUND', refund.id),
    branchId: refund.branchId,
    lines: [
      {
        accountCode: 'SALES_CLEARING',
        side: 'DEBIT',
        amountMinor: refund.amountMinor,
        branchId: refund.branchId,
      },
      {
        accountCode: settlementAccount,
        side: 'CREDIT',
        amountMinor: refund.amountMinor,
        branchId: refund.branchId,
      },
    ],
  });
}

/** POS-B: close is a reconciliation event; only its cash variance changes value. */
export async function postDailyCloseEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { closeId: string; at: Date }
) {
  const close = await db.pharmacyDailyClose.findFirst({
    where: { id: input.closeId, organizationId: scope.organizationId },
  });
  if (!close) throw new PharmacyFinanceError('NOT_FOUND');
  if (close.branchId !== scope.branchId) throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');
  if (close.cashVarianceMinor === 0) return null;
  const short = close.cashVarianceMinor < 0;
  const amountMinor = Math.abs(close.cashVarianceMinor);
  return postJournalEntry(db, scope, {
    sourceKind: 'PHARMACY_DAILY_CLOSE',
    sourceId: close.id,
    description: `Daily close ${close.businessDate.toISOString().slice(0, 10)} #${close.sequence}`,
    occurredAt: input.at,
    idempotencyKey: postingKey('PHARMACY_DAILY_CLOSE', close.id),
    branchId: close.branchId,
    lines: [
      {
        accountCode: short ? 'CASH_OVER_SHORT' : 'CASH',
        side: 'DEBIT',
        amountMinor,
        branchId: close.branchId,
      },
      {
        accountCode: short ? 'CASH' : 'CASH_OVER_SHORT',
        side: 'CREDIT',
        amountMinor,
        branchId: close.branchId,
      },
    ],
  });
}

/** Keep totals exact while each journal leg fits PostgreSQL INTEGER. */
function journalLegs(
  amount: bigint,
  dimensions: Omit<JournalLineInput, 'amountMinor'>
): JournalLineInput[] {
  const lines: JournalLineInput[] = [];
  const max = BigInt(2_147_483_647);
  for (let remaining = amount; remaining > BigInt(0); remaining -= max) {
    lines.push({ ...dimensions, amountMinor: Number(remaining > max ? max : remaining) });
  }
  return lines;
}

/** MIG-03: recognize the posted opening stock at its recorded lot cost. */
export async function postOpeningStockEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { sessionId: string; at: Date }
) {
  const total = await db.pharmacyOpeningTotal.findFirst({
    where: { sessionId: input.sessionId, organizationId: scope.organizationId },
  });
  if (!total) throw new PharmacyFinanceError('NOT_FOUND');
  if (total.branchId !== scope.branchId) throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');
  if (total.totalValueMinor === BigInt(0)) return null;
  const openingLines = await db.pharmacyOpeningStockLine.findMany({
    where: { organizationId: scope.organizationId, sessionId: total.sessionId, status: 'POSTED' },
    orderBy: { id: 'asc' },
  });
  const lots = await loadLots(
    db,
    scope,
    openingLines.flatMap((line) => (line.postedLotId ? [line.postedLotId] : []))
  );
  const lines: JournalLineInput[] = [];
  let valued = BigInt(0);
  for (const line of openingLines) {
    if (
      !line.postedLotId ||
      !line.stockLocationId ||
      line.countedUnits === null ||
      line.unitCostMinor === null
    )
      throw new PharmacyFinanceError('INVALID_STATE');
    const amount = BigInt(line.countedUnits) * BigInt(line.unitCostMinor);
    const lot = lots.get(line.postedLotId);
    if (!lot) throw new PharmacyFinanceError('NOT_FOUND');
    valued += amount;
    lines.push(
      ...journalLegs(amount, {
        accountCode: 'INVENTORY',
        side: 'DEBIT',
        branchId: total.branchId,
        productId: lot.medicineId,
        lotId: line.postedLotId,
        locationId: line.stockLocationId,
        sourceLineId: line.id,
      })
    );
  }
  if (valued !== total.totalValueMinor) throw new PharmacyFinanceError('INVALID_STATE');
  lines.push(
    ...journalLegs(total.totalValueMinor, {
      accountCode: 'OPENING_BALANCE_EQUITY',
      side: 'CREDIT',
      branchId: total.branchId,
    })
  );
  return postJournalEntry(db, scope, {
    sourceKind: 'PHARMACY_OPENING_STOCK',
    sourceId: total.id,
    description: `Opening stock ${total.sessionId}`,
    occurredAt: input.at,
    idempotencyKey: postingKey('PHARMACY_OPENING_STOCK', total.id),
    branchId: total.branchId,
    lines,
  });
}

/** MIG-03: post one signed opening balance without re-deriving the migration ledger. */
export async function postOpeningLedgerEntry(
  db: ScopedDb,
  scope: PostingScope,
  input: { openingLedgerEntryId: string; at: Date }
) {
  const opening = await db.pharmacyOpeningLedgerEntry.findFirst({
    where: { id: input.openingLedgerEntryId, organizationId: scope.organizationId },
  });
  if (!opening) throw new PharmacyFinanceError('NOT_FOUND');
  if (opening.branchId !== scope.branchId) throw new PharmacyFinanceError('CROSS_BRANCH_REFERENCE');
  const signed = opening.balanceMinor;
  if (signed === BigInt(0)) return null;
  const amount = signed > BigInt(0) ? signed : -signed;
  const accountCode = opening.account;
  const side = signed > BigInt(0) ? 'DEBIT' : 'CREDIT';
  const equitySide = side === 'DEBIT' ? 'CREDIT' : 'DEBIT';
  return postJournalEntry(db, scope, {
    sourceKind: 'PHARMACY_OPENING_LEDGER',
    sourceId: opening.id,
    description: `Opening ${opening.account} ${opening.sourceRef}`,
    occurredAt: input.at,
    idempotencyKey: postingKey('PHARMACY_OPENING_LEDGER', opening.id),
    branchId: opening.branchId,
    lines: [
      ...journalLegs(amount, { accountCode, side, branchId: opening.branchId }),
      ...journalLegs(amount, {
        accountCode: 'OPENING_BALANCE_EQUITY',
        side: equitySide,
        branchId: opening.branchId,
      }),
    ],
  });
}

/**
 * §8A invariant 15: reverse the posting an operational event made, additively.
 *
 * Used where the operation itself is reversible — a goods receipt taken back
 * (PUR-04) is the case that exists today. The original entry is untouched; the
 * reversal is a new entry that names it and negates its legs exactly.
 */
export async function reversePostingForSource(
  db: ScopedDb,
  scope: PostingScope,
  input: { sourceKind: FinanceSourceKind; sourceId: string; reason: string; at: Date }
) {
  const entry = await db.financeJournalEntry.findFirst({
    where: {
      organizationId: scope.organizationId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      reversesEntryId: null,
    },
  });
  if (!entry) throw new PharmacyFinanceError('NOT_FOUND');

  return reverseJournalEntry(
    db,
    { organizationId: scope.organizationId, actorId: scope.actorId },
    {
      entryId: entry.id,
      reason: input.reason,
      at: input.at,
      idempotencyKey: `${postingKey(input.sourceKind, input.sourceId)}:reversal`,
    }
  );
}

/**
 * The lots an adapter needs, with the medicine resolved through the batch so a
 * posting can name its product dimension without a second round trip.
 */
async function loadLots(db: ScopedDb, scope: PostingScope, lotIds: readonly string[]) {
  const lots = await db.pharmacyInventoryLot.findMany({
    where: {
      id: { in: [...new Set(lotIds)] },
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    include: { batch: { select: { medicineId: true } } },
  });
  return new Map(
    lots.map((lot) => [
      lot.id,
      { unitCostMinor: lot.unitCostMinor, medicineId: lot.batch.medicineId },
    ])
  );
}
