import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import { findSubstituteProposals } from './substitute-finder';

export type SaleSubstitution = {
  requestedMedicineId: string;
  requestedPresentationId: string;
  inventoryLotId: string;
  priceOverrideReason?: string;
};

function moneyProduct(left: number, right: number): number | null {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right <= 0
  )
    return null;
  const product = left * right;
  return Number.isSafeInteger(product) ? product : null;
}

/** Called inside addLine's transaction; a listing-time override grants nothing. */
export async function authorizeSubstituteSale<
  T extends {
    line: {
      id: string;
      saleId: string;
      medicineId: string;
      presentationId: string;
      packLevelId: string;
      canonicalUnits: number;
      quantity: number;
      unitPriceMinor: number;
    };
    allocation: { allocations: readonly { inventoryLotId: string }[] };
  },
>(
  db: ScopedDb,
  scope: LedgerScope,
  input: SaleSubstitution,
  quantityCanonicalUnits: number,
  addLine: () => Promise<T>
) {
  const reason = input.priceOverrideReason?.trim();
  const proposals = await findSubstituteProposals(db, scope, {
    medicineId: input.requestedMedicineId,
    presentationId: input.requestedPresentationId,
    quantityCanonicalUnits,
    ...(reason ? { pharmacistOverride: { reason } } : {}),
  });
  const result = await addLine();
  const proposal = proposals.find(
    (p) =>
      p.inventoryLotId === input.inventoryLotId &&
      p.medicineId === result.line.medicineId &&
      p.presentationId === result.line.presentationId &&
      p.packLevelId === result.line.packLevelId
  );
  const suppliedPrice = moneyProduct(result.line.unitPriceMinor, result.line.quantity);
  const referencePrice = proposal
    ? proposal.priceMinor + proposal.priceDifferenceMinor
    : null;
  if (
    !proposal ||
    result.line.canonicalUnits !== quantityCanonicalUnits ||
    result.allocation.allocations.length === 0 ||
    result.allocation.allocations.some((a) => a.inventoryLotId !== input.inventoryLotId) ||
    suppliedPrice === null ||
    referencePrice === null ||
    !Number.isSafeInteger(referencePrice) ||
    referencePrice < 0
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Substitute no longer matches the authorized lot or price. Refresh suggestions.',
    });
  }
  if (suppliedPrice > referencePrice && !reason) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'A pricier substitute requires a pharmacist override reason.',
    });
  }
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'OTHER',
      action: 'pharmacySales.authorizeSubstituteSale',
      targetType: 'PharmacySaleLine',
      targetId: result.line.id,
      metadata: {
        saleId: result.line.saleId,
        branchId: scope.branchId,
        requestedMedicineId: input.requestedMedicineId,
        requestedPresentationId: input.requestedPresentationId,
        inventoryLotId: input.inventoryLotId,
        referencePriceMinor: referencePrice,
        suppliedPriceMinor: suppliedPrice,
        reason: reason ?? null,
      },
    },
  });
  return result;
}
