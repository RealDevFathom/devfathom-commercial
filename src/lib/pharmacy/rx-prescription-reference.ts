import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

import type { LedgerScope } from './stock-ledger';
import { prescriptionIsCurrent } from './prescription-calendar';
import { assertPharmacistApproved, PharmacyDispensingError } from './dispensing';
import { PHARMACIST_CHECK_OFF_SIGNATURE_PREFIX } from './pharmacist-check';
import { pharmacistCheckAtSaleEnabled } from './pharmacist-check-policy';
import { needsRxSaleGrant } from './rx-sale-gate';

const REASONS = {
  PRESCRIPTION_NOT_FOUND:
    'That prescription reference does not match a prescription for this medicine in this pharmacy.',
  PRESCRIPTION_PATIENT_MISMATCH: 'That prescription belongs to a different patient.',
  PRESCRIPTION_NOT_IN_DATE: 'That prescription is outside its validity period.',
  PRESCRIPTION_EXHAUSTED: 'That prescription has no remaining quantity or repeats for this line.',
  PRESCRIPTION_REQUIRED:
    'A prescription-only or restricted medicine needs a prescription a pharmacist attached to the line before it can be sold.',
  PRESCRIPTION_NEEDS_PHARMACIST:
    'Only a pharmacist with the dispensing permission can record a prescription against a line.',
  CONTROLLED_AUTHORIZATION_NOT_APPLICABLE:
    'A controlled-medicine authorization was sent for a medicine that is not controlled.',
  CONTROLLED_PRESCRIPTION_IN_AUTHORIZATION:
    "A controlled medicine's prescription belongs in its controlled authorization.",
  CONTROLLED_LINE_UNCHECKED: 'A pharmacist must approve this controlled medicine.',
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

/**
 * DEV-629: the server, not the counter's browser alert, refuses to sell an Rx or restricted,
 * non-controlled line unless a pharmacist attached a prescription reference to it AND a
 * pharmacist signed the RX-03 review of that sale line. A reference is only ever attached by a
 * pharmacist through `resolvePrescriptionReference`, which checks it is real, current and not
 * exhausted; attaching queues the review, and SIGN is the sole sale-release event. The review is
 * queued with the pharmacist who rang up the line as its requester, and the database refuses a
 * decision by the requester (`pharmacy_review_no_self_approval`), so a different pharmacist signs
 * it from the pharmacist queue. DEV-950: only under the solo rule (nobody else at the branch could
 * sign it) may the requester sign it themselves, at the counter, by re-entering their own PIN;
 * that signature names its self-approved audit entry, without which the database refuses it
 * (`src/lib/pharmacy/rx-review-self-sign.ts`). Controlled lines
 * keep their own register gate (prescription or witnessed emergency supply), so they are not
 * judged here.
 *
 * DEV-911: when the owner has switched the pharmacist check at each sale off, neither the
 * prescription nor the signed review is demanded. The setting is read only when this gate is
 * about to refuse, so with the check on (or the setting missing or unreadable) nothing changes.
 */
export async function assertRxLinesPrescribed(
  db: ScopedDb,
  lines: ReadonlyArray<{
    id: string;
    prescriptionLineId: string | null;
    medicine: { rx: boolean; restricted: boolean; controlled: boolean } | null | undefined;
    allocations?: ReadonlyArray<{ stockMovementId: string | null }>;
  }>,
  scope?: { organizationId: string }
): Promise<void> {
  await assertControlledLinesChecked(db, lines, scope);
  const regulated = lines.filter((line) => needsRxSaleGrant(line.medicine));
  try {
    if (regulated.some((line) => !line.prescriptionLineId))
      throw new PharmacyRxReferenceError('PRESCRIPTION_REQUIRED');
    for (const line of regulated) await assertPharmacistApproved(db, line.id);
  } catch (error) {
    if (
      (error instanceof PharmacyRxReferenceError || error instanceof PharmacyDispensingError) &&
      !(await pharmacistCheckAtSaleEnabled(db, scope?.organizationId))
    )
      return;
    throw error;
  }
}

/**
 * Historical controlled lines marked pharmacist-check-off lack a verified approval. Refuse
 * them at tender and completion even if ordinary medicines can still be sold unchecked.
 */
async function assertControlledLinesChecked(
  db: ScopedDb,
  lines: ReadonlyArray<{
    medicine: { controlled: boolean } | null | undefined;
    allocations?: ReadonlyArray<{ stockMovementId: string | null }>;
  }>,
  scope?: { organizationId: string }
): Promise<void> {
  const movementIds: string[] = [];
  for (const line of lines) {
    if (!line.medicine?.controlled) continue;
    if (!line.allocations?.length) throw new PharmacyRxReferenceError('CONTROLLED_LINE_UNCHECKED');
    for (const allocation of line.allocations) {
      if (!allocation.stockMovementId)
        throw new PharmacyRxReferenceError('CONTROLLED_LINE_UNCHECKED');
      movementIds.push(allocation.stockMovementId);
    }
  }
  if (!movementIds.length) return;
  const unchecked = await db.pharmacyControlledRegisterEntry.findFirst({
    where: {
      ...(scope?.organizationId ? { organizationId: scope.organizationId } : {}),
      entryKind: 'SALE',
      stockMovementId: { in: movementIds },
      signatureRef: { startsWith: PHARMACIST_CHECK_OFF_SIGNATURE_PREFIX },
    },
    select: { id: true },
  });
  if (unchecked) throw new PharmacyRxReferenceError('CONTROLLED_LINE_UNCHECKED');
  const recorded = await db.pharmacyControlledRegisterEntry.count({
    where: {
      ...(scope?.organizationId ? { organizationId: scope.organizationId } : {}),
      entryKind: 'SALE',
      stockMovementId: { in: movementIds },
    },
  });
  if (recorded !== movementIds.length)
    throw new PharmacyRxReferenceError('CONTROLLED_LINE_UNCHECKED');
}

export type PrescriptionReference = { prescriptionLineId: string; patientId: string };

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
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  if (
    !prescriptionIsCurrent(
      line.prescription.validFrom,
      line.prescription.validUntil,
      now,
      workspaceTimezone(organization?.timezone)
    )
  )
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
  const idempotencyKey = `rx-reference:${input.id}`;
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
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  if (
    !prescriptionIsCurrent(
      line.prescription.validFrom,
      line.prescription.validUntil,
      now,
      workspaceTimezone(organization?.timezone)
    )
  )
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
      // DEV-962: the dispensing branch, so only it records this fill's refill reminder.
      branchId: scope.branchId,
      prescriptionLineId: input.prescriptionLineId,
      fillSequence: line.fills.length + 1,
      quantityCanonicalUnits: input.canonicalUnits,
      dispensedByUserId: scope.actorId,
      idempotencyKey,
    },
  });
}
