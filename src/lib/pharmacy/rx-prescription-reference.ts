import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import type { LedgerScope } from './stock-ledger';

const REASONS = {
  PRESCRIPTION_NOT_FOUND:
    'That prescription reference does not match a prescription for this medicine in this pharmacy.',
  PRESCRIPTION_PATIENT_MISMATCH: 'That prescription belongs to a different patient.',
  PRESCRIPTION_NOT_IN_DATE: 'That prescription is outside its validity period.',
  PRESCRIPTION_EXHAUSTED: 'That prescription has no remaining quantity or repeats for this line.',
  PRESCRIPTION_NEEDS_PHARMACIST:
    'Only a pharmacist with the dispensing permission can record a prescription against a line.',
  CONTROLLED_AUTHORIZATION_NOT_APPLICABLE:
    'A controlled-medicine authorization was sent for a medicine that is not controlled.',
  CONTROLLED_PRESCRIPTION_IN_AUTHORIZATION:
    "A controlled medicine's prescription belongs in its controlled authorization.",
} as const;

export type PharmacyRxReferenceReason = keyof typeof REASONS;

/**
 * #518: a prescription reference on a sale line that does not resolve to a usable prescription,
 * or that was sent where it does not apply. PRESCRIPTION_NEEDS_PHARMACIST is a 403; every other
 * reason is a request the counter must correct.
 */
export class PharmacyRxReferenceError extends Error {
  constructor(readonly reason: PharmacyRxReferenceReason) {
    super(REASONS[reason]);
    this.name = 'PharmacyRxReferenceError';
  }
}

export type PrescriptionReference = { prescriptionLineId: string; patientId: string };

/** Shared key: a fill is recorded only at sale completion, never at line approval/add. */
export function prescriptionReferenceFillKey(saleLineId: string): string {
  return `rx-reference:${saleLineId}`;
}

/**
 * #518: a prescription reference must resolve to a real prescription line of this organization,
 * for this patient (and the sale's linked customer, if it has one), for this medicine and
 * presentation, inside its validity period, with enough authorized quantity and repeats left.
 * Prescriptions are organization records with no branch or cancelled state; the sale itself is
 * branch-scoped. The quantity and repeat arithmetic is the controlled path's. The line is
 * locked first so two sales cannot fill the same remainder.
 */
export async function resolvePrescriptionReference(
  db: ScopedDb,
  scope: LedgerScope,
  input: PrescriptionReference & {
    saleId: string;
    medicineId: string;
    presentationId: string;
    units: number;
  },
  now: Date = new Date()
): Promise<{ prescriptionLineId: string; patientId: string }> {
  // Lock order is sale first, then prescription line, matching linkCustomerToSale and sale
  // completion. Holding the sale lock to commit means a concurrent customer link either commits
  // before us (and the customer read below, a fresh statement, sees it) or waits and then sees
  // the referenced line we attach.
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${input.saleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
  );
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_prescription_lines WHERE "organizationId"=${scope.organizationId} AND id=${input.prescriptionLineId} FOR UPDATE`
  );
  const line = await db.prescriptionLine.findFirst({
    where: {
      id: input.prescriptionLineId,
      organizationId: scope.organizationId,
      medicineId: input.medicineId,
      presentationId: input.presentationId,
    },
    select: {
      id: true,
      authorizedCanonicalUnits: true,
      prescription: {
        select: { patientId: true, validFrom: true, validUntil: true, authorizedRepeats: true },
      },
      fills: { select: { quantityCanonicalUnits: true } },
    },
  });
  if (!line) throw new PharmacyRxReferenceError('PRESCRIPTION_NOT_FOUND');
  const sale = await db.pharmacySale.findFirst({
    where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: { customer: { select: { patientId: true } } },
  });
  if (!sale) throw new PharmacyRxReferenceError('PRESCRIPTION_NOT_FOUND');
  if (
    line.prescription.patientId !== input.patientId ||
    (sale?.customer && sale.customer.patientId !== input.patientId)
  )
    throw new PharmacyRxReferenceError('PRESCRIPTION_PATIENT_MISMATCH');
  if (line.prescription.validFrom > now || line.prescription.validUntil <= now)
    throw new PharmacyRxReferenceError('PRESCRIPTION_NOT_IN_DATE');
  const filled = line.fills.reduce((sum, fill) => sum + fill.quantityCanonicalUnits, 0);
  if (
    !Number.isSafeInteger(input.units) ||
    input.units <= 0 ||
    filled + input.units > line.authorizedCanonicalUnits ||
    line.fills.length > line.prescription.authorizedRepeats
  )
    throw new PharmacyRxReferenceError('PRESCRIPTION_EXHAUSTED');
  return { prescriptionLineId: line.id, patientId: line.prescription.patientId };
}

/**
 * Persists the validated reference on the open sale line without consuming prescription
 * quantity. The immutable fill is created only if the sale completes.
 */
export async function attachPrescriptionReference(
  db: ScopedDb,
  scope: LedgerScope,
  input: { prescriptionLineId: string; patientId: string; saleLineId: string }
): Promise<void> {
  const updated = await db.pharmacySaleLine.updateMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      id: input.saleLineId,
    },
    data: {
      prescriptionLineId: input.prescriptionLineId,
      prescriptionPatientId: input.patientId,
    },
  });
  if (updated.count !== 1) throw new PharmacyRxReferenceError('PRESCRIPTION_NOT_FOUND');
}

/** Creates the fill for a referenced line while completion holds the surrounding sale lock. */
export async function recordCompletedPrescriptionReference(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    id: string;
    organizationId: string;
    branchId: string;
    medicineId: string;
    presentationId: string;
    canonicalUnits: number;
    prescriptionLineId: string;
    prescriptionPatientId: string | null;
    saleId: string;
  },
  now: Date = new Date()
): Promise<void> {
  if (input.organizationId !== scope.organizationId || input.branchId !== scope.branchId)
    throw new PharmacyRxReferenceError('PRESCRIPTION_NOT_FOUND');
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_sales WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${input.saleId} FOR UPDATE`
  );
  const idempotencyKey = prescriptionReferenceFillKey(input.id);
  if (
    await db.prescriptionFill.findUnique({
      where: {
        organizationId_idempotencyKey: { organizationId: scope.organizationId, idempotencyKey },
      },
      select: { id: true },
    })
  )
    return;
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_prescription_lines WHERE "organizationId"=${scope.organizationId} AND id=${input.prescriptionLineId} FOR UPDATE`
  );
  // Recheck after waiting for the line lock: a concurrent completion may have inserted this fill.
  if (
    await db.prescriptionFill.findUnique({
      where: {
        organizationId_idempotencyKey: { organizationId: scope.organizationId, idempotencyKey },
      },
      select: { id: true },
    })
  )
    return;
  const line = await db.prescriptionLine.findFirst({
    where: {
      id: input.prescriptionLineId,
      organizationId: scope.organizationId,
      medicineId: input.medicineId,
      presentationId: input.presentationId,
    },
    select: {
      authorizedCanonicalUnits: true,
      prescription: {
        select: { patientId: true, validFrom: true, validUntil: true, authorizedRepeats: true },
      },
      fills: { select: { quantityCanonicalUnits: true } },
    },
  });
  if (!line) throw new PharmacyRxReferenceError('PRESCRIPTION_NOT_FOUND');
  const sale = await db.pharmacySale.findFirst({
    where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: { customer: { select: { patientId: true } } },
  });
  if (!sale) throw new PharmacyRxReferenceError('PRESCRIPTION_NOT_FOUND');
  if (
    !input.prescriptionPatientId ||
    input.prescriptionPatientId !== line.prescription.patientId ||
    (sale?.customer && sale.customer.patientId !== line.prescription.patientId)
  )
    throw new PharmacyRxReferenceError('PRESCRIPTION_PATIENT_MISMATCH');
  if (line.prescription.validFrom > now || line.prescription.validUntil <= now)
    throw new PharmacyRxReferenceError('PRESCRIPTION_NOT_IN_DATE');
  const filled = line.fills.reduce((sum, fill) => sum + fill.quantityCanonicalUnits, 0);
  if (
    !Number.isSafeInteger(input.canonicalUnits) ||
    input.canonicalUnits <= 0 ||
    filled + input.canonicalUnits > line.authorizedCanonicalUnits ||
    line.fills.length > line.prescription.authorizedRepeats
  )
    throw new PharmacyRxReferenceError('PRESCRIPTION_EXHAUSTED');
  await db.prescriptionFill.create({
    data: {
      organizationId: scope.organizationId,
      prescriptionLineId: input.prescriptionLineId,
      fillSequence: line.fills.length + 1,
      quantityCanonicalUnits: input.canonicalUnits,
      dispensedByUserId: scope.actorId,
      idempotencyKey,
    },
  });
}
