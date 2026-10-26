import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';

const mocks = vi.hoisted(() => ({
  attachEvidence: vi.fn(),
  can: vi.fn(),
  createTRPCContext: vi.fn(),
  deleteUpload: vi.fn(),
  putUpload: vi.fn(),
  resolveRestaurantActor: vi.fn(),
}));

vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: () => ({ id: 'user-1' }),
}));
vi.mock('@/lib/restaurant/sop-execution', () => ({ attachEvidence: mocks.attachEvidence }));
vi.mock('@/lib/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage')>()),
  deleteUpload: mocks.deleteUpload,
  putUpload: mocks.putUpload,
}));
vi.mock('@/server/restaurant-actor', () => ({
  resolveRestaurantActor: mocks.resolveRestaurantActor,
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));

import { POST } from './route';
import { StorageUnavailableError } from '@/lib/storage';

function request(overrides?: {
  type?: string;
  origin?: string;
  url?: string;
  forwardedHost?: string;
  fetchSite?: string;
  omitOrigin?: boolean;
  file?: unknown;
  uploaderStaffProfileId?: string;
}) {
  const form = new FormData();
  form.set('branchId', 'branch-1');
  form.set('businessDate', '2026-08-29');
  form.set('occurrenceId', 'occurrence-1');
  form.set('occurrenceStepId', 'step-1');
  form.set('evidencePurpose', 'photo');
  if (overrides?.uploaderStaffProfileId) {
    form.set('uploaderStaffProfileId', overrides.uploaderStaffProfileId);
  }
  form.set('file', new File(['proof'], 'proof.jpg', { type: overrides?.type ?? 'image/jpeg' }));
  if (overrides && 'file' in overrides) {
    const get = form.get.bind(form);
    vi.spyOn(form, 'get').mockImplementation((key) =>
      key === 'file' ? (overrides.file as FormDataEntryValue) : get(key)
    );
  }
  const origin = overrides?.origin ?? 'https://devfathom.test';
  const headers = new Headers(overrides?.omitOrigin ? undefined : { origin });
  if (overrides?.forwardedHost) {
    headers.set('x-forwarded-host', overrides.forwardedHost);
    headers.set('x-forwarded-proto', 'https');
  }
  if (overrides?.fetchSite) headers.set('sec-fetch-site', overrides.fetchSite);
  return {
    formData: async () => form,
    headers,
    url: overrides?.url ?? 'https://devfathom.test/api/restaurant/sop/evidence',
  } as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.createTRPCContext.mockResolvedValue({
    db: {},
    organization: { id: 'org-1' },
    session: { user: { id: 'user-1' } },
  });
  mocks.deleteUpload.mockResolvedValue(undefined);
  mocks.putUpload.mockResolvedValue(undefined);
  mocks.resolveRestaurantActor.mockResolvedValue({ staffProfileId: 'session-staff' });
  mocks.attachEvidence.mockResolvedValue({ evidenceId: 'evidence-1', created: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('POST SOP evidence', () => {
  function warnings() {
    return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  }

  function expectWarningAt(warn: ReturnType<typeof warnings>, stage: string) {
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'restaurant_sop_evidence_capture_failed',
      JSON.stringify({
        event: 'restaurant_sop_evidence_capture_failed',
        stage,
        errorClass: 'Error',
      })
    );
  }

  it('derives uploader attribution from the authenticated user instead of multipart data', async () => {
    const warn = warnings();
    const response = await POST(
      request({
        url: 'http://internal-runtime:3000/api/restaurant/sop/evidence',
        forwardedHost: 'wha346.devfathom.test',
        origin: 'https://wha346.devfathom.test',
        fetchSite: 'same-origin',
        uploaderStaffProfileId: 'spoofed-staff',
      })
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toMatch(
      /^https:\/\/wha346\.devfathom\.test\/restaurant\/sop\?.*notice=Proof\+captured\./
    );
    expect(mocks.putUpload).toHaveBeenCalledWith(
      'org-1',
      expect.stringMatching(/^sop-.+\.jpg$/),
      expect.any(Buffer),
      'image/jpeg'
    );
    expect(mocks.attachEvidence).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        occurrenceId: 'occurrence-1',
        occurrenceStepId: 'step-1',
        mimeType: 'image/jpeg; evidence=photo',
        uploaderStaffProfileId: 'session-staff',
      })
    );
    expect(mocks.attachEvidence).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ uploaderStaffProfileId: 'spoofed-staff' })
    );
    expect(mocks.resolveRestaurantActor).toHaveBeenCalledWith(
      expect.objectContaining({ session: { user: { id: 'user-1' } } }),
      []
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a genuine parsed multipart file from a different File realm', async () => {
    const multipart = new FormData();
    multipart.set('file', new File(['parsed proof'], 'proof.jpg', { type: 'image/jpeg' }));
    const parsedFile = multipart.get('file');
    vi.stubGlobal('File', class OtherRealmFile {});

    const response = await POST(request({ file: parsedFile }));

    expect(response.headers.get('location')).toContain('Proof+captured');
    expect(mocks.putUpload).toHaveBeenCalledWith(
      'org-1',
      expect.stringMatching(/^sop-.+\.jpg$/),
      Buffer.from('parsed proof'),
      'image/jpeg'
    );
  });

  it('returns success and removes only a redundant retry-owned blob', async () => {
    mocks.attachEvidence.mockResolvedValueOnce({ evidenceId: 'evidence-1', created: false });

    const response = await POST(request());

    expect(response.headers.get('location')).toContain('Proof+captured');
    const storedName = mocks.putUpload.mock.calls[0]![1];
    expect(mocks.deleteUpload).toHaveBeenCalledOnce();
    expect(mocks.deleteUpload).toHaveBeenCalledWith('org-1', storedName);
  });

  it('cleans only the losing staged blob across two concurrent identical requests', async () => {
    mocks.attachEvidence
      .mockResolvedValueOnce({ evidenceId: 'evidence-1', created: true })
      .mockResolvedValueOnce({ evidenceId: 'evidence-1', created: false });

    const responses = await Promise.all([POST(request()), POST(request())]);

    expect(
      responses.every((response) => response.headers.get('location')?.includes('Proof+captured'))
    ).toBe(true);
    const storedNames = mocks.putUpload.mock.calls.map((call) => call[1]);
    expect(new Set(storedNames).size).toBe(2);
    expect(mocks.deleteUpload).toHaveBeenCalledTimes(1);
    expect(storedNames).toContain(mocks.deleteUpload.mock.calls[0]![1]);
  });

  it.each([
    [
      'a forged file-like object',
      { size: 5, type: 'image/jpeg', arrayBuffer: async () => new ArrayBuffer(5) },
    ],
    [
      'an object spoofing the File tag without a name',
      {
        [Symbol.toStringTag]: 'File',
        size: 5,
        type: 'image/jpeg',
        arrayBuffer: async () => new ArrayBuffer(5),
      },
    ],
    ['a forged object without binary methods', { size: 5, type: 'image/jpeg' }],
    ['an empty file', new File([], 'empty.jpg', { type: 'image/jpeg' })],
    [
      'a file over 25 MB',
      new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'large.jpg', { type: 'image/jpeg' }),
    ],
    ['an unsupported MIME type', new File(['proof'], 'proof.gif', { type: 'image/gif' })],
    ['malformed MIME metadata', new File(['proof'], 'proof.jpg', { type: 'not a mime' })],
  ])('rejects %s before storage', async (_label, file) => {
    const response = await POST(request({ file }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('Proof+capture+failed');
    expect(mocks.putUpload).not.toHaveBeenCalled();
    expect(mocks.attachEvidence).not.toHaveBeenCalled();
  });

  it('rejects cross-origin and unsupported uploads before storage', async () => {
    expect((await POST(request({ omitOrigin: true }))).status).toBe(403);
    expect((await POST(request({ origin: 'https://attacker.test' }))).status).toBe(403);
    expect(
      (
        await POST(
          request({
            origin: 'https://other-tenant.devfathom.test',
            forwardedHost: 'wha346.devfathom.test',
          })
        )
      ).status
    ).toBe(403);
    expect((await POST(request({ fetchSite: 'cross-site' }))).status).toBe(403);
    const response = await POST(request({ type: 'image/gif' }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('Proof+capture+failed');
    expect(mocks.putUpload).not.toHaveBeenCalled();
  });

  it('preserves authorization and redacts internal failures', async () => {
    mocks.can.mockResolvedValue(false);
    let response = await POST(request());
    expect(response.headers.get('location')).toContain('Proof+capture+failed');
    expect(mocks.putUpload).not.toHaveBeenCalled();

    mocks.can.mockResolvedValue(true);
    mocks.attachEvidence.mockRejectedValue(new Error('sensitive database detail'));
    response = await POST(request());
    expect(response.headers.get('location')).not.toContain('sensitive');
    expect(mocks.deleteUpload).toHaveBeenCalledWith('org-1', expect.stringMatching(/^sop-/));
  });

  it('rejects uploads when the session user has no unambiguous active staff profile', async () => {
    mocks.resolveRestaurantActor.mockRejectedValueOnce(new Error('No active staff actor'));

    const response = await POST(request());

    expect(response.headers.get('location')).toContain('Proof+capture+failed');
    expect(mocks.putUpload).not.toHaveBeenCalled();
    expect(mocks.attachEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ['file_validation', () => request({ type: 'image/gif' })],
    [
      'context',
      () => {
        mocks.createTRPCContext.mockRejectedValueOnce(new Error('context secret'));
        return request();
      },
    ],
    [
      'authorization',
      () => {
        mocks.can.mockRejectedValueOnce(new Error('authorization secret'));
        return request();
      },
    ],
    [
      'storage',
      () => {
        mocks.putUpload.mockRejectedValueOnce(new Error('storage secret'));
        return request();
      },
    ],
    [
      'attach',
      () => {
        mocks.attachEvidence.mockRejectedValueOnce(new Error('attach secret'));
        return request();
      },
    ],
  ] as const)('warns with the exact %s failure stage', async (stage, makeRequest) => {
    const warn = warnings();

    const response = await POST(makeRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('Proof+capture+failed');
    expectWarningAt(warn, stage);
    expect(mocks.deleteUpload).toHaveBeenCalledTimes(
      stage === 'storage' || stage === 'attach' ? 1 : 0
    );
  });

  it('excludes sensitive request and error details from serialized warnings', async () => {
    const warn = warnings();
    mocks.attachEvidence.mockRejectedValueOnce(
      new Error(
        'secret tenant-1 user-1 staff-1 occurrence-1 step-1 proof.jpg image/jpeg 5 deadbeef'
      )
    );

    await POST(request());

    const serialized = warn.mock.calls.flat().join(' ');
    for (const sensitive of [
      'secret',
      'tenant-1',
      'user-1',
      'staff-1',
      'occurrence-1',
      'step-1',
      'proof.jpg',
      'image/jpeg',
      'deadbeef',
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it('keeps the generic redirect when warning emission fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    mocks.createTRPCContext.mockRejectedValueOnce(new Error('context secret'));

    const response = await POST(request());

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('Proof+capture+failed');
  });
});

it('unavailable storage creates no evidence and makes no cleanup attempt', async () => {
  mocks.putUpload.mockRejectedValueOnce(new StorageUnavailableError('disabled'));
  const response = await POST(request());
  expect(response.headers.get('location')).toContain('Storage+is+unavailable');
  expect(mocks.attachEvidence).not.toHaveBeenCalled();
  expect(mocks.deleteUpload).not.toHaveBeenCalled();
});
it('failed redundant-file deletion never reports success or retries deletion', async () => {
  mocks.attachEvidence.mockResolvedValueOnce({ evidenceId: 'existing-evidence', created: false });
  mocks.deleteUpload.mockRejectedValueOnce(new StorageUnavailableError('disabled'));
  const response = await POST(request());
  expect(response.headers.get('location')).toContain('cleanup+is+incomplete');
  expect(response.headers.get('location')).not.toContain('Proof+captured');
  expect(mocks.deleteUpload).toHaveBeenCalledOnce();
  expect(mocks.attachEvidence).toHaveBeenCalledOnce();
});
it('failed cleanup after attach failure is visible and sanitized', async () => {
  mocks.attachEvidence.mockRejectedValueOnce(new Error('fake private error'));
  mocks.deleteUpload.mockRejectedValueOnce(new Error('fake private storage error'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const response = await POST(request());
  expect(response.headers.get('location')).toContain('cleanup+is+incomplete');
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  expect(mocks.deleteUpload).toHaveBeenCalledOnce();
});
