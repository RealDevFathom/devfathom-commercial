// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  requirePlatformSession: vi.fn(),
  forceEndSupportSession: vi.fn(),
  listActiveSupportSessions: vi.fn(),
}));
vi.mock('@/lib/platform/auth', () => ({ requirePlatformSession: mock.requirePlatformSession }));
vi.mock('@/lib/tenancy/support-session', () => ({
  createSupportSession: vi.fn(),
  endSupportSession: vi.fn(),
  forceEndSupportSession: mock.forceEndSupportSession,
  listActiveSupportSessions: mock.listActiveSupportSessions,
}));
import { GET, PATCH } from '@/app/api/platform/support/route';
import { PlatformSecurityError } from '@/lib/platform/security';
const body = { supportSessionId: 'support_one', reason: 'End completed support session' };
const request = (origin = 'http://admin.localhost', payload: unknown = body) =>
  new Request('http://admin.localhost/api/platform/support', {
    method: 'PATCH',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mock.requirePlatformSession.mockResolvedValue({ id: 'operator_one', role: 'SUPPORT' });
  mock.listActiveSupportSessions.mockResolvedValue([]);
});
it('rejects cross-origin force-end before authentication or mutation', async () => {
  expect((await PATCH(request('http://evil.localhost'))).status).toBe(403);
  expect(mock.requirePlatformSession).not.toHaveBeenCalled();
  expect(mock.forceEndSupportSession).not.toHaveBeenCalled();
});
it('requires support:write for force-end', async () => {
  mock.requirePlatformSession.mockRejectedValue(new PlatformSecurityError('Denied', 403));
  expect((await PATCH(request())).status).toBe(403);
  expect(mock.requirePlatformSession).toHaveBeenCalledWith(expect.any(Request), 'support:write');
  expect(mock.forceEndSupportSession).not.toHaveBeenCalled();
});
it('rejects invalid end reasons', async () => {
  expect((await PATCH(request(undefined, { ...body, reason: 'short' }))).status).toBe(400);
  expect(mock.forceEndSupportSession).not.toHaveBeenCalled();
});
it('ends the selected session rather than the caller cookie session', async () => {
  expect((await PATCH(request())).status).toBe(200);
  expect(mock.forceEndSupportSession).toHaveBeenCalledWith({
    ...body,
    actor: { id: 'operator_one', role: 'SUPPORT' },
  });
});
it('serves the global list privately and requires support:write', async () => {
  const response = await GET(new Request('http://admin.localhost/api/platform/support'));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(mock.requirePlatformSession).toHaveBeenCalledWith(expect.any(Request), 'support:write');
});
