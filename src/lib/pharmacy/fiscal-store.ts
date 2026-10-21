import 'server-only';

import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  assertFiscalLinkage,
  beginFiscalAttempt,
  fiscalRetentionUntil,
  receiptFiscalFields,
  selectFiscalIntegrator,
  settleFiscalAttempt,
  type FiscalDocumentKind,
  type FiscalIntegratorMode,
  type FiscalQueueItem,
  type FiscalSubmission,
} from './fiscal';

type FiscalConfigRow = {
  integratorMode: FiscalIntegratorMode;
  maxAttempts: number;
  baseRetrySeconds: number;
};

type FiscalRow = FiscalQueueItem & {
  id: string;
  organizationId: string;
  branchId: string;
  localReference: string;
  kind: FiscalDocumentKind;
  originalLocalReference: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
};

/** Creates durable work only when a tenant explicitly selected an integrator. */
export async function enqueueFiscalDocument(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    saleId?: string | null;
    kind: FiscalDocumentKind;
    originalDocumentId?: string | null;
    localReference: string;
    payload: Record<string, unknown>;
    payloadHash: string;
    actorId: string;
    now?: Date;
  }
): Promise<{ enabled: false } | { enabled: true; documentId: string }> {
  assertFiscalLinkage(input);
  const configs = await db.$queryRaw<FiscalConfigRow[]>(Prisma.sql`
    SELECT "integratorMode", "maxAttempts", "baseRetrySeconds"
    FROM "pharmacy_fiscal_configurations"
    WHERE "organizationId"=${input.organizationId}
    LIMIT 1
  `);
  const config = configs[0];
  if (!config || !selectFiscalIntegrator(config.integratorMode)) return { enabled: false };

  const id = randomUUID();
  const eventId = randomUUID();
  const now = input.now ?? new Date();
  await db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "pharmacy_fiscal_documents"
        ("id","organizationId","branchId","saleId","kind","originalDocumentId",
         "localReference","integratorMode","status","payload","payloadHash","maxAttempts",
         "nextAttemptAt","retentionUntil","createdByActorId","createdAt","updatedAt")
      VALUES
        (${id},${input.organizationId},${input.branchId},${input.saleId ?? null},
         CAST(${input.kind} AS "PharmacyFiscalDocumentKind"),${input.originalDocumentId ?? null},
         ${input.localReference},CAST(${config.integratorMode} AS "PharmacyFiscalIntegratorMode"),
         'QUEUED',${JSON.stringify(input.payload)}::jsonb,${input.payloadHash},${config.maxAttempts},
         ${now},${fiscalRetentionUntil(now)},${input.actorId},${now},${now})
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "pharmacy_fiscal_document_events"
        ("id","organizationId","branchId","documentId","fromStatus","toStatus","attempt","occurredAt")
      VALUES (${eventId},${input.organizationId},${input.branchId},${id},NULL,'QUEUED',0,${now})
    `);
  });
  return { enabled: true, documentId: id };
}

/** Claims and executes one due item. Callers serialize workers at their scheduler boundary. */
export async function processNextFiscalDocument(
  db: ScopedDb,
  input: { organizationId: string; branchId: string; now?: Date }
): Promise<'IDLE' | 'PROCESSED'> {
  const now = input.now ?? new Date();
  const configs = await db.$queryRaw<FiscalConfigRow[]>(Prisma.sql`
    SELECT "integratorMode", "maxAttempts", "baseRetrySeconds"
    FROM "pharmacy_fiscal_configurations"
    WHERE "organizationId"=${input.organizationId}
    LIMIT 1
  `);
  const config = configs[0];
  const integrator = selectFiscalIntegrator(config?.integratorMode);
  if (!config || !integrator) return 'IDLE';

  const rows = await db.$queryRaw<FiscalRow[]>(Prisma.sql`
    SELECT d."id",d."organizationId",d."branchId",d."localReference",d."kind",
           original."localReference" AS "originalLocalReference",d."payload",d."payloadHash",
           d."status",d."attempts",d."maxAttempts",d."nextAttemptAt",
           d."externalReference",d."externalQr",d."lastError"
    FROM "pharmacy_fiscal_documents" d
    LEFT JOIN "pharmacy_fiscal_documents" original
      ON original."organizationId"=d."organizationId" AND original."branchId"=d."branchId"
     AND original."id"=d."originalDocumentId"
    WHERE d."organizationId"=${input.organizationId} AND d."branchId"=${input.branchId}
      AND d."integratorMode"=CAST(${config.integratorMode} AS "PharmacyFiscalIntegratorMode")
      AND d."status"='QUEUED' AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt"<=${now})
    ORDER BY d."createdAt",d."id" LIMIT 1
  `);
  const row = rows[0];
  if (!row) return 'IDLE';
  const active = beginFiscalAttempt(row);
  const claimed = await recordTransition(db, row, active, now, null);
  if (!claimed) return 'IDLE';

  const submission: FiscalSubmission = {
    localReference: row.localReference,
    kind: row.kind,
    originalLocalReference: row.originalLocalReference,
    payloadHash: row.payloadHash,
    payload: row.payload,
  };
  try {
    const result = await integrator.submit(submission);
    const settled = settleFiscalAttempt(active, result, now, config.baseRetrySeconds);
    await recordTransition(db, { ...row, ...active }, settled, now, settled.lastError);
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 500) : 'Integrator unavailable.';
    const settled = settleFiscalAttempt(
      active,
      { outcome: 'TRANSIENT_ERROR', reason },
      now,
      config.baseRetrySeconds
    );
    await recordTransition(db, { ...row, ...active }, settled, now, reason);
  }
  return 'PROCESSED';
}

async function recordTransition(
  db: ScopedDb,
  row: Pick<FiscalRow, 'id' | 'organizationId' | 'branchId' | 'status'>,
  next: FiscalQueueItem,
  now: Date,
  detail: string | null
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "pharmacy_fiscal_documents" SET
        "status"=CAST(${next.status} AS "PharmacyFiscalDocumentStatus"),
        "attempts"=${next.attempts},"nextAttemptAt"=${next.nextAttemptAt},
        "externalReference"=${next.externalReference},"externalQr"=${next.externalQr},
        "lastError"=${next.lastError},"submittedAt"=CASE WHEN ${next.status}='SUBMITTING' THEN ${now} ELSE "submittedAt" END,
        "acceptedAt"=CASE WHEN ${next.status}='ACCEPTED' THEN ${now} ELSE "acceptedAt" END,
        "rejectedAt"=CASE WHEN ${next.status}='REJECTED' THEN ${now} ELSE "rejectedAt" END,
        "updatedAt"=${now}
      WHERE "organizationId"=${row.organizationId} AND "branchId"=${row.branchId}
        AND "id"=${row.id} AND "status"=CAST(${row.status} AS "PharmacyFiscalDocumentStatus")
    `);
    if (updated !== 1) return false;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "pharmacy_fiscal_document_events"
        ("id","organizationId","branchId","documentId","fromStatus","toStatus","attempt","detail","occurredAt")
      VALUES (${randomUUID()},${row.organizationId},${row.branchId},${row.id},
        CAST(${row.status} AS "PharmacyFiscalDocumentStatus"),CAST(${next.status} AS "PharmacyFiscalDocumentStatus"),
        ${next.attempts},${detail},${now})
    `);
    return true;
  });
}

export { receiptFiscalFields };
