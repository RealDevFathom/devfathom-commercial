import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { Prisma } from '@/generated/prisma/client';
import { deleteUpload, putUpload } from '@/lib/storage';
import {
  structuralSupplierFileScanner,
  SupplierFileScanError,
  type FileScanner,
} from './supplier-file-scanner';

export class SupplierLinkError extends Error {
  constructor(
    public readonly reason:
      'INVALID_LINK' | 'MISMATCH' | 'IDEMPOTENCY_CONFLICT' | 'INVALID_UPLOAD' | 'INVALID_CORRECTION'
  ) {
    super(reason);
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
  if (!id || !secret || !supplied || token.length > 512) return null;
  const expected = Buffer.from(signature(`${id}.${secret}`));
  const candidate = Buffer.from(supplied);
  return expected.length === candidate.length && timingSafeEqual(expected, candidate) ? id : null;
}

/** Resolve the tenant-owned identifiers needed to audit a signed-link attempt. */
export async function getSupplierLinkAuditTarget(
  db: ScopedDb,
  token: string,
  organizationId: string
) {
  const id = supplierLinkId(token);
  if (!id) return null;
  const secret = token.split('.')[1]!;
  return db.pharmacySupplierActionLink.findFirst({
    where: { id, organizationId, tokenHash: digest(secret) },
    select: { id: true, organizationId: true, branchId: true },
  });
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
      relationship: { select: { supplierId: true } },
      purchaseOrder: {
        select: {
          id: true,
          reference: true,
          branchId: true,
          supplierId: true,
          expectedDeliveryAt: true,
          lines: {
            select: {
              id: true,
              lineNumber: true,
              medicineId: true,
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
    link.relationship.supplierId !== link.purchaseOrder.supplierId ||
    link.branchId !== link.purchaseOrder.branchId
  )
    throw new SupplierLinkError('INVALID_LINK');
  return link;
}

export async function getSupplierActionPage(db: ScopedDb, token: string) {
  const link = await liveLink(db, token);
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

export async function submitSupplierEvidence(
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
  const payloadHash = digest(JSON.stringify(input.payload));
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
    if (existing.kind !== input.kind || digest(JSON.stringify(existing.payload)) !== payloadHash)
      throw new SupplierLinkError('IDEMPOTENCY_CONFLICT');
    return existing;
  }
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
      payload: input.payload as Prisma.InputJsonValue,
    },
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

export async function uploadSupplierDocument(
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
  const submission = await submitSupplierEvidence(db, {
    token: input.token,
    kind: 'DOCUMENT',
    idempotencyKey: `document:${input.idempotencyKey}`,
    payload,
    now: input.now,
  });
  const existing = await db.pharmacySupplierDocument.findUnique({
    where: {
      organizationId_submissionId_sha256: {
        organizationId: link.organizationId,
        submissionId: submission.id,
        sha256: file.sha256,
      },
    },
  });
  if (existing) return { document: existing, storedObjectCreated: false };

  // Include the submission in the key so compensation can never remove an
  // object referenced by an earlier submission with identical contents.
  const objectName = `supplier-po/${link.id}/${submission.id}/${file.sha256}`;
  await putUpload(link.organizationId, objectName, input.content, file.mimeType);
  let document;
  try {
    document = await db.pharmacySupplierDocument.create({
      data: {
        organizationId: link.organizationId,
        branchId: link.branchId,
        submissionId: submission.id,
        fileName: input.fileName,
        ...file,
        storageUri: objectName,
        scanMode: file.mode,
        malwareChecked: file.mode === 'MALWARE_SCANNED',
      },
    });
  } catch (error) {
    await deleteUpload(link.organizationId, objectName);
    throw error;
  }
  return { document, storedObjectCreated: true };
}

/** Undo the non-transactional storage part of a failed document transaction. */
export async function compensateSupplierDocumentUpload(
  organizationId: string,
  upload: Awaited<ReturnType<typeof uploadSupplierDocument>>
): Promise<void> {
  if (upload.storedObjectCreated) await deleteUpload(organizationId, upload.document.storageUri);
}
