// @vitest-environment node
import { multipartUpload } from '../../../../tests/fixtures/multipart-upload';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  acquireSlot: vi.fn(),
  actor: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  tenant: vi.fn(),
  register: vi.fn(),
}));
vi.mock('@/lib/uploads/large-upload-slot', () => ({ acquireLargeUploadSlot: mocks.acquireSlot }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.tenant }));
vi.mock('@/lib/storage', async (original) => ({
  ...(await original<typeof import('@/lib/storage')>()),
  putUpload: mocks.put,
  deleteUpload: mocks.remove,
}));
import { StorageUnavailableError } from '@/lib/storage';
import { PasswordChangeRequiredError } from '@/lib/auth/session-state';
import { DELETE, OPTIONS, POST } from './route';
function request(name = 'proof.png', type = 'image/png') {
  const form = new FormData();
  form.set('file', new File(['proof'], name, { type }));
  return new Request('https://example.test/api/upload', { method: 'POST', body: form });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.acquireSlot.mockResolvedValue(async () => {});
  mocks.actor.mockResolvedValue({
    organization: { id: 'org-a' },
    session: { user: { id: 'user-a' } },
  });
  mocks.tenant.mockImplementation(async (_org, run) =>
    run({ uploadedFile: { create: mocks.register } })
  );
  mocks.register.mockResolvedValue({ id: 'upl_1' });
  mocks.remove.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
test('authorized unavailable upload returns 503 without a link or sensitive details', async () => {
  mocks.put.mockRejectedValue(new StorageUnavailableError('disabled'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Uploads are unavailable.' });
  expect(log).not.toHaveBeenCalled();
});
test('authentication and file validation precede storage', async () => {
  mocks.actor.mockResolvedValueOnce(null);
  expect((await POST(request())).status).toBe(401);
  expect((await POST(request('x.svg', 'image/svg+xml'))).status).toBe(415);
  expect(mocks.put).not.toHaveBeenCalled();
});
test('configured storage success keeps tenant and attachment contract', async () => {
  const response = await POST(request());
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.url).toMatch(/^\/api\/files\/.+-proof.png$/);
  expect(mocks.put).toHaveBeenCalledWith(
    'org-a',
    expect.any(String),
    Buffer.from('proof'),
    'image/png'
  );
});
// #164: a non-tRPC /api/* route must honour the temporary-password gate.
// resolveTenantActor throws PasswordChangeRequiredError for an API request while
// a reset is outstanding (pinned in tenant-actor.test.ts); the route must turn
// that into the 403 envelope the client reads, not a generic 500.
test('a temporary password gates the upload with 403 PASSWORD_CHANGE_REQUIRED', async () => {
  mocks.actor.mockRejectedValue(new PasswordChangeRequiredError());
  const response = await POST(request());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    code: 'PASSWORD_CHANGE_REQUIRED',
    error: 'PASSWORD_CHANGE_REQUIRED',
  });
  expect(mocks.put).not.toHaveBeenCalled();
});
test('generic failures are sanitized in response and logging', async () => {
  mocks.put.mockRejectedValue(new Error('fake sensitive credential detail'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const response = await POST(request());
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('sensitive');
  expect(log).toHaveBeenCalledWith('[upload] failed');
});
// DEV-837: the server records who uploaded every object, in the uploader's
// tenant, so ownership is never inferred from a later client-supplied URL.
test('registers the stored object with the session uploader', async () => {
  const response = await POST(request());
  const { url } = await response.json();
  const name = url.slice('/api/files/'.length);
  expect(mocks.tenant).toHaveBeenCalledWith('org-a', expect.any(Function));
  expect(mocks.register).toHaveBeenCalledWith({
    data: { name, uploadedById: 'user-a' },
    select: { id: true },
  });
  expect(mocks.put).toHaveBeenCalledWith('org-a', name, expect.any(Buffer), 'image/png');
});
test('a failed registration removes the stored object and returns no link', async () => {
  mocks.register.mockRejectedValue(new Error('registry unavailable'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const response = await POST(request());
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('/api/files/');
  const stored = mocks.put.mock.calls[0]![1];
  expect(mocks.remove).toHaveBeenCalledWith('org-a', stored);
});

test.each([24, 25])('accepts a %i MB multipart file with its full byte count', async (size) => {
  const response = await POST(multipartUpload('/api/upload', size));
  expect(response.status).toBe(200);
  expect(mocks.put).toHaveBeenCalledOnce();
  expect(mocks.put.mock.calls[0]![2].byteLength).toBe(size * 1024 * 1024);
  expect(response.headers.get('Content-Security-Policy')).toContain("'nonce-");
});

test('refuses a 26 MB multipart file with a plain size message before storage', async () => {
  const response = await POST(multipartUpload('/api/upload', 26));
  expect(response.status).toBe(413);
  expect(await response.text()).toContain('Choose a file of 25 MB or smaller.');
  expect(mocks.put).not.toHaveBeenCalled();
});

test('applies the proxy request and response headers before resolving the upload actor', async () => {
  const incoming = request();
  incoming.headers.set('host', 'internal-runtime');
  incoming.headers.set('x-forwarded-host', 'Tenant.Example.test:3000, internal-runtime');
  incoming.headers.set('x-devfathom-host', 'untrusted.example.test');
  incoming.headers.set('x-devfathom-request-method', 'GET');
  incoming.headers.set('x-devfathom-request-id', 'fixture-id');
  incoming.headers.set('x-nonce', 'untrusted');
  incoming.headers.set('cookie', 'fixture=present');
  const response = await POST(incoming);
  const headers = mocks.actor.mock.calls[0]![0].request.headers as Headers;
  expect(headers.get('x-devfathom-host')).toBe('tenant.example.test:3000');
  expect(headers.get('x-devfathom-request-method')).toBe('POST');
  expect(headers.get('x-devfathom-request-id')).toBe('fixture-id');
  expect(headers.get('cookie')).toBe('fixture=present');
  expect(headers.get('x-nonce')).not.toBe('untrusted');
  expect(headers.get('Content-Security-Policy')).toContain(`'nonce-${headers.get('x-nonce')}'`);
  expect(response.headers.get('Content-Security-Policy')).toBe(
    headers.get('Content-Security-Policy')
  );
});

test('retains the automatic method responses and their CSP', () => {
  const url = 'https://tenant.example.test/api/upload';
  const options = OPTIONS(new Request(url, { method: 'OPTIONS' }));
  expect(options.status).toBe(204);
  expect(options.headers.get('Allow')).toBe('OPTIONS, POST');
  expect(options.headers.get('Content-Security-Policy')).toContain("'nonce-");
  const unsupported = DELETE(new Request(url, { method: 'DELETE' }));
  expect(unsupported.status).toBe(405);
  expect(unsupported.headers.get('Content-Security-Policy')).toContain("'nonce-");
});

test('refuses a large upload for the signed-in user when both slots are occupied', async () => {
  mocks.acquireSlot.mockResolvedValueOnce(null);
  const response = await POST(multipartUpload('/api/upload', 9));
  expect(response.status).toBe(429);
  expect((await response.json()).error).toContain('Wait for one to finish');
  expect(mocks.acquireSlot).toHaveBeenCalledExactlyOnceWith('user-a');
  expect(mocks.put).not.toHaveBeenCalled();
});
