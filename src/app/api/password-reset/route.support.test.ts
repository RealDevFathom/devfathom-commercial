// @vitest-environment node
/**
 * DEV-1053: a platform support session may not start a password reset through the REST
 * route either. A request that carries a live support session is refused and audited before
 * the body is read. A visitor with no support cookie is served exactly as before and is never
 * looked up; so is one whose support cookie is no longer a live session.
 */
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  actor: vi.fn(),
  enqueue: vi.fn(),
  rateLimit: vi.fn(),
  recordAudit: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: m.actor }));
vi.mock('@/lib/auth/password-reset-request', () => ({ enqueuePasswordReset: m.enqueue }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: m.rateLimit }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => '192.0.2.1',
  recordAudit: m.recordAudit,
}));

import { SUPPORT_SESSION_REFUSED_MESSAGE } from '@/lib/tenancy/support-session-rule';
import { POST } from './route';

const supportActor = {
  organization: { id: 'org_1' },
  support: {
    supportSessionId: 'support_session_1',
    organizationId: 'org_1',
    platformUserId: 'platform_operator_1',
    tenantUserId: 'owner_1',
  },
  session: {
    expires: 'later',
    user: {
      id: 'owner_1',
      organizationId: 'org_1',
      name: 'Owner',
      email: 'owner@example.test',
      role: 'ADMIN',
      isSupportSession: true,
      supportSessionId: 'support_session_1',
      platformUserId: 'platform_operator_1',
    },
  },
};
/** Synthetic: the shape of the support cookie, not a real session. */
const SUPPORT_COOKIE = `df_support_session=${'s'.repeat(48)}`;

function post(cookie?: string) {
  return POST(
    new Request('https://pharmacy.app.localhost/api/password-reset', {
      method: 'POST',
      headers: {
        host: 'pharmacy.app.localhost',
        'user-agent': 'route-test',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ email: 'staff@example.test' }),
    })
  );
}

function expectServed(response: Response, body: string) {
  expect([response.status, body]).toEqual([200, '{"ok":true}']);
  expect(m.enqueue).toHaveBeenCalledTimes(1);
  expect(m.enqueue).toHaveBeenCalledWith(
    'staff@example.test',
    { host: 'pharmacy.app.localhost' },
    '192.0.2.1'
  );
  expect(m.recordAudit).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  m.rateLimit.mockResolvedValue({ ok: true });
});

it('refuses a support session, queues nothing, and records the operator', async () => {
  m.actor.mockResolvedValue(supportActor);
  const response = await post(SUPPORT_COOKIE);
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: SUPPORT_SESSION_REFUSED_MESSAGE,
  });
  expect(m.enqueue).not.toHaveBeenCalled();
  expect(m.rateLimit).not.toHaveBeenCalled();
  expect(m.recordAudit).toHaveBeenCalledTimes(1);
  expect(m.recordAudit).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId: 'org_1',
      actorId: 'owner_1',
      source: 'REST_API',
      action: 'passwordReset.request',
      outcome: 'FAILURE',
      statusCode: 403,
      metadata: {
        supportSessionRefused: true,
        supportSessionId: 'support_session_1',
        platformUserId: 'platform_operator_1',
        actingAsTenantUserId: 'owner_1',
      },
    })
  );
  // The address asked for is never stored.
  expect(JSON.stringify(m.recordAudit.mock.calls)).not.toContain('staff@example.test');
});

it('serves a visitor with no support cookie as before, without looking anyone up', async () => {
  const response = await post();
  expectServed(response, await response.text());
  expect(m.actor).not.toHaveBeenCalled();
});

it.each([
  ['is no longer a live session', async () => null],
  ['belongs to a member the resolver turns away', async () => Promise.reject(new Error('gate'))],
  [
    'sits beside an ordinary member session',
    async () => ({
      ...supportActor,
      support: null,
      session: { expires: 'later', user: { id: 'owner_1' } },
    }),
  ],
])('serves a request whose support cookie %s', async (_case, resolve) => {
  m.actor.mockImplementation(resolve);
  const response = await post(SUPPORT_COOKIE);
  expectServed(response, await response.text());
});
