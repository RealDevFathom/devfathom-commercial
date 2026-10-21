// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ actor: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/storage', async (original) => ({
  ...(await original<typeof import('@/lib/storage')>()),
  putUpload: mocks.put,
}));
import { StorageUnavailableError } from '@/lib/storage';
import { PasswordChangeRequiredError } from '@/lib/auth/session-state';
import { POST } from './route';
function request(name = 'proof.png', type = 'image/png') {
  const form = new FormData();
  form.set('file', new File(['proof'], name, { type }));
  return new Request('https://example.test/api/upload', { method: 'POST', body: form });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue({
    organization: { id: 'org-a' },
    session: { user: { id: 'user-a' } },
  });
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
