import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSupplierActionPage,
  issueSupplierActionLink,
  submitSupplierEvidence,
  supplierLinkId,
  SUPPLIER_LINK_LIMITS,
  uploadSupplierDocument,
} from './supplier-action-links';
vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));
vi.mock('@/lib/storage', () => ({ putUpload: vi.fn().mockResolvedValue({}) }));
import { putUpload } from '@/lib/storage';
import { structuralSupplierFileScanner } from './supplier-file-scanner';

const NOW = new Date('2026-09-04T12:00:00Z');
// Link expiry is anchored to the run clock so the fixture can never expire mid-gate.
const LINK_TTL_MS = 60 * 60 * 1000;
const linkExpiry = () => new Date(Date.now() + LINK_TTL_MS);

function fakeDb() {
  const documents: Record<string, unknown>[] = [];
  const stored: Record<string, unknown>[] = [];
  const relationship = {
    id: 'rel_a',
    organizationId: 'org_a',
    branchId: 'branch_a',
    supplierId: 'supplier_a',
    active: true,
    revokedAt: null,
  };
  const purchaseOrder = {
    id: 'po_a',
    reference: 'PO-1',
    branchId: 'branch_a',
    supplierId: 'supplier_a',
    expectedDeliveryAt: null,
    lines: [
      { id: 'line_a', lineNumber: 1, medicineId: 'med_a', packLevelId: 'pack_a', orderedPacks: 4 },
    ],
  };
  const db = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(db)),
    $queryRaw: vi.fn(async () => []),
    pharmacySupplierRelationship: { findFirst: vi.fn(async () => relationship) },
    pharmacyPurchaseOrder: { findFirst: vi.fn(async () => purchaseOrder) },
    pharmacySupplierActionLink: {
      create: vi.fn(async ({ data }) => {
        stored.push(data);
        return data;
      }),
      findFirst: vi.fn(async ({ where }) => {
        const link = stored.find((row) => row.id === where.id);
        if (!link || where.expiresAt.gt >= (link.expiresAt as Date) || link.revokedAt) return null;
        return {
          ...link,
          relationship,
          purchaseOrder,
          _count: {
            submissions: stored.filter(
              (row) => row.actionLinkId === link.id && row.source === 'SIGNED_LINK'
            ).length,
          },
        };
      }),
    },
    pharmacySupplierDocument: {
      count: vi.fn(async () => documents.length),
      findUnique: vi.fn(
        async ({ where }) =>
          documents.find(
            (row) =>
              row.submissionId === where.organizationId_submissionId_sha256.submissionId &&
              row.sha256 === where.organizationId_submissionId_sha256.sha256
          ) ?? null
      ),
      create: vi.fn(async ({ data }) => {
        const row = { id: `doc-${documents.length}`, ...data };
        documents.push(row);
        return row;
      }),
    },
    pharmacySupplierSubmission: {
      findUnique: vi.fn(
        async ({ where }) =>
          stored.find(
            (row) =>
              row.actionLinkId === where.organizationId_actionLinkId_idempotencyKey.actionLinkId &&
              row.idempotencyKey === where.organizationId_actionLinkId_idempotencyKey.idempotencyKey
          ) ?? null
      ),
      findMany: vi.fn(async ({ where }) =>
        stored.filter(
          (row) => row.actionLinkId === where.actionLinkId && row.source === where.source
        )
      ),
      findFirst: vi.fn(async ({ where }) => stored.find((row) => row.id === where.id) ?? null),
      create: vi.fn(async ({ data }) => {
        stored.push(data);
        return data;
      }),
    },
  };
  return { db: db as never, rawDb: db, stored, relationship, purchaseOrder };
}

async function issued() {
  const state = fakeDb();
  const result = await issueSupplierActionLink(state.db, {
    organizationId: 'org_a',
    branchId: 'branch_a',
    relationshipId: 'rel_a',
    purchaseOrderId: 'po_a',
    actorUserId: 'user_a',
    expiresAt: linkExpiry(),
  });
  return { ...state, token: result.token };
}

describe('supplier PO action links — SUP-01 and invariants 24-28', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = 'test-only-secret-at-least-32-characters';
  });

  it('24: rejects a relationship/PO supplier mismatch and exposes only the linked PO projection', async () => {
    const state = fakeDb();
    state.purchaseOrder.supplierId = 'supplier_b';
    await expect(
      issueSupplierActionLink(state.db, {
        organizationId: 'org_a',
        branchId: 'branch_a',
        relationshipId: 'rel_a',
        purchaseOrderId: 'po_a',
        actorUserId: 'user_a',
        expiresAt: linkExpiry(),
      })
    ).rejects.toMatchObject({ reason: 'MISMATCH' });
    state.purchaseOrder.supplierId = 'supplier_a';
    const live = await issued();
    expect(await getSupplierActionPage(live.db, live.token)).toEqual({
      reference: 'PO-1',
      expectedDeliveryAt: null,
      lines: live.purchaseOrder.lines,
    });
  });

  it('25/26: supplier submission writes proposal evidence only and grants no approval operation', async () => {
    const state = await issued();
    const result = await submitSupplierEvidence(state.db, {
      token: state.token,
      kind: 'SUBSTITUTION_PROPOSAL',
      idempotencyKey: 'idem-1',
      payload: { proposal: true, description: 'alternate pack' },
      now: NOW,
    });
    expect(result).toMatchObject({ kind: 'SUBSTITUTION_PROPOSAL', source: 'SIGNED_LINK' });
    expect(Object.keys(state.db)).toEqual([
      '$transaction',
      '$queryRaw',
      'pharmacySupplierRelationship',
      'pharmacyPurchaseOrder',
      'pharmacySupplierActionLink',
      'pharmacySupplierDocument',
      'pharmacySupplierSubmission',
    ]);
  });

  it('27: corrections append a linked next version instead of updating history', async () => {
    const state = await issued();
    const first = await submitSupplierEvidence(state.db, {
      token: state.token,
      kind: 'ETA',
      idempotencyKey: 'eta-1',
      payload: { eta: '2026-09-06T12:00:00Z' },
      now: NOW,
    });
    const second = await submitSupplierEvidence(state.db, {
      token: state.token,
      kind: 'ETA',
      idempotencyKey: 'eta-2',
      payload: { eta: '2026-09-07T12:00:00Z' },
      supersedesId: first.id,
      now: NOW,
    });
    expect(second).toMatchObject({ supersedesId: first.id, versionGroupId: first.id, version: 2 });
    expect(state.rawDb.pharmacySupplierSubmission.create).toHaveBeenCalledTimes(2);
  });

  it('28: fails closed for unlinked PO lines, content-type spoofing, oversize files, and idempotency mismatch', async () => {
    const state = await issued();
    await expect(
      submitSupplierEvidence(state.db, {
        token: state.token,
        kind: 'PARTIAL_ACCEPTANCE',
        idempotencyKey: 'partial',
        payload: { quantities: { line_other: 1 } },
        now: NOW,
      })
    ).rejects.toMatchObject({ reason: 'MISMATCH' });
    await expect(
      structuralSupplierFileScanner.scan({
        content: Buffer.from('%PDF-1.7'),
        declaredMimeType: 'image/png',
      })
    ).rejects.toThrow();
    await expect(
      structuralSupplierFileScanner.scan({
        content: Buffer.alloc(10 * 1024 * 1024 + 1),
        declaredMimeType: 'application/pdf',
      })
    ).rejects.toThrow();
    state.rawDb.pharmacySupplierSubmission.findUnique.mockResolvedValueOnce({
      kind: 'ETA',
      payload: { eta: '2026-09-06T12:00:00Z' },
    } as never);
    await expect(
      submitSupplierEvidence(state.db, {
        token: state.token,
        kind: 'ETA',
        idempotencyKey: 'same',
        payload: { eta: '2026-09-07T12:00:00Z' },
        now: NOW,
      })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects forged, expired, and revoked links without revealing which condition failed', async () => {
    const state = await issued();
    expect(supplierLinkId(`${state.token}.extra`)).toBeNull();
    expect(supplierLinkId(`${state.token}x`)).toBeNull();
    await expect(getSupplierActionPage(state.db, `${state.token}x`)).rejects.toMatchObject({
      reason: 'INVALID_LINK',
    });
    await expect(
      submitSupplierEvidence(state.db, {
        token: state.token,
        kind: 'ACKNOWLEDGEMENT',
        idempotencyKey: 'late',
        payload: {},
        now: new Date(Date.now() + 2 * LINK_TTL_MS),
      })
    ).rejects.toMatchObject({ reason: 'INVALID_LINK' });
    (state.stored[0] as { revokedAt: Date | null }).revokedAt = NOW;
    await expect(getSupplierActionPage(state.db, state.token)).rejects.toMatchObject({
      reason: 'INVALID_LINK',
    });
  });
});

describe('supplier link lifetime budgets', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_SECRET', 'quota-test-key');
    vi.mocked(putUpload).mockClear();
  });
  it('serializes concurrent submissions sharing a transaction and preserves retries at capacity', async () => {
    const s = await issued();
    for (let i = 0; i < SUPPLIER_LINK_LIMITS.submissions - 1; i++)
      s.stored.push({
        id: `old-${i}`,
        actionLinkId: s.stored[0].id,
        source: 'SIGNED_LINK',
        kind: 'ACKNOWLEDGEMENT',
        payload: {},
      });
    const input = {
      token: s.token,
      kind: 'ACKNOWLEDGEMENT' as const,
      payload: {},
      idempotencyKey: 'last',
    };
    const results = await Promise.allSettled([
      submitSupplierEvidence(s.db, input),
      submitSupplierEvidence(s.db, { ...input, idempotencyKey: 'over' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { reason: 'LINK_LIMIT_EXCEEDED' } });
    await expect(submitSupplierEvidence(s.db, input)).resolves.toMatchObject({
      idempotencyKey: 'last',
    });
    await expect(
      submitSupplierEvidence(s.db, { ...input, supersedesId: 'changed' })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      submitSupplierEvidence(s.db, {
        ...input,
        idempotencyKey: 'correction-over',
        supersedesId: (results[0] as PromiseFulfilledResult<{ id: string }>).value.id,
      })
    ).rejects.toMatchObject({ reason: 'LINK_LIMIT_EXCEEDED' });
    expect(s.rawDb.pharmacySupplierSubmission.create).toHaveBeenCalledTimes(1);
  });
  it('bounds each payload and cumulative UTF-8 payload bytes, including corrections', async () => {
    const s = await issued();
    const input = {
      token: s.token,
      kind: 'ACKNOWLEDGEMENT' as const,
      idempotencyKey: 'large',
      payload: { text: 'é'.repeat(SUPPLIER_LINK_LIMITS.payloadBytes) },
    };
    await expect(submitSupplierEvidence(s.db, input)).rejects.toMatchObject({
      reason: 'LINK_LIMIT_EXCEEDED',
    });
    s.stored.push({
      actionLinkId: s.stored[0].id,
      source: 'SIGNED_LINK',
      kind: 'ACKNOWLEDGEMENT',
      payload: { text: 'x'.repeat(SUPPLIER_LINK_LIMITS.totalPayloadBytes) },
    });
    await expect(submitSupplierEvidence(s.db, { ...input, payload: {} })).rejects.toMatchObject({
      reason: 'LINK_LIMIT_EXCEEDED',
    });
    expect(s.rawDb.pharmacySupplierSubmission.create).not.toHaveBeenCalled();
  });
  it.each(['count', 'bytes'] as const)(
    'reserves document %s before any blob write and skips storage for a retry',
    async (limit) => {
      const s = await issued();
      const count = limit === 'count' ? SUPPLIER_LINK_LIMITS.documents - 1 : 1;
      for (let i = 0; i < count; i++)
        s.stored.push({
          actionLinkId: s.stored[0].id,
          source: 'SIGNED_LINK',
          kind: 'DOCUMENT',
          payload: { byteSize: limit === 'bytes' ? SUPPLIER_LINK_LIMITS.documentBytes - 8 : 1 },
        });
      const input = {
        token: s.token,
        idempotencyKey: 'last',
        fileName: 'invoice.pdf',
        declaredMimeType: 'application/pdf',
        content: Buffer.from('%PDF-1.7'),
      };
      const results = await Promise.allSettled([
        uploadSupplierDocument(s.db, input),
        uploadSupplierDocument(s.db, { ...input, idempotencyKey: 'over' }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      expect(results[1]).toMatchObject({ reason: { reason: 'LINK_LIMIT_EXCEEDED' } });
      await expect(uploadSupplierDocument(s.db, input)).resolves.toMatchObject({
        fileName: input.fileName,
      });
      expect(putUpload).toHaveBeenCalledTimes(1);
    }
  );
  it('does not let submit manufacture a document reservation', async () => {
    const s = await issued();
    await expect(
      submitSupplierEvidence(s.db, {
        token: s.token,
        kind: 'DOCUMENT',
        idempotencyKey: 'fake',
        payload: { byteSize: 0 },
      })
    ).rejects.toMatchObject({ reason: 'INVALID_UPLOAD' });
  });
});

it('claims a scanned document as purchase order evidence using a local-store-compatible name', async () => {
  vi.stubEnv('AUTH_SECRET', 'synthetic-test-signing-key');
  const s = await issued();
  const doc = await uploadSupplierDocument(s.db, {
    token: s.token,
    idempotencyKey: 'invoice',
    fileName: 'invoice.pdf',
    declaredMimeType: 'application/pdf',
    content: Buffer.from('%PDF-1.7'),
  });
  expect(doc.ownerType).toBe('PHARMACY_PURCHASE_ORDER');
  expect(doc.storageUri).toMatch(/^supplier-po-[a-f0-9-]+$/);
});

it('refuses a page after the last available response has been used', async () => {
  vi.stubEnv('AUTH_SECRET', 'synthetic-test-signing-key');
  const s = await issued();
  for (let i = 0; i < SUPPLIER_LINK_LIMITS.submissions; i++)
    s.stored.push({ actionLinkId: s.stored[0].id, source: 'SIGNED_LINK' });
  await expect(getSupplierActionPage(s.db, s.token)).rejects.toMatchObject({
    reason: 'INVALID_LINK',
  });
});

it('refuses a full order even when the current link still has room', async () => {
  vi.stubEnv('AUTH_SECRET', 'synthetic-test-signing-key');
  const s = await issued();
  s.rawDb.pharmacySupplierDocument.count.mockResolvedValue(SUPPLIER_LINK_LIMITS.documents);
  await expect(
    uploadSupplierDocument(s.db, {
      token: s.token,
      idempotencyKey: 'later',
      fileName: 'invoice.pdf',
      declaredMimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.7'),
    })
  ).rejects.toMatchObject({ reason: 'LINK_LIMIT_EXCEEDED' });
  expect(s.rawDb.pharmacySupplierDocument.create).not.toHaveBeenCalled();
});
