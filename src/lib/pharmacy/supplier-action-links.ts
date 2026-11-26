import { isDeepStrictEqual } from 'node:util';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { Prisma } from '@/generated/prisma/client';
import { recordAudit } from '@/server/audit';
import { putUpload } from '@/lib/storage';
import {
  structuralSupplierFileScanner,
  SupplierFileScanError,
  type FileScanner,
} from './supplier-file-scanner';

export class SupplierLinkError extends Error {
  constructor(
    public readonly reason:
      | 'INVALID_LINK'
      | 'MISMATCH'
      | 'IDEMPOTENCY_CONFLICT'
      | 'INVALID_UPLOAD'
      | 'INVALID_CORRECTION'
      | 'LINK_LIMIT_EXCEEDED',
    public readonly exhausted = false
  ) {
    super(reason);
  }
}

// Lifetime budgets, shared by submissions, corrections, and document reservations.
export const SUPPLIER_LINK_LIMITS = {
  submissions: 100,
  payloadBytes: 64 * 1024,
  totalPayloadBytes: 1024 * 1024,
  documents: 20,
  documentBytes: 50 * 1024 * 1024,
} as const;

// A tRPC batch can share one transaction: PostgreSQL locks are reentrant there.
// Queue those callbacks too; the row lock serializes independent requests/processes.
const linkQueues = new WeakMap<object, Map<string, Promise<unknown>>>();
async function withLinkWrite<T>(db: ScopedDb, token: string, run: (tx: ScopedDb) => Promise<T>) {
  const id = supplierLinkId(token);
  if (!id) throw new SupplierLinkError('INVALID_LINK');
  let queues = linkQueues.get(db);
  if (!queues) linkQueues.set(db, (queues = new Map()));
  const previous = queues.get(id) ?? Promise.resolve();
  const work = previous
    .catch(() => undefined)
    .then(() =>
      db.$transaction(async (inner) => {
        const tx = inner as ScopedDb;
        await tx.$queryRaw`SELECT id FROM pharmacy_supplier_action_links WHERE id=${id} FOR UPDATE`;
        return run(tx);
      })
    );
  queues.set(id, work);
  try {
    return await work;
  } finally {
    if (queues.get(id) === work) queues.delete(id);
  }
}

async function assertLinkBudget(
  db: ScopedDb,
  actionLinkId: string,
  payload: Record<string, unknown>,
  kind: string
) {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > SUPPLIER_LINK_LIMITS.payloadBytes) throw new SupplierLinkError('LINK_LIMIT_EXCEEDED');
  const rows = await db.pharmacySupplierSubmission.findMany({
    where: { actionLinkId, source: 'SIGNED_LINK' },
    select: { kind: true, payload: true },
    take: SUPPLIER_LINK_LIMITS.submissions + 1,
  });
  const documents = rows.filter((row) => row.kind === 'DOCUMENT');
  const usedBytes = rows.reduce(
    (sum, row) => sum + Buffer.byteLength(JSON.stringify(row.payload), 'utf8'),
    0
  );
  // DOCUMENT submissions reserve bytes before storage is written. Failed/retried
  // uploads cannot race a separate document-table count or escape the budget.
  const reservedBytes = documents.reduce((sum, row) => {
    const size = (row.payload as Record<string, unknown>).byteSize;
    return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0
      ? sum + size
      : Infinity;
  }, 0);
  if (rows.length >= SUPPLIER_LINK_LIMITS.submissions)
    throw new SupplierLinkError('LINK_LIMIT_EXCEEDED', true);
  if (
    usedBytes + bytes > SUPPLIER_LINK_LIMITS.totalPayloadBytes ||
    (kind === 'DOCUMENT' &&
      (documents.length >= SUPPLIER_LINK_LIMITS.documents ||
        typeof payload.byteSize !== 'number' ||
        !Number.isSafeInteger(payload.byteSize) ||
        payload.byteSize < 0 ||
        reservedBytes + payload.byteSize > SUPPLIER_LINK_LIMITS.documentBytes))
  ) {
    throw new SupplierLinkError('LINK_LIMIT_EXCEEDED');
  }
}

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const signingKey = () => {
  const key = process.env.AUTH_SECRET;
  if (!key) throw new Error('AUTH_SECRET is required to issue or validate supplier action links.');
  return key;
};

function signature(body: string) {
  return createHmac('sha256', signingKey())
    .update(`supplier-po-link:v1:${body}`)
    .digest('base64url');
}

export function supplierLinkId(token: string): string | null {
  const [id, secret, supplied] = token.split('.');
  if (token.split('.').length !== 3 || !id || !secret || !supplied || token.length > 512)
    return null;
  const expected = Buffer.from(signature(`${id}.${secret}`));
  const candidate = Buffer.from(supplied);
  return expected.length === candidate.length && timingSafeEqual(expected, candidate) ? id : null;
}

export async function issueSupplierActionLink(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    relationshipId: string;
    purchaseOrderId: string;
    actorUserId: string;
    expiresAt: Date;
  }
) {
  const [relationship, purchaseOrder] = await Promise.all([
    db.pharmacySupplierRelationship.findFirst({
      where: { id: input.relationshipId, branchId: input.branchId, active: true, revokedAt: null },
    }),
    db.pharmacyPurchaseOrder.findFirst({
      where: { id: input.purchaseOrderId, branchId: input.branchId },
      select: { id: true, supplierId: true },
    }),
  ]);
  if (!relationship || !purchaseOrder || relationship.supplierId !== purchaseOrder.supplierId)
    throw new SupplierLinkError('MISMATCH');
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const body = `${id}.${secret}`;
  await db.pharmacySupplierActionLink.create({
    data: {
      id,
      organizationId: input.organizationId,
      branchId: input.branchId,
      supplierRelationshipId: input.relationshipId,
      purchaseOrderId: input.purchaseOrderId,
      tokenHash: digest(secret),
      expiresAt: input.expiresAt,
      createdByUserId: input.actorUserId,
    },
  });
  return { token: `${body}.${signature(body)}`, expiresAt: input.expiresAt };
}

async function liveLink(db: ScopedDb, token: string, now = new Date()) {
  const id = supplierLinkId(token);
  if (!id) throw new SupplierLinkError('INVALID_LINK');
  const secret = token.split('.')[1]!;
  const link = await db.pharmacySupplierActionLink.findFirst({
    where: {
      id,
      tokenHash: digest(secret),
      revokedAt: null,
      expiresAt: { gt: now },
      relationship: { active: true, revokedAt: null },
    },
    include: {
      _count: { select: { submissions: { where: { source: 'SIGNED_LINK' } } } },
      relationship: { select: { supplierId: true, branchId: true } },
      purchaseOrder: {
        select: {
          id: true,
          reference: true,
          branchId: true,
          supplierId: true,
          expectedDeliveryAt: true,
          lines: {
            orderBy: { lineNumber: 'asc' },
            select: {
              id: true,
              lineNumber: true,
              medicineId: true,
              medicine: { select: { productName: true } },
              packLevelId: true,
              orderedPacks: true,
            },
          },
        },
      },
    },
  });
  if (
    !link ||
    link.branchId !== link.relationship.branchId ||
    link.relationship.supplierId !== link.purchaseOrder.supplierId ||
    link.branchId !== link.purchaseOrder.branchId
  )
    throw new SupplierLinkError('INVALID_LINK');
  return link;
}

async function usableLink(db: ScopedDb, token: string) {
  const link = await liveLink(db, token);
  if (link._count.submissions >= SUPPLIER_LINK_LIMITS.submissions)
    throw new SupplierLinkError('INVALID_LINK');
  return link;
}

// Use the same live-link permission check before the HTTP transport reads a file.
// The write checks it again inside the transaction in case it changed mid-upload.
export async function assertSupplierDocumentPermission(db: ScopedDb, token: string) {
  const link = await usableLink(db, token);
  return link.branchId;
}

export async function getSupplierActionPage(db: ScopedDb, token: string) {
  const link = await usableLink(db, token);
  await recordAudit(
    {
      organizationId: link.organizationId,
      actorType: 'ANONYMOUS',
      source: 'TRPC',
      category: 'pharmacy',
      operation: 'READ',
      action: 'pharmacySupplierLinks.get',
      targetType: 'PharmacyPurchaseOrder',
      targetId: link.purchaseOrderId,
      metadata: { branchId: link.branchId, actionLinkId: link.id },
    },
    db
  );
  return {
    reference: link.purchaseOrder.reference,
    expectedDeliveryAt: link.purchaseOrder.expectedDeliveryAt,
    lines: link.purchaseOrder.lines,
  };
}

function validatePayload(kind: string, payload: Record<string, unknown>, lineIds: Set<string>) {
  if (kind === 'PARTIAL_ACCEPTANCE') {
    const quantities = payload.quantities;
    if (!quantities || typeof quantities !== 'object') throw new SupplierLinkError('MISMATCH');
    for (const [lineId, quantity] of Object.entries(quantities))
      if (!lineIds.has(lineId) || !Number.isInteger(quantity) || Number(quantity) < 0)
        throw new SupplierLinkError('MISMATCH');
  }
  if (kind === 'SUBSTITUTION_PROPOSAL' && payload.proposal !== true)
    throw new SupplierLinkError('MISMATCH');
  if (kind === 'ETA' && (typeof payload.eta !== 'string' || Number.isNaN(Date.parse(payload.eta))))
    throw new SupplierLinkError('MISMATCH');
}

async function submitEvidence(
  db: ScopedDb,
  input: {
    token: string;
    kind:
      | 'ACKNOWLEDGEMENT'
      | 'REJECTION'
      | 'PARTIAL_ACCEPTANCE'
      | 'ETA'
      | 'SUBSTITUTION_PROPOSAL'
      | 'DOCUMENT';
    idempotencyKey: string;
    payload: Record<string, unknown>;
    supersedesId?: string;
    now?: Date;
  }
) {
  const link = await liveLink(db, input.token, input.now);
  validatePayload(
    input.kind,
    input.payload,
    new Set(link.purchaseOrder.lines.map((line) => line.id))
  );
  // Compare JSON values, not property insertion order: PostgreSQL JSONB
  // reorders keys, including the payload of a retried document upload.
  const payload = JSON.parse(JSON.stringify(input.payload)) as Prisma.InputJsonValue;
  const existing = await db.pharmacySupplierSubmission.findUnique({
    where: {
      organizationId_actionLinkId_idempotencyKey: {
        organizationId: link.organizationId,
        actionLinkId: link.id,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) {
    if (
      existing.kind !== input.kind ||
      !isDeepStrictEqual(existing.payload, payload) ||
      (existing.supersedesId ?? null) !== (input.supersedesId ?? null)
    )
      throw new SupplierLinkError('IDEMPOTENCY_CONFLICT');
    return existing;
  }
  await assertLinkBudget(db, link.id, input.payload, input.kind);
  const prior = input.supersedesId
    ? await db.pharmacySupplierSubmission.findFirst({
        where: { id: input.supersedesId, actionLinkId: link.id, kind: input.kind },
      })
    : null;
  if (input.supersedesId && !prior) throw new SupplierLinkError('INVALID_CORRECTION');
  const id = randomUUID();
  return db.pharmacySupplierSubmission.create({
    data: {
      id,
      organizationId: link.organizationId,
      branchId: link.branchId,
      actionLinkId: link.id,
      versionGroupId: prior?.versionGroupId ?? id,
      version: (prior?.version ?? 0) + 1,
      supersedesId: prior?.id,
      kind: input.kind,
      source: 'SIGNED_LINK',
      idempotencyKey: input.idempotencyKey,
      payload,
    },
  });
}

export async function submitSupplierEvidence(
  db: ScopedDb,
  input: Parameters<typeof submitEvidence>[1]
) {
  // Documents must pass the byte scanner and storage path, never a forged JSON reservation.
  if (input.kind === 'DOCUMENT') throw new SupplierLinkError('INVALID_UPLOAD');
  return withLinkWrite(db, input.token, async (tx) => {
    const submission = await submitEvidence(tx, input);
    await recordAudit(
      {
        organizationId: submission.organizationId,
        actorType: 'ANONYMOUS',
        source: 'TRPC',
        category: 'pharmacy',
        operation: 'CREATE',
        action: 'pharmacySupplierLinks.submit',
        targetType: 'PharmacySupplierSubmission',
        targetId: submission.id,
        metadata: {
          branchId: submission.branchId,
          actionLinkId: submission.actionLinkId,
          kind: submission.kind,
        },
      },
      tx
    );
    return submission;
  });
}

export async function recordManualSupplierEvidence(
  db: ScopedDb,
  input: {
    actionLinkId: string;
    branchId: string;
    kind: 'ACKNOWLEDGEMENT' | 'REJECTION' | 'PARTIAL_ACCEPTANCE' | 'ETA' | 'SUBSTITUTION_PROPOSAL';
    source: 'PHONE' | 'WHATSAPP';
    sourceEvidence: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }
) {
  const link = await db.pharmacySupplierActionLink.findFirst({
    where: { id: input.actionLinkId, branchId: input.branchId },
    include: { purchaseOrder: { select: { lines: { select: { id: true } } } } },
  });
  if (!link || !input.sourceEvidence.trim()) throw new SupplierLinkError('MISMATCH');
  validatePayload(
    input.kind,
    input.payload,
    new Set(link.purchaseOrder.lines.map((line) => line.id))
  );
  const id = randomUUID();
  return db.pharmacySupplierSubmission.create({
    data: {
      id,
      organizationId: link.organizationId,
      branchId: link.branchId,
      actionLinkId: link.id,
      versionGroupId: id,
      version: 1,
      kind: input.kind,
      source: input.source,
      sourceEvidence: input.sourceEvidence,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload as Prisma.InputJsonValue,
    },
  });
}

async function uploadDocument(
  db: ScopedDb,
  input: {
    token: string;
    idempotencyKey: string;
    fileName: string;
    declaredMimeType: string;
    content: Buffer;
    now?: Date;
    scanner?: FileScanner;
  }
) {
  const link = await liveLink(db, input.token, input.now);
  let file;
  try {
    file = await (input.scanner ?? structuralSupplierFileScanner).scan({
      content: input.content,
      declaredMimeType: input.declaredMimeType,
    });
  } catch (error) {
    if (error instanceof SupplierFileScanError) throw new SupplierLinkError('INVALID_UPLOAD');
    throw error;
  }
  const payload = { fileName: input.fileName, ...file };
  const submission = await submitEvidence(db, {
    token: input.token,
    kind: 'DOCUMENT',
    idempotencyKey: `document:${input.idempotencyKey}`,
    payload,
    now: input.now,
  });
  const objectName = `supplier-po-${link.id}-${file.sha256}`;
  const existing = await db.pharmacySupplierDocument.findUnique({
    where: {
      organizationId_submissionId_sha256: {
        organizationId: link.organizationId,
        submissionId: submission.id,
        sha256: file.sha256,
      },
    },
  });
  if (existing) return existing;
  // Links for the same order share this cap, including a replacement supplier.
  await db.$queryRaw`SELECT id FROM pharmacy_purchase_orders WHERE id=${link.purchaseOrderId} FOR NO KEY UPDATE`;
  const count = await db.pharmacySupplierDocument.count({
    where: {
      organizationId: link.organizationId,
      submission: { actionLink: { purchaseOrderId: link.purchaseOrderId } },
    },
  });
  if (count >= SUPPLIER_LINK_LIMITS.documents) throw new SupplierLinkError('LINK_LIMIT_EXCEEDED');
  await putUpload(link.organizationId, objectName, input.content, file.mimeType);
  const { mode, ...document } = file;
  return db.pharmacySupplierDocument.create({
    data: {
      organizationId: link.organizationId,
      branchId: link.branchId,
      submissionId: submission.id,
      fileName: input.fileName,
      ...document,
      ownerType: 'PHARMACY_PURCHASE_ORDER',
      storageUri: objectName,
      scanMode: mode,
      malwareChecked: mode === 'MALWARE_SCANNED',
    },
  });
}

export async function uploadSupplierDocument(
  db: ScopedDb,
  input: Parameters<typeof uploadDocument>[1]
) {
  return withLinkWrite(db, input.token, (tx) => uploadDocument(tx, input));
}
