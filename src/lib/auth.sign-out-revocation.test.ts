import { beforeEach, describe, expect, it, vi } from 'vitest';

// #1252: signing out must invalidate the session token server-side, so a copied
// cookie replayed after sign-out is rejected at the next revalidation.

const mocks = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  withTenantDb: vi.fn(),
  recordAuthAudit: vi.fn(),
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
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => '203.0.113.7',
  recordAuthAudit: mocks.recordAuthAudit,
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfter: 0 }),
  clearRateLimit: vi.fn(),
}));
vi.mock('@/lib/tenancy/host', () => ({
  isTenantLifecycleAccessible: () => true,
  requestHost: (request: Request) => new URL(request.url).hostname,
  resolveOrganizationById: vi.fn(),
  resolveOrganizationForRequest: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: mocks.withTenantDb,
  withPlatformDb: vi.fn(),
}));

await import('./auth');

type Token = Record<string, unknown>;
type AuthConfig = {
  callbacks: { jwt: (input: Record<string, unknown>) => Promise<Token> };
  events: { signOut: (message: { token: Token | null }) => Promise<void> };
};

function config() {
  return mocks.config as unknown as AuthConfig;
}

const ORG = 'org_sehatcart';
const USER = 'user_cashier';

// One tenant user row that the fake tenant client reads and writes.
let row: { tokenVersion: number };

function fakeTenantDb() {
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === USER
          ? {
              role: 'MEMBER',
              status: 'ACTIVE',
              department: null,
              title: null,
              tokenVersion: row.tokenVersion,
              mustChangePassword: false,
              organization: { slug: 'sehatcart', status: 'ACTIVE', isDemo: false },
            }
          : null
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; tokenVersion: number };
          data: { tokenVersion: { increment: number } };
        }) => {
          if (where.id !== USER || where.tokenVersion !== row.tokenVersion) return { count: 0 };
          row.tokenVersion += data.tokenVersion.increment;
          return { count: 1 };
        }
      ),
    },
  };
}

/** A signed-in cashier's token, last revalidated past the 60 s window. */
function issuedToken(tokenVersion: number): Token {
  return {
    id: USER,
    organizationId: ORG,
    organizationSlug: 'sehatcart',
    organizationStatus: 'ACTIVE',
    role: 'MEMBER',
    status: 'ACTIVE',
    tokenVersion,
    sessionRevoked: false,
    sessionInvalidReason: null,
    lastValidatedAt: Date.now() - 75_000,
  };
}

/** Replays a copied cookie: Auth.js decodes it and runs the jwt() callback. */
function replay(token: Token) {
  return config().callbacks.jwt({ token: { ...token } });
}

beforeEach(() => {
  vi.clearAllMocks();
  row = { tokenVersion: 3 };
  mocks.withTenantDb.mockImplementation(async (_org: string, run: (db: unknown) => unknown) =>
    run(fakeTenantDb())
  );
});

describe('sign-out session revocation (#1252)', () => {
  it('accepts a replayed token while the user is still signed in', async () => {
    const result = await replay(issuedToken(3));
    expect(result.sessionRevoked).toBe(false);
    expect(result.sessionInvalidReason).toBeNull();
  });

  it('rejects a copied token replayed after sign-out, past the revalidation window', async () => {
    const copied = issuedToken(3);

    await config().events.signOut({ token: { ...copied } });

    expect(row.tokenVersion).toBe(4);
    expect(mocks.withTenantDb).toHaveBeenCalledWith(ORG, expect.any(Function));
    expect(mocks.recordAuthAudit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LOGOUT', organizationId: ORG, userId: USER })
    );

    const result = await replay(copied);
    expect(result.sessionRevoked).toBe(true);
    expect(result.sessionInvalidReason).toBe('REVOKED');
  });

  it('keeps the replayed token revoked on every later read', async () => {
    const copied = issuedToken(3);
    await config().events.signOut({ token: { ...copied } });

    const first = await replay(copied);
    const later = await replay({ ...first, lastValidatedAt: Date.now() - 75_000 });
    expect(later.sessionRevoked).toBe(true);
    expect(later.sessionInvalidReason).toBe('REVOKED');
  });

  it('does not let an already-revoked token end a newer session', async () => {
    // Version 2 was revoked earlier; the user has since signed in at version 3.
    await config().events.signOut({ token: issuedToken(2) });

    expect(row.tokenVersion).toBe(3);
    const current = await replay(issuedToken(3));
    expect(current.sessionRevoked).toBe(false);
  });

  it('ignores a sign-out without a decodable token', async () => {
    await config().events.signOut({ token: null });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(row.tokenVersion).toBe(3);
  });
});
