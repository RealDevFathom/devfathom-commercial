import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEMO_PERSONA_KEYS,
  DEMO_PERSONAS,
  demoPersonaUserId,
  demoPersonaEmail,
  demoPersonaUserRole,
} from './demo/personas';

const mocks = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  compare: vi.fn(),
  resolveForRequest: vi.fn(),
  resolveById: vi.fn(),
  withTenantDb: vi.fn(),
  withPlatformDb: vi.fn(),
  peekIntent: vi.fn(),
  consumeIntent: vi.fn(),
  parseCookie: vi.fn(),
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
  resolveOrganizationById: mocks.resolveById,
  resolveOrganizationForRequest: mocks.resolveForRequest,
}));
vi.mock('@/lib/tenancy/host-routing', () => ({ isSharedHost: () => true }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: mocks.withTenantDb,
  withPlatformDb: mocks.withPlatformDb,
}));
vi.mock('@/lib/platform/security', () => ({ parseCookie: mocks.parseCookie }));
vi.mock('@/lib/sso', () => ({ SSO_TICKET_COOKIE: 'df_sso_ticket' }));
vi.mock('@/lib/auth/login-intent', () => ({
  LOGIN_INTENT_COOKIE: 'df_login_intent',
  consumeLoginIntent: mocks.consumeIntent,
  peekLoginIntent: mocks.peekIntent,
}));

await import('./auth');

type Provider = {
  authorize: (credentials: Record<string, unknown>, request: Request) => Promise<unknown>;
};
type AuthConfig = {
  providers: Provider[];
  callbacks: {
    jwt: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    session: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  session: { maxAge: number; updateAge: number };
};

function config() {
  return mocks.config as unknown as AuthConfig;
}

const demoOrganization = {
  id: 'org_demo_restaurant_seat_1',
  slug: 'demo-restaurant-seat-1',
  status: 'ACTIVE',
  isDemo: true,
  vertical: 'RESTAURANT',
  deploymentMode: 'SHARED',
};
const demoUser = {
  id: 'user_demo_restaurant_seat_1_manager',
  organizationId: demoOrganization.id,
  name: 'Demo Manager',
  email: 'manager.seat1@demo.devfathom.invalid',
  role: 'ADMIN',
  department: null,
  title: 'General manager',
  avatar: null,
  status: 'ACTIVE',
  tokenVersion: 0,
  twoFactorEnabledAt: null,
  twoFactorSecret: null,
  password: null,
  organizationRole: { key: 'owner' },
};

function request() {
  return new Request('https://www.devfathom.com/api/auth/callback/login-intent', {
    headers: { cookie: 'df_login_intent=opaque-handle; df_sso_ticket=opaque-ticket' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DEMO_ACCESS_CODE', 'test-only-code');
  mocks.compare.mockResolvedValue(false);
  mocks.resolveForRequest.mockResolvedValue(demoOrganization);
  mocks.resolveById.mockResolvedValue(demoOrganization);
  mocks.parseCookie.mockImplementation((_cookie, name) =>
    name === 'df_login_intent' ? 'opaque-handle' : 'x'.repeat(40)
  );
  mocks.peekIntent.mockResolvedValue({
    email: demoUser.email,
    candidates: [
      {
        organizationId: demoOrganization.id,
        userId: demoUser.id,
        demoAccessExpiresAt: Date.now() + 60_000,
      },
    ],
  });
  mocks.consumeIntent.mockResolvedValue({ id: 'intent_1' });
  mocks.withPlatformDb.mockImplementation(async (run) =>
    run({
      pendingLoginIntent: {
        findUnique: vi.fn().mockResolvedValue({ createdAt: new Date(Date.now() - 120000) }),
      },
    })
  );
  mocks.withTenantDb.mockImplementation(async (_organizationId, run) =>
    run({
      user: {
        findUnique: vi.fn().mockResolvedValue(demoUser),
        update: vi.fn().mockResolvedValue(demoUser),
      },
      organizationIdentityConnection: { findFirst: vi.fn().mockResolvedValue(null) },
      restaurantStaffProfile: { findMany: vi.fn().mockResolvedValue([{ id: 'staff_1' }]) },
    })
  );
});
afterEach(() => vi.unstubAllEnvs());

describe('demo Auth.js boundary', () => {
  it('keeps the ordinary Auth.js lifetime at eight hours', () => {
    expect(config().session).toEqual({
      strategy: 'jwt',
      maxAge: 8 * 60 * 60,
      updateAge: 60 * 60,
    });
  });

  it('rejects demo users through ordinary credentials and enterprise SSO', async () => {
    const [credentials, , enterprise] = config().providers;

    await expect(
      credentials!.authorize({ email: demoUser.email, password: 'irrelevant' }, request())
    ).resolves.toBeNull();
    await expect(enterprise!.authorize({}, request())).resolves.toBeNull();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('preserves the password-route intent creation time after shared-host selection', async () => {
    const createdAt = new Date(Date.now() - 240000);
    const read = vi.fn().mockResolvedValue({ createdAt });
    mocks.withPlatformDb.mockImplementation(async (run) =>
      run({ pendingLoginIntent: { findUnique: read } })
    );
    mocks.resolveById.mockResolvedValue({ ...demoOrganization, id: 'org_real', isDemo: false });
    mocks.peekIntent.mockResolvedValue({
      email: demoUser.email,
      candidates: [{ organizationId: 'org_real', userId: 'user_real' }],
    });
    mocks.withTenantDb.mockImplementation(async (_org, run) =>
      run({
        user: {
          findUnique: vi.fn().mockResolvedValue({
            ...demoUser,
            id: 'user_real',
            organizationId: 'org_real',
            password: 'stored-hash',
          }),
          update: vi.fn(),
        },
        organizationIdentityConnection: { findFirst: vi.fn().mockResolvedValue(null) },
      })
    );
    const result = await config().providers[1]!.authorize(
      { organizationId: 'org_real' },
      request()
    );
    expect(result).toMatchObject({ passwordAuthenticatedAt: createdAt.getTime() });
    expect(read).toHaveBeenCalledWith({
      where: { id: 'intent_1' },
      select: { createdAt: true, ip: true },
    });
  });

  it('admits only the exact marked demo manager through a live server-owned intent', async () => {
    const provider = config().providers[1]!;
    const result = await provider.authorize({ organizationId: demoOrganization.id }, request());

    expect(result).toMatchObject({
      id: demoUser.id,
      organizationId: demoOrganization.id,
      demoAccessExpiresAt: expect.any(Number),
    });
    expect(result).not.toHaveProperty('passwordAuthenticatedAt', expect.any(Number));
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
    expect(mocks.consumeIntent).toHaveBeenCalledWith(
      'opaque-handle',
      'www.devfathom.com',
      demoOrganization.id
    );
  });

  it.each([
    ['missing expiry', undefined, demoUser.id],
    ['expired expiry', Date.now() - 1, demoUser.id],
    ['wrong manager', Date.now() + 60_000, 'user_other'],
    ['malformed expiry', Number.NaN, demoUser.id],
  ])('rejects a demo intent with %s', async (_label, expiry, userId) => {
    mocks.peekIntent.mockResolvedValue({
      email: demoUser.email,
      candidates: [
        {
          organizationId: demoOrganization.id,
          userId,
          ...(expiry === undefined ? {} : { demoAccessExpiresAt: expiry }),
        },
      ],
    });

    await expect(
      config().providers[1]!.authorize({ organizationId: demoOrganization.id }, request())
    ).resolves.toBeNull();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it.each(DEMO_PERSONA_KEYS)(
    'authenticates the server-owned %s identity and keeps its actual role',
    async (persona) => {
      const user = {
        ...demoUser,
        id: demoPersonaUserId(1, persona),
        email: demoPersonaEmail(1, persona),
        role: demoPersonaUserRole(persona),
        organizationRole: { key: DEMO_PERSONAS[persona].roleKey },
      };
      const update = vi.fn();
      mocks.peekIntent.mockResolvedValue({
        email: user.email,
        candidates: [
          {
            organizationId: demoOrganization.id,
            userId: user.id,
            demoAccessExpiresAt: Date.now() + 60_000,
          },
        ],
      });
      const findUser = vi.fn().mockResolvedValue(user);
      mocks.withTenantDb.mockImplementation(async (_id, run) =>
        run({
          user: { findUnique: findUser, update },
          restaurantStaffProfile: { findMany: vi.fn().mockResolvedValue([{ id: 'staff' }]) },
          organizationIdentityConnection: { findFirst: vi.fn().mockResolvedValue(null) },
        })
      );
      await expect(
        config().providers[1]!.authorize({ organizationId: demoOrganization.id }, request())
      ).resolves.toMatchObject({ id: user.id, role: user.role });
      mocks.consumeIntent.mockClear();
      findUser.mockResolvedValue({ ...user, password: 'production-password-hash' });
      await expect(
        config().providers[1]!.authorize({ organizationId: demoOrganization.id }, request())
      ).resolves.toBeNull();
      expect(mocks.consumeIntent).not.toHaveBeenCalled();
    }
  );

  it.each([
    { isDemo: false },
    { deploymentMode: 'DEDICATED' },
    { vertical: 'AGENCY' },
    { slug: 'production' },
    { status: 'SUSPENDED' },
  ])('rejects a demo intent after tenant state changes: %j', async (change) => {
    mocks.resolveById.mockResolvedValue({ ...demoOrganization, ...change });
    await expect(
      config().providers[1]!.authorize({ organizationId: demoOrganization.id }, request())
    ).resolves.toBeNull();
    expect(mocks.consumeIntent).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('sanitizes malformed expiry claims before exposing the session', async () => {
    const session = (await config().callbacks.session({
      session: { expires: 'later', user: {} },
      token: {
        id: demoUser.id,
        organizationId: demoOrganization.id,
        status: 'ACTIVE',
        demoAccessExpiresAt: Number.NaN,
      },
    })) as { user: { demoAccessExpiresAt?: number } };

    expect(session.user.demoAccessExpiresAt).toBeUndefined();
  });

  it('revokes an invalid expiry claim in the JWT callback', async () => {
    const token = await config().callbacks.jwt({
      token: { demoAccessExpiresAt: Number.POSITIVE_INFINITY },
    });

    expect(token).toMatchObject({
      sessionRevoked: true,
      sessionInvalidReason: 'DEMO_ACCESS_EXPIRED',
    });
  });
});
