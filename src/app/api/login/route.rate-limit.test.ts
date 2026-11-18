import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * WHA-1570 — the shared-host two-step login must not spend the `login:ip` /
 * `login:acct` failure budgets on successful sign-ins.
 *
 * /api/login (step 1) proves only the password; the second factor is proven at
 * workspace selection by the `login-intent` provider (step 2). The budgets are
 * therefore cleared only once step 2 succeeds — the same contract, and the same
 * four cases, as src/lib/auth.rate-limit.test.ts pins for the per-host provider.
 *
 * The rate limiter itself is deliberately NOT mocked — the assertions below are
 * about real counter state across a sequence of attempts, which a stubbed
 * `rateLimit` could not prove. Kept apart from route.test.ts because that suite
 * stubs the limiter for the whole file.
 */

const HOST = 'www.devfathom.com';
const IP = '203.0.113.9';
const OTHER_IP = '198.51.100.7';
const EMAIL = 'alex@company.com';
const PASSWORD = 'correct-horse-battery-staple';
const IP_KEY = `login:ip:${IP}`;
const ACCOUNT_KEY = `login:acct:${EMAIL}`;
const INTENT_KEY = `login:intent:${IP}`;
const SELECT_KEY = `login:select:${IP}`;
/** Mirrors the production limits — not a knob for the test to relax. */
const ACCOUNT_LIMIT = 10;
const IP_LIMIT = 30;
/** DEV-932: the per-address cap on failed guesses, across every account. */
const INTENT_LIMIT = 20;
const SELECT_LIMIT = 30;
/** DEV-932: a shop's staff behind one connection — more than every per-address limit. */
const STAFF = Array.from({ length: 40 }, (_, i) => `staff${i + 1}@company.com`);
const INTENT_ACCOUNT_KEYS = [EMAIL, ...STAFF].map((email) => `login:intent-account:${IP}:${email}`);
const WINDOW_MS = 5 * 60_000;

const UNIFORM_FAILURE = {
  outcome: 'failed',
  message: 'Invalid email or password. Please try again.',
};

type StoredIntent = {
  email: string;
  host: string;
  candidates: { organizationId: string; userId: string }[];
  used: boolean;
  createdAt: Date;
  ip?: string | null;
};

const mocks = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  ip: '203.0.113.9',
  intents: new Map<string, StoredIntent>(),
  resolveSharedLogin: vi.fn(),
  recordAuthAudit: vi.fn(),
  verifyTotp: vi.fn(),
  resolveById: vi.fn(),
  withTenantDb: vi.fn(),
  findUniqueUser: vi.fn(),
}));

vi.mock('server-only', () => ({}));
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
  ipFromHeaders: () => mocks.ip,
  recordAuthAudit: mocks.recordAuthAudit,
}));
vi.mock('@/lib/totp', () => ({
  hashRecoveryCode: () => 'recovery-hash',
  verifyTotp: mocks.verifyTotp,
}));
vi.mock('@/lib/sso', () => ({ SSO_TICKET_COOKIE: 'df_sso_ticket' }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: mocks.withTenantDb,
  // Only the provider's read of the consumed intent's createdAt reaches here.
  withPlatformDb: async (run: (db: unknown) => unknown) =>
    run({
      pendingLoginIntent: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const intent = mocks.intents.get(where.id);
          return intent ? { createdAt: intent.createdAt, ip: intent.ip ?? null } : null;
        },
      },
    }),
}));
vi.mock('@/lib/tenancy/host', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tenancy/host')>('@/lib/tenancy/host');
  return { ...actual, resolveOrganizationById: mocks.resolveById };
});
vi.mock('@/lib/auth/shared-login', () => ({ resolveSharedLogin: mocks.resolveSharedLogin }));
// An in-memory intent table, so step 2 only succeeds with an intent step 1
// actually minted — the same single-use, host-bound contract as the real one.
vi.mock('@/lib/auth/login-intent', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/login-intent')>('@/lib/auth/login-intent');
  return {
    ...actual,
    createLoginIntent: async (input: Omit<StoredIntent, 'used' | 'createdAt'>) => {
      const token = `intent-${mocks.intents.size}`.padEnd(43, 'x');
      mocks.intents.set(token, { ...input, used: false, createdAt: new Date() });
      return { token, expiresAt: new Date(Date.now() + 300_000) };
    },
    peekLoginIntent: async (token: string | null, host: string) => {
      const intent = token ? mocks.intents.get(token) : undefined;
      if (!intent || intent.used || intent.host !== host) return null;
      return { email: intent.email, candidates: intent.candidates };
    },
    consumeLoginIntent: async (token: string | null, host: string, organizationId: string) => {
      const intent = token ? mocks.intents.get(token) : undefined;
      if (!intent || intent.used || intent.host !== host) return null;
      const match = intent.candidates.find((entry) => entry.organizationId === organizationId);
      if (!match) return null;
      intent.used = true;
      return { id: token, email: intent.email, ...match };
    },
  };
});

import { clearRateLimit, rateLimit } from '@/lib/rate-limit';
import { POST } from './route';

await import('@/lib/auth');

type Provider = {
  id?: string;
  authorize: (credentials: Record<string, unknown>, request: Request) => Promise<unknown>;
};

function loginIntentProvider(): Provider {
  const providers = (mocks.config as unknown as { providers: Provider[] }).providers;
  return providers.find((provider) => provider.id === 'login-intent')!;
}

const ORIGINAL_BASE_DOMAIN = process.env.PLATFORM_BASE_DOMAIN;

const organization = {
  id: 'org_chai_chowk',
  slug: 'chai-chowk',
  displayName: 'Chai Chowk',
  status: 'ACTIVE',
  isDemo: false,
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
    organizationRole: { key: 'owner' },
    twoFactorEnabledAt: null,
    twoFactorSecret: null,
    ...overrides,
  };
}

/** Step 1: the shared-host credential check. */
function credentialCheck(password: string, email = EMAIL) {
  return POST(
    new Request(`https://${HOST}/api/login`, {
      method: 'POST',
      headers: {
        host: HOST,
        origin: `https://${HOST}`,
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ email, password }),
    })
  );
}

/** Step 2: workspace selection. Returns the resolved value, or the thrown error. */
async function selectWorkspace(step1: Response, totp?: string) {
  const token = /df_login_intent=([^;]*)/.exec(step1.headers.get('set-cookie') ?? '')?.[1];
  try {
    return await loginIntentProvider().authorize(
      { organizationId: organization.id, totp },
      new Request(`https://${HOST}/api/auth/callback/login-intent`, {
        headers: { host: HOST, cookie: `df_login_intent=${token ?? ''}` },
      })
    );
  } catch (error) {
    return error;
  }
}

/** Both steps, and both must succeed. */
async function signIn() {
  const step1 = await credentialCheck(PASSWORD);
  expect(step1.status).toBe(200);
  expect(await selectWorkspace(step1)).toMatchObject({ id: 'user_alex', email: EMAIL });
}

/** Both steps for one member of staff, and both must succeed. */
async function signInAs(email: string) {
  const step1 = await credentialCheck(PASSWORD, email);
  expect(step1.status, `${email} credential check`).toBe(200);
  expect(await selectWorkspace(step1)).toMatchObject({ id: userIdFor(email), email });
}

async function expectWrongPassword(email = EMAIL) {
  const response = await credentialCheck('wrong-password', email);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual(UNIFORM_FAILURE);
}

function userIdFor(email: string) {
  return email === EMAIL ? 'user_alex' : `user_${email.split('@')[0]}`;
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.PLATFORM_BASE_DOMAIN = 'devfathom.com';
  mocks.intents.clear();
  // The limiter is real and module-scoped: reset only the keys this flow uses.
  mocks.ip = IP;
  for (const key of [
    `login:ip:${OTHER_IP}`,
    `login:intent:${OTHER_IP}`,
    `login:select:${OTHER_IP}`,
    `login:intent-account:${OTHER_IP}:${EMAIL}`,
    IP_KEY,
    ACCOUNT_KEY,
    INTENT_KEY,
    SELECT_KEY,
    ...STAFF.map((email) => `login:acct:${email}`),
    ...INTENT_ACCOUNT_KEYS,
  ])
    await clearRateLimit(key);

  mocks.resolveSharedLogin.mockImplementation(async (input: { email: string; password: string }) =>
    input.password === PASSWORD
      ? {
          outcome: 'eligible',
          email: input.email,
          organizations: [
            {
              organizationId: organization.id,
              userId: userIdFor(input.email),
              slug: organization.slug,
              displayName: organization.displayName,
              ssoEnforced: false,
            },
          ],
        }
      : { outcome: 'failed' }
  );
  mocks.verifyTotp.mockReturnValue(false);
  mocks.resolveById.mockResolvedValue(organization);
  mocks.findUniqueUser.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id === 'user_alex') return tenantUser();
    const staff = STAFF.find((email) => userIdFor(email) === where.id);
    return staff ? tenantUser({ id: where.id, email: staff, name: staff }) : null;
  });
  mocks.withTenantDb.mockImplementation(
    async (_organizationId: string, run: (db: unknown) => unknown) =>
      run({
        user: { findUnique: mocks.findUniqueUser, update: vi.fn().mockResolvedValue({}) },
        organizationIdentityConnection: { findFirst: vi.fn().mockResolvedValue(null) },
        twoFactorRecoveryCode: {
          findFirst: vi.fn().mockResolvedValue(null),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      })
  );
});

afterEach(() => {
  process.env.PLATFORM_BASE_DOMAIN = ORIGINAL_BASE_DOMAIN;
});

describe('shared-host login rate limiting', () => {
  it('clears both failure budgets once a sign-in is fully verified', async () => {
    // One unit short of the account limit, then a success that must reset it.
    for (let i = 0; i < ACCOUNT_LIMIT - 1; i += 1) await expectWrongPassword();
    await signIn();

    // Without the reset this run would be throttled from its 2nd attempt on.
    for (let i = 0; i < ACCOUNT_LIMIT - 1; i += 1) await expectWrongPassword();
  });

  it('never locks out a run of successful sign-ins', async () => {
    // `login:ip` is shared with the per-host form, so spend all but one unit of
    // it the way failures there would. An uncleared ip bucket then trips on the
    // 2nd sign-in, and an uncleared account bucket on the 11th.
    for (let i = 0; i < IP_LIMIT - 1; i += 1) {
      expect((await rateLimit(IP_KEY, IP_LIMIT, WINDOW_MS)).ok).toBe(true);
    }

    for (let i = 0; i < ACCOUNT_LIMIT + 5; i += 1) await signIn();

    expect(mocks.resolveSharedLogin).toHaveBeenCalledTimes(ACCOUNT_LIMIT + 5);
  });

  it('still spends the account budget on every failure, and throttles at the limit', async () => {
    for (let i = 0; i < ACCOUNT_LIMIT - 1; i += 1) await expectWrongPassword();
    const lastUnit = await credentialCheck('wrong-password');
    expect(lastUnit.status).toBe(401);
    const wrongPasswordBody = await lastUnit.text();

    const throttled = await credentialCheck('wrong-password');

    expect(throttled.status).toBe(429);
    // A throttled attempt is byte-identical to a wrong password in its body.
    expect(await throttled.text()).toBe(wrongPasswordBody);
    // Throttling happens ahead of discovery and its bcrypt compares.
    expect(mocks.resolveSharedLogin).toHaveBeenCalledTimes(ACCOUNT_LIMIT);
    // And the correct password is refused too while the window is open, so the
    // limiter is not a bypass in either direction.
    const correct = await credentialCheck(PASSWORD);
    expect(correct.status).toBe(429);
    expect(await correct.text()).toBe(wrongPasswordBody);
    expect(correct.headers.get('set-cookie')).toBeNull();
  });

  it('does not clear the budget when the password is right but the second factor is wrong', async () => {
    mocks.findUniqueUser.mockResolvedValue(
      tenantUser({ twoFactorEnabledAt: new Date(), twoFactorSecret: 'totp-secret' })
    );

    // A correct password alone must not refund the attempt: otherwise whoever
    // already holds the password gets an unlimited budget for grinding codes.
    for (let i = 0; i < ACCOUNT_LIMIT; i += 1) {
      const step1 = await credentialCheck(PASSWORD);
      expect(step1.status).toBe(200);
      expect(await selectWorkspace(step1, '000000')).toMatchObject({ code: '2fa_invalid' });
    }

    const throttled = await credentialCheck(PASSWORD);
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual(UNIFORM_FAILURE);
  });

  it('attributes the reset to workspace selection, not to a correct password', async () => {
    // Non-vacuity: the cases above pass only because step 2 clears the budget.
    // A correct password that never completes selection spends it like any
    // other attempt.
    for (let i = 0; i < ACCOUNT_LIMIT; i += 1) {
      expect((await credentialCheck(PASSWORD)).status).toBe(200);
    }

    expect((await credentialCheck(PASSWORD)).status).toBe(429);
  });
});

/**
 * DEV-932 — a pharmacy's staff share one internet connection, so they share one
 * address. Successful sign-ins of different people from it must not use up a
 * shared allowance, while every limit on FAILED attempts stays as strict.
 */
describe('shared-host login from one shared address', () => {
  it('lets more staff sign in from one address than any per-address limit allows', async () => {
    expect(STAFF.length).toBeGreaterThan(Math.max(INTENT_LIMIT, SELECT_LIMIT, IP_LIMIT));

    for (const email of STAFF) await signInAs(email);

    expect(mocks.resolveSharedLogin).toHaveBeenCalledTimes(STAFF.length);
  });

  it('still refuses the attempt after 20 failed guesses from the address, across accounts', async () => {
    // Password spraying: two guesses each at ten accounts stays under every
    // per-account limit, so only the per-address budget can stop it.
    for (let i = 0; i < INTENT_LIMIT; i += 1) await expectWrongPassword(STAFF[i % 10]);

    const sprayed = await credentialCheck('wrong-password', STAFF[10]);
    expect(sprayed.status).toBe(429);
    expect(await sprayed.json()).toEqual(UNIFORM_FAILURE);
    // Throttled ahead of discovery and its bcrypt compares.
    expect(mocks.resolveSharedLogin).toHaveBeenCalledTimes(INTENT_LIMIT);
    // And a correct password is refused too while the window is open.
    expect((await credentialCheck(PASSWORD, STAFF[11])).status).toBe(429);
  });

  it('does not let an own working account wipe the failed guesses from the address', async () => {
    // A success refunds only its own unit. Were it to clear the bucket, an
    // attacker with one real account could spray without limit by signing in
    // between batches of guesses.
    for (let i = 0; i < INTENT_LIMIT - 1; i += 1) await expectWrongPassword(STAFF[i % 10]);
    for (let i = 0; i < 5; i += 1) await signIn();

    await expectWrongPassword(STAFF[10]);
    expect((await credentialCheck('wrong-password', STAFF[11])).status).toBe(429);
  });

  it('keeps counting staff failures alongside staff successes', async () => {
    for (let i = 0; i < INTENT_LIMIT - 1; i += 1) {
      await expectWrongPassword(STAFF[i % 10]);
      await signInAs(STAFF[20 + (i % 20)]!);
    }

    await expectWrongPassword(STAFF[10]);
    expect((await credentialCheck('wrong-password', STAFF[11])).status).toBe(429);
  });

  it('still caps how many intents one credential can mint from one address', async () => {
    // Each of these completes, so each refunds the per-address budget — the
    // per-address-and-account budget is what keeps one valid credential from
    // filling the intent table.
    for (let i = 0; i < INTENT_LIMIT; i += 1) await signInAs(STAFF[0]!);

    const throttled = await credentialCheck(PASSWORD, STAFF[0]);
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toEqual(UNIFORM_FAILURE);
    expect(throttled.headers.get('set-cookie')).toBeNull();
    // A colleague at the same address is unaffected.
    await signInAs(STAFF[1]!);
  });

  it('still counts failed workspace selections from the address', async () => {
    mocks.findUniqueUser.mockResolvedValue(
      tenantUser({ twoFactorEnabledAt: new Date(), twoFactorSecret: 'totp-secret' })
    );
    const step1 = await credentialCheck(PASSWORD);
    expect(step1.status).toBe(200);

    for (let i = 0; i < SELECT_LIMIT; i += 1) {
      expect(await selectWorkspace(step1, '000000')).toMatchObject({ code: '2fa_invalid' });
    }

    // Over the limit the provider refuses before it even reads the intent.
    mocks.verifyTotp.mockReturnValue(true);
    expect(await selectWorkspace(step1, '123456')).toBeNull();
    expect(mocks.verifyTotp).toHaveBeenCalledTimes(SELECT_LIMIT);
  });

  it('refunds only the address the attempt was spent at', async () => {
    // The password is proven from another address, the workspace chosen from
    // this one: this address never spent a unit, so it must not get one back —
    // otherwise sign-ins started elsewhere would buy extra guesses here.
    for (let i = 0; i < INTENT_LIMIT - 1; i += 1) await expectWrongPassword(STAFF[i % 10]);
    mocks.ip = OTHER_IP;
    const step1 = await credentialCheck(PASSWORD);
    expect(step1.status).toBe(200);
    mocks.ip = IP;
    expect(await selectWorkspace(step1)).toMatchObject({ id: 'user_alex', email: EMAIL });

    await expectWrongPassword(STAFF[10]);
    expect((await credentialCheck('wrong-password', STAFF[11])).status).toBe(429);
  });
});
