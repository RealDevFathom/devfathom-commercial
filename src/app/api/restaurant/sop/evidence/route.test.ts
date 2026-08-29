import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_ATTACHMENT_BYTES } from '@/lib/chat/contract';

const mocks = vi.hoisted(() => ({
  attachEvidence: vi.fn(),
  can: vi.fn(),
  createTRPCContext: vi.fn(),
  deleteUpload: vi.fn(),
  putUpload: vi.fn(),
}));

vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: () => ({ id: 'user-1' }),
}));
vi.mock('@/lib/restaurant/sop-execution', () => ({ attachEvidence: mocks.attachEvidence }));
vi.mock('@/lib/storage', () => ({
  deleteUpload: mocks.deleteUpload,
  putUpload: mocks.putUpload,
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));

import { POST } from './route';

function request(overrides?: {
  type?: string;
  origin?: string;
  url?: string;
  forwardedHost?: string;
  fetchSite?: string;
  omitOrigin?: boolean;
  file?: unknown;
}) {
  const form = new FormData();
  form.set('branchId', 'branch-1');
  form.set('businessDate', '2026-08-29');
  form.set('occurrenceId', 'occurrence-1');
  form.set('occurrenceStepId', 'step-1');
  form.set('evidencePurpose', 'photo');
  form.set('uploaderStaffProfileId', 'staff-1');
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
  mocks.attachEvidence.mockResolvedValue({ evidenceId: 'evidence-1' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST SOP evidence', () => {
  it('hashes and stores accepted proof with tenant, staff, and purpose attribution', async () => {
    const response = await POST(
      request({
        url: 'http://internal-runtime:3000/api/restaurant/sop/evidence',
        forwardedHost: 'wha346.devfathom.test',
        origin: 'https://wha346.devfathom.test',
        fetchSite: 'same-origin',
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
        uploaderStaffProfileId: 'staff-1',
      })
    );
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
});
