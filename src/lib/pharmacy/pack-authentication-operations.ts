import 'server-only';

import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { normalizeMedicineText } from './medicine';
import { parseGs1DataMatrix } from './gs1-datamatrix';
import { evaluatePackAuthentication } from './pack-authentication';
import {
  activeReportDimensions,
  andMedicineHasIngredient,
  lotFromSupplier,
  type PharmacyReportDimensions,
} from './report-dimensions';

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
          batchNumber: batch.batchNumber,
          expiry: expiryCode(batch.expiresAt),
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
 * #402: `dimensions` narrows the flags before the 200-row cap: an ingredient through the
 * scan's resolved medicine, a batch through its resolved manufacturing batch, and a
 * supplier when a lot of that batch at the scan's branch came from the supplier. A scan
 * whose medicine or batch could not be resolved matches none of those filters.
 */
export async function readPackAuthenticationFlags(
  db: ScopedDb,
  branchIds: string[],
  dimensions: PharmacyReportDimensions = {}
) {
  if (!branchIds.length) return [];
  if (!activeReportDimensions(dimensions).length)
    return db.pharmacyPackAuthenticationScan.findMany({
      where: { branchId: { in: branchIds }, status: { not: 'VERIFIED' } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  const matched = await db.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT s."id" FROM "pharmacy_pack_authentication_scans" s WHERE s."branchId" IN (${Prisma.join(branchIds)}) AND s."status"<>'VERIFIED'${andMedicineHasIngredient(
      dimensions,
      { id: Prisma.sql`s."medicineId"`, organizationId: Prisma.sql`s."organizationId"` }
    )}${dimensions.batchId ? Prisma.sql` AND s."manufacturingBatchId"=${dimensions.batchId}` : Prisma.empty}${
      dimensions.supplierId
        ? Prisma.sql` AND EXISTS (SELECT 1 FROM "pharmacy_inventory_lots" lot WHERE lot."organizationId"=s."organizationId" AND lot."branchId"=s."branchId" AND lot."manufacturingBatchId"=s."manufacturingBatchId" AND ${lotFromSupplier(dimensions.supplierId)})`
        : Prisma.empty
    } ORDER BY s."createdAt" DESC, s."id" DESC LIMIT 200`
  );
  if (!matched.length) return [];
  const order = new Map(matched.map((row, index) => [row.id, index]));
  const rows = await db.pharmacyPackAuthenticationScan.findMany({
    where: { id: { in: matched.map((row) => row.id) }, branchId: { in: branchIds } },
  });
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}
