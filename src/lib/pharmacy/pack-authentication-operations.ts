import 'server-only';

import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { normalizeMedicineText } from './medicine';
import { parseGs1DataMatrix } from './gs1-datamatrix';
import { evaluatePackAuthentication } from './pack-authentication';

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
        select: { packLevelId: true, presentation: { select: { medicineId: true } } },
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
  const evaluated = evaluatePackAuthentication({
    parsed,
    knownMedicineId: medicineId,
    recordedBatch: batch
      ? {
          id: batch.id,
          batchNumber: batch.batchNumber,
          expiry: expiryCode(batch.expiresAt),
          recalled: batch.state === 'RECALLED',
        }
      : null,
    serialSeenOnDifferentPack: Boolean(prior),
  });
  // An organization-wide batch record is not evidence that this branch ever
  // received the pack. Keep an absent branch receipt unverified, not mismatched.
  // Receiving scans occur before a lot may exist, so this check is dispensing-only.
  const branchReceipt =
    input.source === 'DISPENSING' &&
    batch &&
    barcode?.packLevelId &&
    evaluated.status === 'VERIFIED'
      ? await db.pharmacyInventoryLot.findFirst({
          where: {
            organizationId: input.organizationId,
            branchId: input.branchId,
            manufacturingBatchId: batch.id,
            packLevelId: barcode.packLevelId,
            receivedAt: { not: null },
          },
          select: { id: true },
        })
      : null;
  const verdict =
    input.source === 'DISPENSING' && evaluated.status === 'VERIFIED' && !branchReceipt
      ? {
          ...evaluated,
          status: 'NOT_VERIFIABLE' as const,
          issues: ['NOT_VERIFIABLE'] as typeof evaluated.issues,
          explanation:
            'This pack and batch cannot be matched to a recorded receipt at this branch.',
          advisory: true,
        }
      : evaluated;
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

export async function readPackAuthenticationFlags(db: ScopedDb, branchIds: string[]) {
  if (!branchIds.length) return [];
  return db.pharmacyPackAuthenticationScan.findMany({
    where: { branchId: { in: branchIds }, status: { not: 'VERIFIED' } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}
