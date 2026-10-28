import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';

// Call under the prescription-line row lock. Keep immutable fills for sequence
// numbering, but release authorization consumed by voids and returned units.
export async function prescriptionConsumedUnits(
  db: ScopedDb,
  organizationId: string,
  prescriptionLineId: string
) {
  const rows = await db.$queryRaw<Array<{ units: bigint }>>(Prisma.sql`
    SELECT COALESCE(SUM(CASE WHEN s.status = 'VOID' THEN 0 ELSE
      GREATEST(0, f."quantityCanonicalUnits" - COALESCE((
        SELECT SUM(r."canonicalUnits") FROM pharmacy_sale_return_lines r
        WHERE r."organizationId" = f."organizationId" AND r."saleLineId" = l.id
      ), 0)) END), 0)::bigint AS units
    FROM pharmacy_prescription_fills f
    LEFT JOIN pharmacy_sale_lines l ON l."organizationId" = f."organizationId"
      AND f."idempotencyKey" IN ('rx:' || l.id, 'controlled:' || l.id)
    LEFT JOIN pharmacy_sales s ON s."organizationId" = l."organizationId" AND s.id = l."saleId"
    WHERE f."organizationId" = ${organizationId} AND f."prescriptionLineId" = ${prescriptionLineId}`);
  return Number(rows[0]?.units ?? 0);
}

export async function prescriptionSalePatientStatus(
  db: ScopedDb,
  scope: LedgerScope,
  saleId: string,
  patientId: string
): Promise<'MISSING' | 'MATCH' | 'MISMATCH'> {
  // Prevent customer changes until this transaction has recorded the fill.
  await db.$queryRaw`SELECT id FROM pharmacy_sales WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${saleId} FOR UPDATE`;
  const sale = await db.pharmacySale.findFirst({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, id: saleId },
    select: { customerId: true, customer: { select: { patientId: true } } },
  });
  // SEC (#236): an Rx-gated line may only be dispensed on a sale that is tied to
  // the prescription's patient. A sale with no linked customer, or one linked to
  // a different patient, is refused — an anonymous bill can no longer launder an
  // arbitrary patient's prescription.
  if (!sale?.customer?.patientId) return 'MISSING';
  return sale.customer.patientId === patientId ? 'MATCH' : 'MISMATCH';
}

export async function prescriptionMatchesSalePatient(
  db: ScopedDb,
  scope: LedgerScope,
  saleId: string,
  patientId: string
) {
  return (await prescriptionSalePatientStatus(db, scope, saleId, patientId)) === 'MATCH';
}
