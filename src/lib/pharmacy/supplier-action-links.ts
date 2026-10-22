import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { Prisma } from '@/generated/prisma/client';
import { putUpload } from '@/lib/storage';
import { recordAudit } from '@/server/audit';
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

type SupplierActionAuditTarget = {
  id: string;
  organizationId: string;
  branchId: string;
};

async function liveLink(
  db: ScopedDb,
  token: string,
  now = new Date(),
  onResolved?: (link: SupplierActionAuditTarget) => void
) {
  const id = supplierLinkId(token);
  if (!id) throw new SupplierLinkError('INVALID_LINK');
  const secret = token.split('.')[1]!;
  const link = await db.pharmacySupplierActionLink.findFirst({
    where: {
      id,
      tokenHash: digest(secret),
    },
    include: {
      relationship: { select: { supplierId: true, active: true, revokedAt: true } },
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
  if (link) onResolved?.(link);
  if (
    !link ||
    link.revokedAt ||
    link.expiresAt <= now ||
    !link.relationship.active ||
    link.relationship.revokedAt ||
    link.relationship.supplierId !== link.purchaseOrder.supplierId ||
    link.branchId !== link.purchaseOrder.branchId
  )
    throw new SupplierLinkError('INVALID_LINK');
  return link;
}

function isUniqueConflict(error: unknown) {
  return (error as { code?: unknown } | null)?.code === 'P2002';
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

function auditSupplierAction(
  link: SupplierActionAuditTarget,
  action: 'submit' | 'uploadDocument',
  kind: string,
  outcome: 'SUCCESS' | 'FAILURE',
  error?: unknown
) {
  recordAudit({
    organizationId: link.organizationId,
    actorType: 'ANONYMOUS',
    source: 'TRPC',
    category: 'PHARMACY_SUPPLIER_LINK',
    operation: 'CREATE',
    action: `pharmacySupplierLinks.${action}`,
    targetType: 'PharmacySupplierActionLink',
    targetId: link.id,
    metadata: { branchId: link.branchId, kind },
    outcome,
    errorCode: error instanceof SupplierLinkError ? error.reason : undefined,
  });
}

async function submitSupplierEvidenceInternal(
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
  },
  audit = true
) {
  let auditTarget: SupplierActionAuditTarget | undefined;
  try {
    const link = await liveLink(db, input.token, input.now, (resolved) => {
      auditTarget = resolved;
    });
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
    let result;
    if (existing) {
      if (existing.kind !== input.kind || digest(JSON.stringify(existing.payload)) !== payloadHash)
        throw new SupplierLinkError('IDEMPOTENCY_CONFLICT');
      result = existing;
    } else {
      const prior = input.supersedesId
        ? await db.pharmacySupplierSubmission.findFirst({
            where: { id: input.supersedesId, actionLinkId: link.id, kind: input.kind },
          })
        : null;
      if (input.supersedesId && !prior) throw new SupplierLinkError('INVALID_CORRECTION');
      const id = randomUUID();
      try {
        result = await db.pharmacySupplierSubmission.create({
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
      } catch (error) {
        if (!isUniqueConflict(error)) throw error;
        const raced = await db.pharmacySupplierSubmission.findUnique({
          where: {
            organizationId_actionLinkId_idempotencyKey: {
              organizationId: link.organizationId,
              actionLinkId: link.id,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (!raced) throw error;
        if (raced.kind !== input.kind || digest(JSON.stringify(raced.payload)) !== payloadHash)
          throw new SupplierLinkError('IDEMPOTENCY_CONFLICT');
        result = raced;
      }
    }
    if (audit) auditSupplierAction(link, 'submit', input.kind, 'SUCCESS');
    return result;
  } catch (error) {
    if (audit && auditTarget)
      auditSupplierAction(auditTarget, 'submit', input.kind, 'FAILURE', error);
    throw error;
  }
}

export async function submitSupplierEvidence(
  db: ScopedDb,
  input: Parameters<typeof submitSupplierEvidenceInternal>[1]
) {
  return submitSupplierEvidenceInternal(db, input);
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
  let auditTarget: SupplierActionAuditTarget | undefined;
  try {
    const link = await liveLink(db, input.token, input.now, (resolved) => {
      auditTarget = resolved;
    });
    const file = await (input.scanner ?? structuralSupplierFileScanner).scan({
      content: input.content,
      declaredMimeType: input.declaredMimeType,
    });
    const payload = { fileName: input.fileName, ...file };
    const submission = await submitSupplierEvidenceInternal(
      db,
      {
        token: input.token,
        kind: 'DOCUMENT',
        idempotencyKey: `document:${input.idempotencyKey}`,
        payload,
        now: input.now,
      },
      false
    );
    const objectName = `supplier-po/${link.id}/${file.sha256}`;
    const existing = await db.pharmacySupplierDocument.findUnique({
      where: {
        organizationId_submissionId_sha256: {
          organizationId: link.organizationId,
          submissionId: submission.id,
          sha256: file.sha256,
        },
      },
    });
    if (existing) {
      auditSupplierAction(link, 'uploadDocument', 'DOCUMENT', 'SUCCESS');
      return existing;
    }
    await putUpload(link.organizationId, objectName, input.content, file.mimeType);
    let result = existing;
    if (!result) {
      try {
        result = await db.pharmacySupplierDocument.create({
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
        if (!isUniqueConflict(error)) throw error;
        result = await db.pharmacySupplierDocument.findUnique({
          where: {
            organizationId_submissionId_sha256: {
              organizationId: link.organizationId,
              submissionId: submission.id,
              sha256: file.sha256,
            },
          },
        });
        if (!result) throw error;
      }
    }
    auditSupplierAction(link, 'uploadDocument', 'DOCUMENT', 'SUCCESS');
    return result;
  } catch (error) {
    const mapped =
      error instanceof SupplierFileScanError ? new SupplierLinkError('INVALID_UPLOAD') : error;
    if (auditTarget)
      auditSupplierAction(auditTarget, 'uploadDocument', 'DOCUMENT', 'FAILURE', mapped);
    throw mapped;
  }
}
