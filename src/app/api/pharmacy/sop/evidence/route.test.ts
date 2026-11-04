import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';

const mocks = vi.hoisted(() => ({
  attachEvidence: vi.fn(),
  createTRPCContext: vi.fn(),
  deleteUpload: vi.fn(),
  evidenceTarget: vi.fn(),
  putUpload: vi.fn(),
  resolveTenantActor: vi.fn(),
}));

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
vi.mock('@/server/routers/pharmacy-sop', () => ({
  pharmacySopRouter: {
    createCaller: vi.fn(() => ({ evidenceTarget: mocks.evidenceTarget })),
  },
}));

import { POST } from './route';
import { SopExecutionError } from '@/lib/restaurant/sop-execution';
import { StorageUnavailableError } from '@/lib/storage';

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
  return {
    formData: overrides?.formData ?? (async () => form),
    headers: new Headers(origin ? { origin } : undefined),
    url: 'https://devfathom.test/api/pharmacy/sop/evidence',
  } as Request;
}

const TARGET = {
  pharmacyBranchId: 'pbranch_1',
  occurrenceId: 'occ_1',
  occurrenceStepId: 'ostep_1',
  uploaderStaffProfileId: 'staff_me',
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const session = { user: { id: 'user_1', organizationId: 'org_1' } };
  mocks.resolveTenantActor.mockResolvedValue({
    session,
    organization: { id: 'org_1' },
    support: null,
  });
  mocks.createTRPCContext.mockResolvedValue({ db: {}, organization: { id: 'org_1' }, session });
  mocks.evidenceTarget.mockResolvedValue(TARGET);
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
    expect(mocks.putUpload).toHaveBeenCalledWith(
      'org_1',
      expect.stringMatching(/^sop-.+\.jpg$/),
      Buffer.from('proof'),
      'image/jpeg'
    );
    expect(mocks.attachEvidence).toHaveBeenCalledWith(
      {},
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

  it('records signature proof with the signature purpose', async () => {
    await POST(request({ fields: { evidencePurpose: 'signature' } }));
    expect(mocks.attachEvidence).toHaveBeenCalledWith(
      {},
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
    mocks.deleteUpload.mockRejectedValueOnce(new Error('storage down'));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(mocks.deleteUpload).toHaveBeenCalledOnce();
  });
});
