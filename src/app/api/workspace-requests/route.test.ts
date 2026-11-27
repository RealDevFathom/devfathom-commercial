// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { oversizedRequest } from '../../../../tests/fixtures/bounded-request';
const mocks = vi.hoisted(() => ({ create: vi.fn(), gate: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) =>
    run({ platformLead: { create: mocks.create } }),
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: mocks.gate }));
vi.mock('@/server/audit', () => ({ ipFromHeaders: () => '127.0.0.1' }));
import { LICENCE_DOCUMENT_REFUSAL } from '@/lib/workspace-requests/licence-document';
import {
  syntheticClassicLicence,
  syntheticLicencePdf,
} from '@/lib/workspace-requests/licence-test-fixtures';
import { POST } from './route';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.gate.mockResolvedValue({ ok: true });
  mocks.create.mockResolvedValue({ id: 'persisted-id' });
});
function request(
  overrides: Record<string, string> = {},
  origin = 'https://app.example.test',
  file?: File
) {
  const form = new FormData();
  Object.entries({
    vertical: 'restaurant',
    companyName: 'Kitchen',
    ownerName: 'Owner',
    email: 'owner@example.test',
    phone: '03001234567',
    address: 'Street',
    branchName: 'First',
    businessDayCloses: '00:00',
    channels: 'Dine-in',
    authorized: 'on',
    ...overrides,
  }).forEach(([key, value]) => form.set(key, value));
  if (file) form.set('licenceCopy', file);
  return new Request('https://app.example.test/api/workspace-requests', {
    method: 'POST',
    headers: { origin },
    body: form,
  });
}
it('persists a pending review lead before returning success, without creating auth', async () => {
  const response = await POST(request());
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: 'persisted-id', status: 'pending' });
  const saved = mocks.create.mock.calls[0][0].data;
  expect(saved.status).toBe('NEW');
  expect(saved.source).toBe('workspace-request:restaurant');
  expect(JSON.parse(saved.notes).approval).toBe('pending');
});
it('returns an actionable failure when persistence fails', async () => {
  mocks.create.mockRejectedValue(new Error('private'));
  const result = await POST(request());
  expect(result.status).toBe(503);
  expect(await result.text()).not.toContain('private');
});
it('rejects cross-origin submissions before storage', async () => {
  expect((await POST(request({}, 'https://evil.test'))).status).toBe(403);
  expect(mocks.create).not.toHaveBeenCalled();
});
it('returns rate limiting and validation errors without saving', async () => {
  mocks.gate.mockResolvedValueOnce({ ok: false, retryAfter: 60 });
  expect((await POST(request())).status).toBe(429);
  expect((await POST(request({ authorized: '' }))).status).toBe(400);
  expect(mocks.create).not.toHaveBeenCalled();
});
const pharmacy = {
  vertical: 'pharmacy',
  province: 'Punjab',
  city: 'Lahore',
  licenceCategory: 'Pharmacy',
  licenceNumber: 'LIC',
  validUntil: '2099-01-01',
  pharmacistName: 'Qualified person',
  pharmacistRegistration: 'REG',
};
it('requires a real supported document and persists its bytes privately', async () => {
  expect((await POST(request(pharmacy))).status).toBe(400);
  expect(
    (
      await POST(
        request(pharmacy, undefined, new File(['fake'], 'bad.pdf', { type: 'application/pdf' }))
      )
    ).status
  ).toBe(400);
  const pdf = syntheticLicencePdf();
  const response = await POST(
    request(
      pharmacy,
      undefined,
      new File([Uint8Array.from(pdf)], 'sender-chosen.png', { type: 'application/pdf' })
    )
  );
  expect(response.status).toBe(201);
  const document = JSON.parse(mocks.create.mock.calls[0][0].data.notes).document;
  expect(Buffer.from(document.base64, 'base64')).toEqual(pdf);
  expect(document).toMatchObject({ name: 'licence.pdf', type: 'application/pdf', checked: true });
});
it('bounds actual request bytes, including requests without a content length', async () => {
  const limit = 1024 * 1024 + 64 * 1024;
  const input = oversizedRequest(limit, {
    url: 'https://app.example.test/api/workspace-requests',
    headers: {
      origin: 'https://app.example.test',
      'content-type': 'multipart/form-data; boundary=abc',
    },
  });
  expect((await POST(input.request)).status).toBe(413);
  expect(input.cancelled()).toBe(true);
  expect(input.bytesRead()).toBe(limit + 16_384);
  expect(mocks.create).not.toHaveBeenCalled();
});

it('uses the same plain message for malformed, encrypted and active PDFs', async () => {
  for (const bytes of [
    Buffer.from('%PDF-1.7\nIncomplete'),
    syntheticClassicLicence({ trailer: '/Encrypt << /Filter /Standard >>' }),
    syntheticClassicLicence({ catalog: '/OpenAction << /S /Launch >>' }),
  ]) {
    const response = await POST(
      request(
        pharmacy,
        undefined,
        new File([Uint8Array.from(bytes)], 'licence.pdf', { type: 'application/pdf' })
      )
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: LICENCE_DOCUMENT_REFUSAL,
      fields: { licenceCopy: [LICENCE_DOCUMENT_REFUSAL] },
    });
  }
  expect(mocks.create).not.toHaveBeenCalled();
});
