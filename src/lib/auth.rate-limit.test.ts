import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHA-1542 — the tenant login transport must not spend its own failure budget
 * on successful sign-ins.
 *
 * `src/lib/platform/auth.ts` already clears its bucket after a verified
 * credential; this pins the same contract for the tenant provider, and pins the
 * three properties that must NOT move with it: a failure still consumes a unit,
 * and the limits are unchanged. DEV-640: a throttled attempt now says so with
 * the `rate_limited` code instead of posing as a wrong password, and the
 * account budget is scoped to the host's organization rather than the bare
 * email shared with every tenant and the shared-host login.
 *
 * The rate limiter itself is deliberately NOT mocked — the assertions below are
 * about real counter state across a sequence of attempts, which a stubbed
 * `rateLimit` could not prove.
 */

const IP = '203.0.113.7';
const EMAIL = 'alex@company.com';
const PASSWORD = 'correct-horse-battery-staple';
const IP_KEY = `login:ip:${IP}`;
const ORGANIZATION_ID = 'org_chai_chowk';
const ACCOUNT_KEY = `login:acct:${ORGANIZATION_ID}:${EMAIL}`;
/** The bare-email bucket the shared-host login (/api/login) spends. */
const SHARED_HOST_ACCOUNT_KEY = `login:acct:${EMAIL}`;
const OTHER_ORGANIZATION_ACCOUNT_KEY = `login:acct:org_other:${EMAIL}`;
/** Mirrors the production limits in auth.ts — not a knob for the test to relax. */
const ACCOUNT_LIMIT = 10;
const IP_LIMIT = 30;

const mocks = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  compare: vi.fn(),
  recordAuthAudit: vi.fn(),
  verifyTotp: vi.fn(),
  resolveForRequest: vi.fn(),
  withTenantDb: vi.fn(),
  findFirstUser: vi.fn(),
  findUniqueUser: vi.fn(),
  updateUser: vi.fn(),
  findRecoveryCode: vi.fn(),
}));

vi.mock('next-auth', () => {
  class CredentialsSignin extends Error {
    code = 'credentials';
  }
  return {
    CredentialsSignin,
    default: (config: Record<string, unknown>) => {
      mocks.config = config;
      return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
    },
  };
});
vi.mock('next-auth/providers/credentials', () => ({
  default: (options: Record<string, unknown>) => options,
}));
vi.mock('bcryptjs', () => ({ compare: mocks.compare }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => IP,
  recordAuthAudit: mocks.recordAuthAudit,
}));
vi.mock('@/lib/totp', () => ({
  hashRecoveryCode: () => 'recovery-hash',
  verifyTotp: mocks.verifyTotp,
}));
vi.mock('@/lib/tenancy/host', () => ({
  isTenantLifecycleAccessible: () => true,
  requestHost: (request: Request) => new URL(request.url).hostname,
  resolveOrganizationById: vi.fn(),
  resolveOrganizationForRequest: mocks.resolveForRequest,
}));
vi.mock('@/lib/tenancy/host-routing', () => ({ isSharedHost: () => false }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
vi.mock('@/lib/platform/security', () => ({ parseCookie: () => null }));
vi.mock('@/lib/sso', () => ({ SSO_TICKET_COOKIE: 'df_sso_ticket' }));
vi.mock('@/lib/auth/login-intent', () => ({
  LOGIN_INTENT_COOKIE: 'df_login_intent',
  consumeLoginIntent: vi.fn(),
  peekLoginIntent: vi.fn(),
}));

import { clearRateLimit, rateLimit } from '@/lib/rate-limit';

await import('./auth');

type Provider = {
  authorize: (credentials: Record<string, unknown>, request: Request) => Promise<unknown>;
};

function credentialsProvider(): Provider {
  return (mocks.config as unknown as { providers: Provider[] }).providers[0]!;
}

const organization = {
  id: ORGANIZATION_ID,
  slug: 'chai-chowk',
  status: 'ACTIVE',
  isDemo: false,
  vertical: 'RESTAURANT',
  deploymentMode: 'DEDICATED',
};

function tenantUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user_alex',
    organizationId: organization.id,
    name: 'Alex',
    email: EMAIL,
    password: 'stored-hash',
    role: 'ADMIN',
    department: null,
    title: 'Owner',
    avatar: null,
    status: 'ACTIVE',
    tokenVersion: 0,
    twoFactorEnabledAt: null,
    twoFactorSecret: null,
    ...overrides,
  };
}

function useUser(user: Record<string, unknown>) {
  mocks.findFirstUser.mockResolvedValue(user);
  mocks.updateUser.mockResolvedValue(user);
}

function request() {
  return new Request('https://chai-chowk.localhost/api/auth/callback/credentials');
}

/** One sign-in attempt. Returns the resolved value, or the thrown error. */
async function attempt(password: string, totp?: string) {
  try {
    return await credentialsProvider().authorize({ email: EMAIL, password, totp }, request());
  } catch (error) {
    return error;
  }
}

/** The reason recorded for the most recent attempt (admin-only audit trail). */
function lastAuditReason(): string | undefined {
  const calls = mocks.recordAuthAudit.mock.calls;
  if (calls.length === 0) return undefined;
  return (calls[calls.length - 1]![0] as { reason?: string }).reason;
}

function auditReasons(): string[] {
  return mocks.recordAuthAudit.mock.calls
    .map((call) => (call[0] as { reason?: string }).reason)
    .filter((reason): reason is string => typeof reason === 'string');
}

beforeEach(async () => {
  vi.clearAllMocks();
  // The limiter is real and module-scoped: reset only the two keys under test.
  await clearRateLimit(IP_KEY);
  await clearRateLimit(ACCOUNT_KEY);
  await clearRateLimit(SHARED_HOST_ACCOUNT_KEY);
  await clearRateLimit(OTHER_ORGANIZATION_ACCOUNT_KEY);

  mocks.compare.mockImplementation(async (plain: string) => plain === PASSWORD);
  mocks.verifyTotp.mockReturnValue(false);
  mocks.resolveForRequest.mockResolvedValue(organization);
  mocks.findRecoveryCode.mockResolvedValue(null);
  useUser(tenantUser());
  mocks.withTenantDb.mockImplementation(
    async (_organizationId: string, run: (db: unknown) => unknown) =>
      run({
        user: {
          findFirst: mocks.findFirstUser,
          findUnique: mocks.findUniqueUser,
          update: mocks.updateUser,
        },
        organizationIdentityConnection: { findFirst: vi.fn().mockResolvedValue(null) },
        twoFactorRecoveryCode: {
          findFirst: mocks.findRecoveryCode,
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      })
  );
});

describe('tenant login rate limiting', () => {
  it('rejects a correct password when the returned account belongs to another host organization', async () => {
    useUser(tenantUser({ organizationId: 'org_other' }));
    expect(await attempt(PASSWORD)).toBeNull();
    expect(mocks.findFirstUser).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: EMAIL, organizationId: organization.id },
      })
    );
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
  it('clears both failure budgets once a sign-in is fully verified', async () => {
    // One unit short of the account limit, then a success that must reset it.
    for (let i = 0; i < ACCOUNT_LIMIT - 1; i += 1) {
      expect(await attempt('wrong-password')).toBeNull();
      expect(lastAuditReason()).toBe('Incorrect password');
    }
    expect(await attempt(PASSWORD)).toMatchObject({ id: 'user_alex', email: EMAIL });

    // Without the reset this run would be throttled from its 2nd attempt on.
    for (let i = 0; i < ACCOUNT_LIMIT - 1; i += 1) {
      expect(await attempt('wrong-password')).toBeNull();
      expect(lastAuditReason()).toBe('Incorrect password');
    }
    expect(await attempt(PASSWORD)).toMatchObject({ id: 'user_alex' });

    expect(auditReasons()).not.toContain('Rate limited');
  });

  it('never locks out a run of successful sign-ins', async () => {
    // More attempts than EITHER limit allows, so an uncleared ip or account
    // bucket would trip. This is the corpus failure: ~18 serial sign-ins as the
    // same admin inside one 5-minute window.
    for (let i = 0; i < IP_LIMIT + 5; i += 1) {
      expect(await attempt(PASSWORD)).toMatchObject({ id: 'user_alex' });
    }

    expect(auditReasons()).not.toContain('Rate limited');
    expect(mocks.compare).toHaveBeenCalledTimes(IP_LIMIT + 5);
  });

  it('still spends the account budget on every failure, and throttles at the limit', async () => {
    for (let i = 0; i < ACCOUNT_LIMIT; i += 1) {
      expect(await attempt('wrong-password')).toBeNull();
      expect(lastAuditReason()).toBe('Incorrect password');
    }

    const comparesBefore = mocks.compare.mock.calls.length;
    const throttled = await attempt('wrong-password');

    expect(lastAuditReason()).toBe('Rate limited');
    // Throttling happens ahead of the bcrypt compare, as REST-04 requires.
    expect(mocks.compare).toHaveBeenCalledTimes(comparesBefore);
    // DEV-640: a throttled attempt says it was throttled, not that the password
    // was wrong — the password was never checked.
    expect(throttled).toBeInstanceOf(Error);
    expect(throttled).toMatchObject({ code: 'rate_limited' });
    // And the correct password is refused too while the window is open, so the
    // limiter is not a bypass in either direction.
    const correctWhileThrottled = await attempt(PASSWORD);
    expect(correctWhileThrottled).toMatchObject({ code: 'rate_limited' });
    expect(correctWhileThrottled).not.toHaveProperty('id');
    expect(mocks.compare).toHaveBeenCalledTimes(comparesBefore);
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(lastAuditReason()).toBe('Rate limited');
  });

  it('throttles an unknown address exactly like a known one, so the code is no oracle', async () => {
    mocks.findFirstUser.mockResolvedValue(null);
    for (let i = 0; i < ACCOUNT_LIMIT; i += 1) {
      expect(await attempt('wrong-password')).toBeNull();
      expect(lastAuditReason()).toBe('No such account');
    }
    expect(await attempt('wrong-password')).toMatchObject({ code: 'rate_limited' });
    expect(lastAuditReason()).toBe('Rate limited');
  });

  it('reports the per-IP limit with the same rate_limited code', async () => {
    const otherEmails = Array.from({ length: IP_LIMIT }, (_, i) => `probe${i}@example.com`);
    mocks.findFirstUser.mockResolvedValue(null);
    for (const email of otherEmails) {
      expect(
        await credentialsProvider().authorize({ email, password: 'wrong' }, request())
      ).toBeNull();
    }
    expect(await attempt(PASSWORD)).toMatchObject({ code: 'rate_limited' });
    expect(lastAuditReason()).toBe('Rate limited');
    for (const email of otherEmails) {
      await clearRateLimit(`login:acct:${ORGANIZATION_ID}:${email}`);
    }
  });

  it('is not locked out by failures spent on the shared host or another organization', async () => {
    // Exhaust the bare-email bucket the shared-host login spends, and the same
    // address's bucket in another organization.
    for (let i = 0; i <= ACCOUNT_LIMIT; i += 1) {
      await rateLimit(SHARED_HOST_ACCOUNT_KEY, ACCOUNT_LIMIT, 5 * 60_000);
      await rateLimit(OTHER_ORGANIZATION_ACCOUNT_KEY, ACCOUNT_LIMIT, 5 * 60_000);
    }
    expect((await rateLimit(SHARED_HOST_ACCOUNT_KEY, ACCOUNT_LIMIT, 5 * 60_000)).ok).toBe(false);

    expect(await attempt(PASSWORD)).toMatchObject({ id: 'user_alex' });
    expect(auditReasons()).not.toContain('Rate limited');
  });

  it('keeps failures on this host out of the shared-host and other-organization buckets', async () => {
    for (let i = 0; i < ACCOUNT_LIMIT; i += 1) {
      expect(await attempt('wrong-password')).toBeNull();
    }
    expect(await attempt('wrong-password')).toMatchObject({ code: 'rate_limited' });

    expect((await rateLimit(SHARED_HOST_ACCOUNT_KEY, ACCOUNT_LIMIT, 5 * 60_000)).remaining).toBe(
      ACCOUNT_LIMIT - 1
    );
    expect(
      (await rateLimit(OTHER_ORGANIZATION_ACCOUNT_KEY, ACCOUNT_LIMIT, 5 * 60_000)).remaining
    ).toBe(ACCOUNT_LIMIT - 1);
  });

  it('does not clear the budget when the password is right but the second factor is wrong', async () => {
    useUser(tenantUser({ twoFactorEnabledAt: new Date(), twoFactorSecret: 'totp-secret' }));

    // A correct password alone must not refund the attempt: otherwise whoever
    // already holds the password gets an unlimited budget for grinding codes.
    for (let i = 0; i < ACCOUNT_LIMIT; i += 1) {
      expect(await attempt(PASSWORD, '000000')).toBeInstanceOf(Error);
      expect(lastAuditReason()).toBe('Invalid 2FA code');
    }

    expect(await attempt(PASSWORD, '000000')).toMatchObject({ code: 'rate_limited' });
    expect(lastAuditReason()).toBe('Rate limited');
  });
});

describe('password authentication evidence', () => {
  type Claims = Record<string, unknown>;
  function callbacks() {
    return (
      mocks.config as unknown as {
        callbacks: {
          jwt: (input: Claims) => Promise<Claims>;
          session: (input: Claims) => Promise<{ user: Claims }>;
        };
      }
    ).callbacks;
  }

  it('issues evidence only after a successful password and second factor', async () => {
    useUser(tenantUser({ twoFactorEnabledAt: new Date(), twoFactorSecret: 'secret' }));
    expect(await attempt('wrong-password')).toBeNull();
    expect(await attempt(PASSWORD)).toBeInstanceOf(Error);
    expect(await attempt(PASSWORD, '123456')).toBeInstanceOf(Error);
    mocks.verifyTotp.mockReturnValue(true);
    const before = Date.now();
    const user = (await attempt(PASSWORD, '123456')) as Claims;
    expect(user.passwordAuthenticatedAt).toBeGreaterThanOrEqual(before);
    expect(user.passwordAuthenticatedAt).toBeLessThanOrEqual(Date.now());
    const token = await callbacks().jwt({ token: {}, user });
    const session = await callbacks().session({ session: { user: {} }, token });
    expect(session.user.passwordAuthenticatedAt).toBe(user.passwordAuthenticatedAt);
  });

  it('preserves original evidence across routine validation and ignores client updates', async () => {
    const authenticatedAt = Date.now() - 6 * 60_000;
    mocks.findUniqueUser.mockResolvedValue({
      ...tenantUser(),
      organization: { slug: organization.slug, status: 'ACTIVE', isDemo: false },
    });
    const token = await callbacks().jwt({
      token: {
        id: 'user_alex',
        organizationId: organization.id,
        tokenVersion: 0,
        passwordAuthenticatedAt: authenticatedAt,
        lastValidatedAt: 0,
      },
      trigger: 'update',
      session: { passwordAuthenticatedAt: Date.now() },
    });
    expect(mocks.findUniqueUser).toHaveBeenCalledOnce();
    expect(token.passwordAuthenticatedAt).toBe(authenticatedAt);
    expect(token.lastValidatedAt).toBeGreaterThan(authenticatedAt);
  });

  it('clears old evidence on non-password sign-in and leaves legacy sessions without evidence', async () => {
    const token = await callbacks().jwt({
      token: { passwordAuthenticatedAt: Date.now() },
      user: { id: 'sso_user', organizationId: organization.id },
    });
    expect(token.passwordAuthenticatedAt).toBeUndefined();
    const legacy = await callbacks().jwt({ token: { lastValidatedAt: Date.now() } });
    expect(legacy.passwordAuthenticatedAt).toBeUndefined();
  });

  it('withholds password evidence from revoked sessions', async () => {
    const session = await callbacks().session({
      session: { user: {} },
      token: { passwordAuthenticatedAt: Date.now(), sessionRevoked: true },
    });
    expect(session.user.passwordAuthenticatedAt).toBeUndefined();
    expect(session.user.sessionRevoked).toBe(true);
  });
});
