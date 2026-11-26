// @vitest-environment node
import { multipartUpload } from '../../../../../../tests/fixtures/multipart-upload';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';

const mocks = vi.hoisted(() => ({
  acquireSlot: vi.fn(),
  attachEvidence: vi.fn(),
  createTRPCContext: vi.fn(),
  deleteUpload: vi.fn(),
  evidenceTarget: vi.fn(),
  createCaller: vi.fn(),
  putUpload: vi.fn(),
  resolveTenantActor: vi.fn(),
}));

vi.mock('@/lib/uploads/large-upload-slot', () => ({ acquireLargeUploadSlot: mocks.acquireSlot }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/sop-execution', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/sop-execution')>(
    '@/lib/restaurant/sop-execution'
  )),
  attachEvidence: mocks.attachEvidence,
}));
vi.mock('@/lib/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage')>()),
  deleteUpload: mocks.deleteUpload,
  putUpload: mocks.putUpload,
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/_app', () => ({
  appRouter: {
    createCaller: mocks.createCaller,
  },
}));

import { POST } from './route';
import { isPharmacySopCapturedEvidence } from '@/lib/pharmacy/sop-evidence';
import { PHARMACY_SOP_CHANGED_MESSAGE } from '@/lib/pharmacy/sop-shared';
import { SopExecutionError } from '@/lib/restaurant/sop-execution';
import { StorageUnavailableError } from '@/lib/storage';

process.env.AUTH_SECRET = 'pharmacy-sop-evidence-route-test-secret';

function request(overrides?: {
  file?: unknown;
  fields?: Record<string, string>;
  origin?: string | null;
  formData?: () => Promise<FormData>;
}) {
  const form = new FormData();
  form.set('pharmacyBranchId', 'pbranch_1');
  form.set('occurrenceId', 'occ_1');
  form.set('occurrenceStepId', 'ostep_1');
  form.set('file', new File(['proof'], 'proof.jpg', { type: 'image/jpeg' }));
  for (const [key, value] of Object.entries(overrides?.fields ?? {})) form.set(key, value);
  if (overrides && 'file' in overrides) {
    const get = form.get.bind(form);
    vi.spyOn(form, 'get').mockImplementation((key) =>
      key === 'file' ? (overrides.file as FormDataEntryValue) : get(key)
    );
  }
  const origin = overrides?.origin === undefined ? 'https://devfathom.test' : overrides.origin;
  // Only synthetic invalid File metadata and parser failures need a test double.
  if (overrides?.formData)
    vi.spyOn(Response.prototype, 'formData').mockImplementationOnce(overrides.formData);
  else if (overrides && 'file' in overrides)
    vi.spyOn(Response.prototype, 'formData').mockResolvedValueOnce(form);
  return new Request('https://devfathom.test/api/pharmacy/sop/evidence', {
    method: 'POST',
    headers: origin ? { origin } : undefined,
    body: form,
  });
}

const TARGET = {
  pharmacyBranchId: 'pbranch_1',
  occurrenceId: 'occ_1',
  occurrenceStepId: 'ostep_1',
  uploaderStaffProfileId: 'staff_me',
};

/** The request's tenant db: one transaction, the receipt table and the engine evidence read. */
function makeDb() {
  const db = {
    $transaction: vi.fn(),
    pharmacySopEvidenceCapture: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    restaurantSopEvidence: { findFirst: vi.fn().mockResolvedValue(null) },
    // The in-transaction share-lock re-check before attaching proof.
    $queryRaw: vi.fn().mockResolvedValue([]),
    restaurantSopOccurrence: {
      findFirst: vi.fn().mockResolvedValue({
        status: 'IN_PROGRESS',
        assignedStaffProfileId: 'staff_me',
        claimedByStaffProfileId: null,
      }),
    },
  };
  db.$transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(db));
  return db;
}

let db: ReturnType<typeof makeDb>;

/** A retry resolves to an engine row that already holds its capture receipt. */
function existingReceiptedRow() {
  db.restaurantSopEvidence.findFirst.mockResolvedValue({
    id: 'ev_1',
    occurrenceId: 'occ_1',
    occurrenceStepId: 'ostep_1',
    contentHash: 'abc',
    mimeType: 'image/jpeg; evidence=photo',
    uploaderStaffProfileId: 'staff_me',
    storageRef: '/api/files/pharmacy-sop-first-attempt.jpg',
  });
  db.pharmacySopEvidenceCapture.findMany.mockResolvedValue([
    { evidenceId: 'ev_1', occurrenceId: 'occ_1', contentHash: 'abc' },
  ]);
}

beforeEach(() => {
  mocks.acquireSlot.mockResolvedValue(async () => {});
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  db = makeDb();
  const session = { user: { id: 'user_1', organizationId: 'org_1' } };
  mocks.resolveTenantActor.mockResolvedValue({
    session,
    organization: { id: 'org_1' },
    support: null,
  });
  mocks.createTRPCContext.mockResolvedValue({ db, organization: { id: 'org_1' }, session });
  mocks.evidenceTarget.mockResolvedValue(TARGET);
  mocks.createCaller.mockImplementation(() => ({
    pharmacySop: { evidenceTarget: mocks.evidenceTarget },
  }));
  mocks.putUpload.mockResolvedValue(undefined);
  mocks.deleteUpload.mockResolvedValue(undefined);
  mocks.attachEvidence.mockResolvedValue({
    evidenceId: 'ev_1',
    contentHash: 'abc',
    createdAt: new Date(),
    created: true,
  });
});

describe('POST pharmacy SOP evidence', () => {
  it('authorizes through the router, then stores and attaches as the session actor', async () => {
    const response = await POST(request({ fields: { uploaderStaffProfileId: 'staff_victim' } }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ evidenceId: 'ev_1', created: true });
    expect(mocks.evidenceTarget).toHaveBeenCalledWith({
      pharmacyBranchId: 'pbranch_1',
      occurrenceId: 'occ_1',
      occurrenceStepId: 'ostep_1',
    });
    // The app router's caller, so the procedure path is `pharmacySop.evidenceTarget`.
    expect(mocks.createCaller).toHaveBeenCalledWith(
      expect.objectContaining({ organization: { id: 'org_1' } })
    );
    expect(mocks.putUpload).toHaveBeenCalledWith(
      'org_1',
      expect.stringMatching(/^pharmacy-sop-[0-9a-f-]{36}-[0-9a-f]{32}\.jpg$/),
      Buffer.from('proof'),
      'image/jpeg'
    );
    expect(mocks.attachEvidence).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        occurrenceId: 'occ_1',
        occurrenceStepId: 'ostep_1',
        mimeType: 'image/jpeg; evidence=photo',
        sizeBytes: 5,
        uploaderStaffProfileId: 'staff_me',
      })
    );
    expect(JSON.stringify(mocks.attachEvidence.mock.calls)).not.toContain('staff_victim');
  });

  it('names the blob so the router recognises exactly this evidence row as pharmacy proof', async () => {
    await POST(request());
    const filename = mocks.putUpload.mock.calls[0]![1] as string;
    const attached = mocks.attachEvidence.mock.calls[0]![1] as {
      storageRef: string;
      contentHashHex: string;
      mimeType: string;
    };
    expect(attached.storageRef).toBe(`/api/files/${filename}`);
    const row = {
      occurrenceId: 'occ_1',
      occurrenceStepId: 'ostep_1',
      contentHash: attached.contentHashHex,
      mimeType: attached.mimeType,
      uploaderStaffProfileId: 'staff_me',
      storageRef: attached.storageRef,
    };
    expect(isPharmacySopCapturedEvidence(row, 'org_1')).toBe(true);
    // Copying the ref onto any other row, tenant or uploader does not carry it over.
    expect(isPharmacySopCapturedEvidence(row, 'org_2')).toBe(false);
    expect(
      isPharmacySopCapturedEvidence({ ...row, uploaderStaffProfileId: 'staff_x' }, 'org_1')
    ).toBe(false);
    expect(isPharmacySopCapturedEvidence({ ...row, occurrenceStepId: 'ostep_2' }, 'org_1')).toBe(
      false
    );
    expect(
      isPharmacySopCapturedEvidence({ ...row, mimeType: 'image/jpeg; evidence=signature' }, 'org_1')
    ).toBe(false);
  });

  it('records signature proof with the signature purpose', async () => {
    await POST(request({ fields: { evidencePurpose: 'signature' } }));
    expect(mocks.attachEvidence).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ mimeType: 'image/jpeg; evidence=signature' })
    );
  });

  it('is idempotent on retry: same evidence id, redundant blob removed', async () => {
    mocks.attachEvidence.mockResolvedValueOnce({
      evidenceId: 'ev_1',
      contentHash: 'abc',
      createdAt: new Date(),
      created: false,
    });
    existingReceiptedRow();
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ evidenceId: 'ev_1', created: false });
    expect(mocks.deleteUpload).toHaveBeenCalledWith('org_1', mocks.putUpload.mock.calls[0]![1]);
  });

  it.each([
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['CONFLICT', 409],
    ['PRECONDITION_FAILED', 412],
    ['UNAUTHORIZED', 401],
  ] as const)('maps a %s authorization refusal to %i and stores nothing', async (code, status) => {
    mocks.evidenceTarget.mockRejectedValueOnce(new TRPCError({ code, message: 'refused' }));
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(mocks.putUpload).not.toHaveBeenCalled();
    expect(mocks.attachEvidence).not.toHaveBeenCalled();
  });

  it('answers a procedure that moved on (stale screen) with 409, its plain words and a conflict mark', async () => {
    mocks.evidenceTarget.mockRejectedValueOnce(
      new TRPCError({ code: 'CONFLICT', message: PHARMACY_SOP_CHANGED_MESSAGE })
    );
    const response = await POST(request());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: PHARMACY_SOP_CHANGED_MESSAGE,
      conflict: true,
    });
    expect(mocks.putUpload).not.toHaveBeenCalled();
  });

  it.each([
    ['sent for review from another tab during the upload', { status: 'SUBMITTED' }],
    ['now late and in review', { status: 'LATE' }],
    ['claimed by someone else meanwhile', { assignedStaffProfileId: 'staff_other' }],
    ['gone', null],
  ])(
    'refuses proof when the procedure was %s after authorization: 409 conflict, nothing kept',
    async (_label, change) => {
      db.restaurantSopOccurrence.findFirst.mockResolvedValueOnce(
        change === null
          ? null
          : {
              status: 'IN_PROGRESS',
              assignedStaffProfileId: 'staff_me',
              claimedByStaffProfileId: null,
              ...change,
            }
      );
      const response = await POST(request());
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: PHARMACY_SOP_CHANGED_MESSAGE,
        conflict: true,
      });
      // The re-check runs under a share lock inside the attach transaction.
      expect(String(db.$queryRaw.mock.calls[0]?.[0]?.strings?.join('') ?? '')).toContain(
        'FOR SHARE'
      );
      expect(mocks.attachEvidence).not.toHaveBeenCalled();
      expect(db.pharmacySopEvidenceCapture.createMany).not.toHaveBeenCalled();
      // The file stored before the re-check is removed.
      expect(mocks.deleteUpload).toHaveBeenCalled();
    }
  );

  it('refuses an unauthenticated request before building a context', async () => {
    mocks.resolveTenantActor.mockResolvedValueOnce(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
    expect(mocks.putUpload).not.toHaveBeenCalled();
  });

  it('refuses cross-origin uploads', async () => {
    expect((await POST(request({ origin: null }))).status).toBe(403);
    expect((await POST(request({ origin: 'https://attacker.test' }))).status).toBe(403);
    expect(mocks.evidenceTarget).not.toHaveBeenCalled();
  });

  it('answers an interrupted multipart body with 400 and no row', async () => {
    const response = await POST(
      request({
        formData: async () => {
          throw new TypeError('body stream ended');
        },
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.putUpload).not.toHaveBeenCalled();
    expect(mocks.attachEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty file', new File([], 'empty.jpg', { type: 'image/jpeg' })],
    [
      'a file over the size limit',
      new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'big.jpg', { type: 'image/jpeg' }),
    ],
    ['an unsupported type', new File(['proof'], 'proof.gif', { type: 'image/gif' })],
    [
      'a truncated body',
      {
        [Symbol.toStringTag]: 'File',
        name: 'proof.jpg',
        size: 10,
        type: 'image/jpeg',
        arrayBuffer: async () => new ArrayBuffer(4),
      },
    ],
    ['a missing file', null],
  ])('rejects %s with 400 before authorization or storage', async (_label, file) => {
    const response = await POST(request({ file }));
    expect(response.status).toBe(400);
    expect(mocks.evidenceTarget).not.toHaveBeenCalled();
    expect(mocks.putUpload).not.toHaveBeenCalled();
    expect(mocks.attachEvidence).not.toHaveBeenCalled();
  });

  it('requires a branch and occurrence', async () => {
    const response = await POST(request({ fields: { occurrenceId: '' } }));
    expect(response.status).toBe(400);
    expect(mocks.evidenceTarget).not.toHaveBeenCalled();
  });

  it('removes the stored blob when attaching fails, and leaves no row', async () => {
    mocks.attachEvidence.mockRejectedValueOnce(
      new SopExecutionError('Cannot attach evidence', 'INVALID_STATE')
    );
    const response = await POST(request());
    expect(response.status).toBe(409);
    // The procedure moved on between authorization and attach: same plain words.
    await expect(response.json()).resolves.toEqual({
      error: PHARMACY_SOP_CHANGED_MESSAGE,
      conflict: true,
    });
    expect(mocks.deleteUpload).toHaveBeenCalledWith('org_1', mocks.putUpload.mock.calls[0]![1]);
  });

  it('does not leak internal failure detail', async () => {
    mocks.attachEvidence.mockRejectedValueOnce(
      new Error('relation restaurant_sop_evidence leaked')
    );
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('restaurant_sop_evidence');
    expect(mocks.deleteUpload).toHaveBeenCalledOnce();
  });

  it('reports unavailable storage without a cleanup attempt', async () => {
    mocks.putUpload.mockRejectedValueOnce(new StorageUnavailableError('disabled'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.attachEvidence).not.toHaveBeenCalled();
    expect(mocks.deleteUpload).not.toHaveBeenCalled();
  });

  it('never reports success when removing a redundant blob fails', async () => {
    mocks.attachEvidence.mockResolvedValueOnce({
      evidenceId: 'ev_1',
      contentHash: 'abc',
      createdAt: new Date(),
      created: false,
    });
    existingReceiptedRow();
    mocks.deleteUpload.mockRejectedValueOnce(new Error('storage down'));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(mocks.deleteUpload).toHaveBeenCalledOnce();
  });
});

describe('POST pharmacy SOP evidence capture receipts', () => {
  const UPLOAD_RECEIPT = {
    organizationId: 'org_1',
    pharmacyBranchId: 'pbranch_1',
    occurrenceId: 'occ_1',
    evidenceId: 'ev_1',
    contentHash: 'abc',
    capturedByStaffProfileId: 'staff_me',
    capturedByUserId: 'user_1',
    source: 'UPLOAD',
  };

  it('writes the receipt in the attach transaction, from the engine id and the session actor', async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(mocks.attachEvidence).toHaveBeenCalledWith(db, expect.anything());
    expect(db.pharmacySopEvidenceCapture.createMany).toHaveBeenCalledWith({
      data: [UPLOAD_RECEIPT],
      skipDuplicates: true,
    });
    // A brand-new row is this request's own: no provenance lookup is needed.
    expect(db.restaurantSopEvidence.findFirst).not.toHaveBeenCalled();
    // Receipt after attach, inside the same transaction.
    expect(mocks.attachEvidence.mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacySopEvidenceCapture.createMany.mock.invocationCallOrder[0]!
    );
  });

  it('never reads receipt, evidence, capture or actor identity from the form', async () => {
    const response = await POST(
      request({
        fields: {
          evidenceId: 'ev_forged',
          receiptId: 'rcpt_forged',
          captureId: 'cap_forged',
          contentHash: 'f'.repeat(64),
          source: 'LEGACY_HMAC_BACKFILL',
          capturedByStaffProfileId: 'staff_victim',
          capturedByUserId: 'user_victim',
          uploaderStaffProfileId: 'staff_victim',
          organizationId: 'org_2',
        },
      })
    );
    expect(response.status).toBe(201);
    expect(db.pharmacySopEvidenceCapture.createMany).toHaveBeenCalledWith({
      data: [UPLOAD_RECEIPT],
      skipDuplicates: true,
    });
    const written = JSON.stringify(db.pharmacySopEvidenceCapture.createMany.mock.calls);
    for (const forged of ['forged', 'victim', 'org_2', 'LEGACY_HMAC_BACKFILL', 'f'.repeat(64)]) {
      expect(written).not.toContain(forged);
    }
  });

  it('a retry of a receipted row stays one receipt (skipDuplicates) and answers 200', async () => {
    mocks.attachEvidence.mockResolvedValueOnce({
      evidenceId: 'ev_1',
      contentHash: 'abc',
      createdAt: new Date(),
      created: false,
    });
    existingReceiptedRow();
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(db.restaurantSopEvidence.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ev_1', occurrenceId: 'occ_1' } })
    );
    expect(db.pharmacySopEvidenceCapture.createMany).toHaveBeenCalledWith({
      data: [UPLOAD_RECEIPT],
      skipDuplicates: true,
    });
  });

  it('a retry heals a missing receipt for proof whose legacy name still verifies', async () => {
    // First attempt (before receipts existed): the engine row holds the minted ref.
    await POST(request());
    const first = mocks.attachEvidence.mock.calls[0]![1] as {
      storageRef: string;
      contentHashHex: string;
      mimeType: string;
    };
    db.restaurantSopEvidence.findFirst.mockResolvedValue({
      id: 'ev_1',
      occurrenceId: 'occ_1',
      occurrenceStepId: 'ostep_1',
      contentHash: first.contentHashHex,
      mimeType: first.mimeType,
      uploaderStaffProfileId: 'staff_me',
      storageRef: first.storageRef,
    });
    db.pharmacySopEvidenceCapture.createMany.mockClear();
    mocks.attachEvidence.mockResolvedValueOnce({
      evidenceId: 'ev_1',
      contentHash: first.contentHashHex,
      createdAt: new Date(),
      created: false,
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(db.pharmacySopEvidenceCapture.createMany).toHaveBeenCalledOnce();
    expect(db.pharmacySopEvidenceCapture.createMany).toHaveBeenCalledWith({
      data: [{ ...UPLOAD_RECEIPT, contentHash: first.contentHashHex }],
      skipDuplicates: true,
    });
    // The redundant second blob is removed; the original row and blob stay.
    expect(mocks.deleteUpload).toHaveBeenLastCalledWith('org_1', mocks.putUpload.mock.calls[1]![1]);
  });

  it('never gives a receipt to identical bytes attached outside the pharmacy workspace', async () => {
    mocks.attachEvidence.mockResolvedValueOnce({
      evidenceId: 'ev_foreign',
      contentHash: 'abc',
      createdAt: new Date(),
      created: false,
    });
    db.restaurantSopEvidence.findFirst.mockResolvedValue({
      id: 'ev_foreign',
      occurrenceId: 'occ_1',
      occurrenceStepId: 'ostep_1',
      contentHash: 'abc',
      mimeType: 'image/jpeg; evidence=photo',
      uploaderStaffProfileId: 'staff_me',
      storageRef: '/api/files/sop-11111111-2222-4333-8444-555555555555.jpg',
    });
    const response = await POST(request());
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toContain('not captured in the pharmacy workspace');
    // Not a stale screen: the person picks another photo, so no conflict mark.
    expect(JSON.parse(text)).not.toHaveProperty('conflict');
    expect(db.pharmacySopEvidenceCapture.createMany).not.toHaveBeenCalled();
    expect(mocks.deleteUpload).toHaveBeenCalledWith('org_1', mocks.putUpload.mock.calls[0]![1]);
  });

  it('answers a failed receipt write with a retryable error and removes only the new blob', async () => {
    db.pharmacySopEvidenceCapture.createMany.mockRejectedValueOnce(
      new Error('pharmacy_sop_evidence_captures insert failed')
    );
    const response = await POST(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ error: 'Proof was not saved. Retry in a moment.', retryable: true });
    expect(JSON.stringify(body)).not.toContain('pharmacy_sop_evidence_captures');
    // The transaction carried the error, so the engine row rolled back with it;
    // nothing is ever deleted from the append-only tables.
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(mocks.deleteUpload).toHaveBeenCalledOnce();
    expect(mocks.deleteUpload).toHaveBeenCalledWith('org_1', mocks.putUpload.mock.calls[0]![1]);

    // The UI retries: the engine attaches idempotently and the receipt is written.
    const retry = await POST(request());
    expect(retry.status).toBe(201);
    expect(db.pharmacySopEvidenceCapture.createMany).toHaveBeenCalledTimes(2);
  });
});

it.each([24, 25])('accepts a %i MB multipart file with its full byte count', async (size) => {
  const response = await POST(multipartUpload('/api/pharmacy/sop/evidence', size));
  expect(response.status).toBe(201);
  expect(mocks.putUpload).toHaveBeenCalledOnce();
  expect(mocks.putUpload.mock.calls[0]![2].byteLength).toBe(size * 1024 * 1024);
  expect(response.headers.get('Content-Security-Policy')).toContain("'nonce-");
});

it('refuses a 26 MB multipart file with a plain size message before storage', async () => {
  const response = await POST(multipartUpload('/api/pharmacy/sop/evidence', 26));
  expect(response.status).toBe(413);
  expect(await response.text()).toContain('Choose a file of 25 MB or smaller.');
  expect(mocks.putUpload).not.toHaveBeenCalled();
});

it('returns 401 without reading the request stream when the session is missing', async () => {
  mocks.resolveTenantActor.mockResolvedValueOnce(null);
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
    controller.close()
  );
  const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
  const req = new Request('https://devfathom.test/api/pharmacy/sop/evidence', {
    method: 'POST',
    headers: { origin: 'https://devfathom.test' },
    body,
    duplex: 'half',
  } as RequestInit);
  const response = await POST(req);
  expect(response.status).toBe(401);
  expect(pull).not.toHaveBeenCalled();
  expect(req.bodyUsed).toBe(false);
  expect(mocks.acquireSlot).not.toHaveBeenCalled();
  expect(mocks.putUpload).not.toHaveBeenCalled();
});

it('refuses a large upload for the signed-in user when both slots are occupied', async () => {
  mocks.acquireSlot.mockResolvedValueOnce(null);
  const response = await POST(multipartUpload('/api/pharmacy/sop/evidence', 9));
  expect(response.status).toBe(429);
  expect((await response.json()).error).toContain('Wait for one to finish');
  expect(mocks.acquireSlot).toHaveBeenCalledExactlyOnceWith('user_1', 'org_1');
  expect(mocks.putUpload).not.toHaveBeenCalled();
});
