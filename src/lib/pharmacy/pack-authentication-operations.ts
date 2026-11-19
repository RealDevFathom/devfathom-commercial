import 'server-only';

import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { normalizeMedicineText } from './medicine';
import { parseGs1DataMatrix } from './gs1-datamatrix';
import { evaluatePackAuthentication } from './pack-authentication';
import type { PharmacyReportDimensions } from './report-dimensions';

type AuthenticationSource = 'RECEIVING' | 'DISPENSING';

function expiryCode(date: Date) {
  return date.toISOString().slice(2, 10).replaceAll('-', '');
}

export async function authenticatePharmacyPack(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    actorId: string;
    source: AuthenticationSource;
    payload: string;
  }
) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: input.branchId, organizationId: input.organizationId, active: true },
    select: { id: true },
  });
  // The scan's refusal is the operator's to read, so it travels as a deliberate
  // TRPCError: a plain Error reaches a production client only as "Something went wrong".
  if (!branch)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your pharmacy scope.' });

  const parsed = parseGs1DataMatrix(input.payload);
  const fields = parsed.kind === 'parsed' ? parsed.fields : null;
  const barcode = fields
    ? await db.medicineBarcode.findFirst({
        where: {
          organizationId: input.organizationId,
          normalizedCode: normalizeMedicineText(fields.gtin),
        },
        select: { presentation: { select: { medicineId: true } } },
      })
    : null;
  const medicineId = barcode?.presentation.medicineId ?? null;
  const batch =
    fields?.batch && medicineId
      ? await db.pharmacyManufacturingBatch.findFirst({
          where: {
            organizationId: input.organizationId,
            medicineId,
            batchNumber: fields.batch,
          },
          select: { id: true, batchNumber: true, expiresAt: true, state: true },
        })
      : null;
  const prior = fields?.serial
    ? await db.pharmacyPackAuthenticationScan.findFirst({
        where: {
          organizationId: input.organizationId,
          serial: fields.serial,
          OR: [
            { gtin: { not: fields.gtin } },
            { batchNumber: { not: fields.batch } },
            { expiresOn: { not: fields.expiry } },
          ],
        },
        select: { id: true },
      })
    : null;
  const verdict = evaluatePackAuthentication({
    parsed,
    knownMedicineId: medicineId,
    recordedBatch: batch
      ? {
          id: batch.id,
          // Found by the scanned batch number, so it is recorded.
          batchNumber: batch.batchNumber ?? fields!.batch!,
          expiry: batch.expiresAt === null ? null : expiryCode(batch.expiresAt),
          recalled: batch.state === 'RECALLED',
        }
      : null,
    serialSeenOnDifferentPack: Boolean(prior),
  });
  const scan = await db.pharmacyPackAuthenticationScan.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      source: input.source,
      status: verdict.status,
      gtin: verdict.parsed?.gtin,
      batchNumber: verdict.parsed?.batch,
      expiresOn: verdict.parsed?.expiry,
      serial: verdict.parsed?.serial,
      medicineId,
      manufacturingBatchId: batch?.id,
      issues: verdict.issues,
      explanation: verdict.explanation,
      advisory: verdict.advisory,
      scannedByUserId: input.actorId,
      events: {
        create: {
          kind: 'SCANNED',
          actorId: input.actorId,
        },
      },
    },
  });
  return { ...verdict, id: scan.id };
}

export async function acknowledgePackAuthenticationFlag(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    scanId: string;
    actorId: string;
    reason: string;
  },
  at = new Date()
) {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) throw new Error('Give an acknowledgement reason.');
  const updated = await db.pharmacyPackAuthenticationScan.updateMany({
    where: {
      id: input.scanId,
      organizationId: input.organizationId,
      branchId: input.branchId,
      status: { in: ['FLAGGED', 'NOT_VERIFIABLE', 'BLOCKED_RECALL'] },
      acknowledgedAt: null,
    },
    data: {
      acknowledgedAt: at,
      acknowledgedByUserId: input.actorId,
      acknowledgementReason: reason,
    },
  });
  if (updated.count !== 1) throw new Error('Open authentication flag not found.');
  await db.pharmacyPackAuthenticationEvent.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      scanId: input.scanId,
      kind: 'ACKNOWLEDGED',
      actorId: input.actorId,
      reason,
    },
  });
}

/**
 * Unverified pack scans for the report branches. A scan records the medicine and manufacturing
 * batch it matched, so batch and ingredient filters narrow it (DEV-256); it records no supplier,
 * so a supplier filter cannot be applied and the flags read as unavailable (`null`).
 */
export async function readPackAuthenticationFlags(
  db: ScopedDb,
  branchIds: string[],
  dimensions: PharmacyReportDimensions & { organizationId?: string } = {}
) {
  if (dimensions.supplierId) return null;
  if (!branchIds.length) return [];
  if (dimensions.ingredientId && !dimensions.organizationId)
    throw new Error('PACK_AUTHENTICATION_SCOPE_REQUIRED');
  const medicineIds = dimensions.ingredientId
    ? (
        await db.medicineStrengthComponent.findMany({
          where: { organizationId: dimensions.organizationId, ingredientId: dimensions.ingredientId },
          select: { medicineId: true },
        })
      ).map((row) => row.medicineId)
    : null;
  return db.pharmacyPackAuthenticationScan.findMany({
    where: {
      branchId: { in: branchIds },
      status: { not: 'VERIFIED' },
      ...(dimensions.batchId ? { manufacturingBatchId: dimensions.batchId } : {}),
      ...(medicineIds ? { medicineId: { in: medicineIds } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}
