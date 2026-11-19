import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEV-961 — the approval-authenticator gate on the REAL `jwt`/`session` callbacks.
 *
 *  - At sign-in the member's approver right is derived and the gate decided, so the first
 *    request after sign-in already goes to the set-up screen.
 *  - On every later request, for an approver, the same read that checks the revocation
 *    counter carries the organization switch and the enrolment, so enrolling, a reset or the
 *    owner's switch takes effect on the next request.
 *  - At each revalidation the approver right is re-derived with the role.
 *  - Anything that cannot be decided fails closed to the set-up screen.
 */

const mocks = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  withTenantDb: vi.fn(),
  holdsAnyApprovalRight: vi.fn(),
}));

vi.mock('@/lib/approval-authenticator-gate', () => ({
  holdsAnyApprovalRight: mocks.holdsAnyApprovalRight,
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
  refundRateLimit: vi.fn(),
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

type Gate = { required?: boolean; enrolled?: boolean };

function userRow(gate: Gate, overrides: Record<string, unknown> = {}) {
  return {
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    department: null,
    title: null,
    tokenVersion: 0,
    mustChangePassword: false,
    organization: {
      slug: 'acme',
      status: 'ACTIVE',
      isDemo: false,
      requireApprovalAuthenticator: gate.required ?? true,
    },
    approvalAuthenticators: gate.enrolled ? [{ id: 'auth_1' }] : [],
    ...overrides,
  };
}

function database(gate: Gate) {
  const findUnique = vi.fn(async () => userRow(gate));
  mocks.withTenantDb.mockImplementation(
    async (_id: string, run: (db: unknown) => Promise<unknown>) => run({ user: { findUnique } })
  );
  return findUnique;
}

const signedIn = {
  id: 'user_1',
  organizationId: 'org_acme',
  organizationSlug: 'acme',
  organizationStatus: 'ACTIVE',
  role: 'EMPLOYEE',
  status: 'ACTIVE',
  tokenVersion: 0,
};

function liveToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user_1',
    organizationId: 'org_acme',
    status: 'ACTIVE',
    role: 'EMPLOYEE',
    tokenVersion: 0,
    lastValidatedAt: Date.now(), // fresh: the per-request path
    signedInAt: Date.now(),
    ...overrides,
  };
}

async function sessionUser(token: Record<string, unknown>) {
  const { user } = (await config().callbacks.session({
    session: { expires: 'later', user: {} },
    token,
  })) as { user: Record<string, unknown> };
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DEV-961 approval authenticator gate at sign-in', () => {
  it('sends an approver with no authenticator to set-up from the first request', async () => {
    database({ required: true });
    mocks.holdsAnyApprovalRight.mockResolvedValue(true);
    const token = await config().callbacks.jwt({ token: {}, user: signedIn });
    expect(token).toMatchObject({
      approvalApprover: true,
      approvalAuthenticatorSetupRequired: true,
    });
    expect(await sessionUser(token)).toMatchObject({ approvalAuthenticatorSetupRequired: true });
    expect(mocks.holdsAnyApprovalRight).toHaveBeenCalledWith(expect.anything(), {
      organizationId: 'org_acme',
      userId: 'user_1',
    });
  });

  it('does not ask a member with no approver right, or an enrolled approver', async () => {
    database({ required: true });
    mocks.holdsAnyApprovalRight.mockResolvedValue(false);
    let token = await config().callbacks.jwt({ token: {}, user: signedIn });
    expect(token).toMatchObject({
      approvalApprover: false,
      approvalAuthenticatorSetupRequired: false,
    });

    database({ required: true, enrolled: true });
    mocks.holdsAnyApprovalRight.mockResolvedValue(true);
    token = await config().callbacks.jwt({ token: {}, user: signedIn });
    expect(token).toMatchObject({
      approvalApprover: true,
      approvalAuthenticatorSetupRequired: false,
    });
  });

  it('does not ask anyone while the owner has turned the requirement off', async () => {
    database({ required: false });
    mocks.holdsAnyApprovalRight.mockResolvedValue(true);
    const token = await config().callbacks.jwt({ token: {}, user: signedIn });
    expect(token.approvalAuthenticatorSetupRequired).toBe(false);
  });

  it('fails closed to the set-up screen when the gate cannot be decided', async () => {
    mocks.withTenantDb.mockRejectedValue(new Error('database unavailable'));
    const token = await config().callbacks.jwt({ token: {}, user: signedIn });
    expect(token).toMatchObject({
      approvalApprover: true,
      approvalAuthenticatorSetupRequired: true,
    });

    database({ required: true, enrolled: true });
    mocks.holdsAnyApprovalRight.mockRejectedValue(new Error('policy lookup failed'));
    const unsure = await config().callbacks.jwt({ token: {}, user: signedIn });
    expect(unsure.approvalApprover).toBe(true);
  });
});

describe('DEV-961 approval authenticator gate on every request', () => {
  it('releases the account on the next request once the approver has enrolled', async () => {
    const findUnique = database({ required: true, enrolled: true });
    const token = await config().callbacks.jwt({
      token: liveToken({ approvalApprover: true, approvalAuthenticatorSetupRequired: true }),
    });
    expect(token.approvalAuthenticatorSetupRequired).toBe(false);
    expect(token.sessionRevoked).toBeUndefined();
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          tokenVersion: true,
          approvalAuthenticators: expect.anything(),
        }),
      })
    );
    expect(mocks.holdsAnyApprovalRight).not.toHaveBeenCalled();
  });

  it('gates the next request after a reset or the owner switching it back on', async () => {
    database({ required: true, enrolled: false });
    const token = await config().callbacks.jwt({
      token: liveToken({ approvalApprover: true, approvalAuthenticatorSetupRequired: false }),
    });
    expect(token.approvalAuthenticatorSetupRequired).toBe(true);
    expect(await sessionUser(token)).toMatchObject({ approvalAuthenticatorSetupRequired: true });
  });

  it('leaves a non-approver alone without reading the gate', async () => {
    const findUnique = database({ required: true });
    const token = await config().callbacks.jwt({
      token: liveToken({ approvalApprover: false, approvalAuthenticatorSetupRequired: false }),
    });
    expect(token.approvalAuthenticatorSetupRequired).toBe(false);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: { tokenVersion: true } })
    );
  });

  it('re-derives the approver right with the role at revalidation', async () => {
    database({ required: true });
    mocks.holdsAnyApprovalRight.mockResolvedValue(true);
    const promoted = await config().callbacks.jwt({
      token: liveToken({
        lastValidatedAt: 0,
        approvalApprover: false,
        approvalAuthenticatorSetupRequired: false,
      }),
    });
    expect(promoted).toMatchObject({
      approvalApprover: true,
      approvalAuthenticatorSetupRequired: true,
    });

    mocks.holdsAnyApprovalRight.mockResolvedValue(false);
    const demoted = await config().callbacks.jwt({
      token: liveToken({
        lastValidatedAt: 0,
        approvalApprover: true,
        approvalAuthenticatorSetupRequired: true,
      }),
    });
    expect(demoted).toMatchObject({
      approvalApprover: false,
      approvalAuthenticatorSetupRequired: false,
    });
  });
});

describe('DEV-961 the sign-in time a passwordless member can prove', () => {
  it('exposes the time of a real sign-in, and never a backfilled one', async () => {
    database({ required: true });
    mocks.holdsAnyApprovalRight.mockResolvedValue(false);
    const before = Date.now();
    const token = await config().callbacks.jwt({ token: {}, user: signedIn });
    const user = await sessionUser(token);
    expect(user.signedInAt).toBeGreaterThanOrEqual(before);
    expect(user.signedInAt).toBe(token.signInVerifiedAt);

    // A token from before this claim existed gets a backfilled signedInAt, which is not
    // proof of a fresh sign-in.
    database({ required: true });
    const legacy = await config().callbacks.jwt({ token: liveToken({ signedInAt: undefined }) });
    expect(typeof legacy.signedInAt).toBe('number');
    expect((await sessionUser(legacy)).signedInAt).toBeUndefined();
  });
});
