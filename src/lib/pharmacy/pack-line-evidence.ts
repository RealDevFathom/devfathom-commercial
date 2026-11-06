import 'server-only';

import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { parseGs1DataMatrix } from './gs1-datamatrix';
import { normalizeMedicineText } from './medicine';

/**
 * Re-read authoritative data for a dispensing scan; stored verdicts and client
 * claims are deliberately ignored. Caller must authorize the actor and branch,
 * lock the scoped sale, verify that the selected line is still active, and
 * hold the appropriate evidence locks through commit. This lookup alone does
 * not serialize changes to barcode, batch, recall or receipt evidence. It
 * neither proves physical possession nor binds evidence or permits a sale or
 * payment. The caller must not interpret it as a serialized-pack identity.
 */
export async function revalidatePackLineEvidence(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    scanId: string;
    medicineId: string;
    presentationId: string;
    packLevelId: string;
  }
) {
  const scan = await db.pharmacyPackAuthenticationScan.findFirst({
    where: {
      id: input.scanId,
      organizationId: input.organizationId,
      branchId: input.branchId,
      source: 'DISPENSING',
    },
    select: { gtin: true, batchNumber: true, expiresOn: true },
  });
  if (!scan)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Pack scan unavailable in this branch.' });
  const unverified = { status: 'UNVERIFIED' as const };
  if (!scan.gtin || !scan.batchNumber) return unverified;
  // Re-parse rather than treating a historic stored status as evidence. The
  // equality checks reject field-boundary ambiguity in reconstructed input.
  const parsed = parseGs1DataMatrix(
    `(01)${scan.gtin}${scan.expiresOn ? `(17)${scan.expiresOn}` : ''}(10)${scan.batchNumber}`
  );
  if (
    parsed.kind !== 'parsed' ||
    parsed.fields.gtin !== scan.gtin ||
    parsed.fields.batch !== scan.batchNumber ||
    parsed.fields.expiry !== scan.expiresOn
  )
    return unverified;
  const barcode = await db.medicineBarcode.findFirst({
    where: {
      organizationId: input.organizationId,
      normalizedCode: normalizeMedicineText(scan.gtin),
    },
    select: {
      packLevelId: true,
      presentation: { select: { id: true, organizationId: true, medicineId: true } },
    },
  });
  if (!barcode?.packLevelId || barcode.presentation.organizationId !== input.organizationId)
    return unverified;
  const batch = await db.pharmacyManufacturingBatch.findFirst({
    where: {
      organizationId: input.organizationId,
      medicineId: barcode.presentation.medicineId,
      batchNumber: scan.batchNumber,
    },
    select: { id: true, expiresAt: true, state: true },
  });
  if (!batch) return unverified;
  if (batch.state === 'RECALLED') return { status: 'BLOCKED_RECALL' as const };
  const receipt = await db.pharmacyInventoryLot.findFirst({
    where: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      manufacturingBatchId: batch.id,
      packLevelId: barcode.packLevelId,
      receivedAt: { not: null },
    },
    select: { id: true },
  });
  if (!receipt) return unverified;
  const expiryMismatch =
    parsed.fields.expiryDate !== null &&
    parsed.fields.expiryDate !== batch.expiresAt.toISOString().slice(0, 10);
  const lineMismatch =
    barcode.presentation.medicineId !== input.medicineId ||
    barcode.presentation.id !== input.presentationId ||
    barcode.packLevelId !== input.packLevelId;
  return {
    status: expiryMismatch || lineMismatch ? ('MISMATCH' as const) : ('VERIFIED' as const),
    // This identifies the branch-received manufacturing batch, not a specific
    // allocation lot or a unique physical pack. The caller must compare the
    // effective allocations under the integration's locks.
    evidence: { manufacturingBatchId: batch.id, packLevelId: barcode.packLevelId },
  };
}
