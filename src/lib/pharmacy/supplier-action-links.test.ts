import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ putUpload: vi.fn(), deleteUpload: vi.fn() }));
vi.mock('@/lib/storage', () => storage);

import {
  getSupplierActionPage,
  issueSupplierActionLink,
  submitSupplierEvidence,
  supplierLinkId,
  uploadSupplierDocument,
} from './supplier-action-links';
import { structuralSupplierFileScanner } from './supplier-file-scanner';

const NOW = new Date('2026-09-04T12:00:00Z');
// Link expiry is anchored to the run clock so the fixture can never expire mid-gate.
const LINK_TTL_MS = 60 * 60 * 1000;
const linkExpiry = () => new Date(Date.now() + LINK_TTL_MS);

function fakeDb() {
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
        return { ...link, relationship, purchaseOrder };
      }),
    },
    pharmacySupplierSubmission: {
      findUnique: vi.fn(async () => null),
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
    storage.putUpload.mockReset();
    storage.deleteUpload.mockReset();
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
      'pharmacySupplierRelationship',
      'pharmacyPurchaseOrder',
      'pharmacySupplierActionLink',
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

  it('keeps the winning object when concurrent idempotent document uploads race', async () => {
    const state = await issued();
    const file = {
      mimeType: 'application/pdf' as const,
      byteSize: 8,
      sha256: 'same-content-sha256',
      mode: 'STRUCTURAL' as const,
    };
    const submission = {
      id: 'submission_a',
      kind: 'DOCUMENT',
      payload: { fileName: 'invoice.pdf', ...file },
    };
    state.rawDb.pharmacySupplierSubmission.findUnique.mockResolvedValue(submission as never);

    let lookups = 0;
    let releaseLookups!: () => void;
    const bothLookedUp = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    const findUnique = vi.fn(async () => {
      lookups += 1;
      if (lookups === 2) releaseLookups();
      await bothLookedUp;
      return null;
    });
    let creates = 0;
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      creates += 1;
      if (creates === 2) throw new Error('document unique constraint');
      return { id: 'document_winner', ...data };
    });
    const db = state.rawDb as typeof state.rawDb & {
      pharmacySupplierDocument: { findUnique: typeof findUnique; create: typeof create };
    };
    db.pharmacySupplierDocument = { findUnique, create };

    const scanner = { scan: vi.fn(async () => file) };
    const input = {
      token: state.token,
      idempotencyKey: 'same-idempotency-key',
      fileName: 'invoice.pdf',
      declaredMimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.7'),
      now: NOW,
      scanner,
    };
    const attempts = await Promise.allSettled([
      uploadSupplierDocument(state.db, input),
      uploadSupplierDocument(state.db, input),
    ]);

    const winner = attempts.find((attempt) => attempt.status === 'fulfilled');
    expect(winner?.status).toBe('fulfilled');
    const winnerUri =
      winner?.status === 'fulfilled' ? winner.value.document.storageUri : 'missing-winner';
    const uploadedUris = storage.putUpload.mock.calls.map((call) => call[1]);
    expect(new Set(uploadedUris).size).toBe(2);
    expect(storage.deleteUpload).toHaveBeenCalledOnce();
    expect(storage.deleteUpload).not.toHaveBeenCalledWith('org_a', winnerUri);
    expect(uploadedUris).toContain(winnerUri);
  });
});
