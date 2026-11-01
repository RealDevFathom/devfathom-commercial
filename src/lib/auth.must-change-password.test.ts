import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #164 — the must-change-password gate must follow the member, not the token.
 *
 * The gate is only sound if `mustChangePassword` is re-read from the database on
 * the JWT refresh path, not frozen at sign-in. These tests pin two halves of
 * that contract on the REAL `jwt`/`session` callbacks:
 *
 *   1. An administrator reset (which flips `mustChangePassword` AND bumps
 *      `tokenVersion`) ends every existing session on its next refresh — the
 *      strongest form of forcing the gate, because the member must sign in again
 *      and is then gated from the first request.
 *   2. Even without a `tokenVersion` bump, a refresh re-reads `mustChangePassword`
 *      from the DB, so the flag reaches a session that is already live and the
 *      change-password gate applies without waiting for a fresh sign-in.
 *
 * The revalidation is time-gated (`REVALIDATE_AFTER_MS`), so each case presents a
 * stale token (`lastValidatedAt: 0`) to force the refresh branch.
 */

const mocks = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  withTenantDb: vi.fn(),
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
vi.mock('bcryptjs', () => ({ compare: vi.fn(), hash: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => '203.0.113.7',
  recordAuthAudit: vi.fn(),
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfter: 0 }),
  clearRateLimit: vi.fn(),
}));
vi.mock('@/lib/totp', () => ({ hashRecoveryCode: vi.fn(), verifyTotp: vi.fn() }));
vi.mock('@/lib/tenancy/host', () => ({
  isTenantLifecycleAccessible: () => true,
  requestHost: (request: Request) => new URL(request.url).hostname,
  resolveOrganizationById: vi.fn(),
  resolveOrganizationForRequest: vi.fn(),
}));
vi.mock('@/lib/tenancy/host-routing', () => ({ isSharedHost: () => true }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: mocks.withTenantDb,
  withPlatformDb: vi.fn(),
}));
vi.mock('@/lib/platform/security', () => ({ parseCookie: vi.fn() }));
vi.mock('@/lib/sso', () => ({ SSO_TICKET_COOKIE: 'df_sso_ticket' }));
vi.mock('@/lib/auth/login-intent', () => ({
  LOGIN_INTENT_COOKIE: 'df_login_intent',
  consumeLoginIntent: vi.fn(),
  peekLoginIntent: vi.fn(),
}));

await import('./auth');

type AuthConfig = {
  callbacks: {
    jwt: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    session: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

function config() {
  return mocks.config as unknown as AuthConfig;
}

/** The member row the next revalidation reads back from the tenant database. */
function freshUser(overrides: Record<string, unknown>) {
  return {
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    department: null,
    title: null,
    tokenVersion: 0,
    mustChangePassword: false,
    organization: { slug: 'acme', status: 'ACTIVE', isDemo: false },
    ...overrides,
  };
}

/** A live, signed-in token whose snapshot predates the administrator's action. */
function liveToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user_1',
    organizationId: 'org_acme',
    status: 'ACTIVE',
    role: 'EMPLOYEE',
    tokenVersion: 0,
    mustChangePassword: false,
    lastValidatedAt: 0, // stale → forces the DB revalidation branch
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the must-change-password gate on JWT refresh', () => {
  it('re-reads mustChangePassword from the DB on refresh, not only at sign-in', async () => {
    // The administrator flipped the flag WITHOUT a tokenVersion bump: the live
    // session is not revoked, but the refresh must still pick up the flag.
    mocks.withTenantDb.mockImplementation(
      async (_id: string, run: (db: unknown) => Promise<unknown>) =>
        run({ user: { findUnique: async () => freshUser({ mustChangePassword: true }) } })
    );

    const token = await config().callbacks.jwt({ token: liveToken() });

    expect(token.mustChangePassword).toBe(true);
    expect(token.sessionRevoked).toBe(false);

    const { user } = (await config().callbacks.session({
      session: { expires: 'later', user: {} },
      token,
    })) as { user: { mustChangePassword?: boolean } };
    expect(user.mustChangePassword).toBe(true);
  });

  it('ends an existing session on refresh after an administrator password reset', async () => {
    // adminResetPassword sets mustChangePassword AND bumps tokenVersion, so the
    // snapshot is now stale: the session is revoked and the member must sign in
    // again, where the gate applies from the first request.
    mocks.withTenantDb.mockImplementation(
      async (_id: string, run: (db: unknown) => Promise<unknown>) =>
        run({
          user: {
            findUnique: async () => freshUser({ mustChangePassword: true, tokenVersion: 1 }),
          },
        })
    );

    const token = await config().callbacks.jwt({ token: liveToken() });

    expect(token).toMatchObject({ sessionRevoked: true, sessionInvalidReason: 'REVOKED' });

    const { user } = (await config().callbacks.session({
      session: { expires: 'later', user: {} },
      token,
    })) as { user: { sessionRevoked?: boolean; sessionInvalidReason?: string | null } };
    expect(user.sessionRevoked).toBe(true);
    expect(user.sessionInvalidReason).toBe('REVOKED');
  });

  it('clears the flag on refresh once the member has changed their password', async () => {
    // The mirror case: a member whose token still carries the flag but whose DB
    // row no longer does must stop being gated after the next revalidation.
    mocks.withTenantDb.mockImplementation(
      async (_id: string, run: (db: unknown) => Promise<unknown>) =>
        run({ user: { findUnique: async () => freshUser({ mustChangePassword: false }) } })
    );

    const token = await config().callbacks.jwt({
      token: liveToken({ mustChangePassword: true }),
    });

    expect(token.mustChangePassword).toBe(false);
    expect(token.sessionRevoked).toBe(false);
  });
});
