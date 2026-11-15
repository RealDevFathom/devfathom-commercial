/**
 * F11 / DEV-833 — OAuth account-linking CSRF. A mailbox connect callback is
 * honored only for the provider, user, tenant and sign-in session that started
 * it, once, and is refused before any code exchange or mailbox write otherwise.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  buildConsentUrl: vi.fn(),
  syncMailbox: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/email/oauth', () => ({
  buildConsentUrl: mocks.buildConsentUrl,
  exchangeCode: mocks.exchangeCode,
  isProviderConfigured: vi.fn(() => true),
}));
vi.mock('@/lib/email/crypto', () => ({
  encryptToken: vi.fn((token: string) => `enc(${token})`),
  isEmailCryptoConfigured: vi.fn(() => true),
}));
vi.mock('@/lib/email/sync', () => ({ syncMailbox: mocks.syncMailbox }));
vi.mock('@/lib/email/adapter', () => ({ adapterForMailbox: vi.fn() }));

import type { TRPCContext } from '../trpc';
import { emailRouter } from './email';

type StateRow = {
  id: string;
  organizationId: string;
  userId: string;
  provider: string;
  stateHash: string;
  sessionBinding: string;
  expiresAt: Date;
  usedAt: Date | null;
};

let states: StateRow[];
let mailboxCreate: ReturnType<typeof vi.fn>;
let mailboxUpdate: ReturnType<typeof vi.fn>;

function fakeDb(organizationId: string) {
  return {
    mailboxOAuthState: {
      create: vi.fn(
        async ({ data }: { data: Omit<StateRow, 'id' | 'usedAt' | 'organizationId'> }) => {
          const row = { id: `st_${states.length + 1}`, organizationId, usedAt: null, ...data };
          states.push(row);
          return row;
        }
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            stateHash: string;
            userId: string;
            provider: string;
            usedAt: null;
            expiresAt: { gt: Date };
          };
        }) =>
          states.find(
            (row) =>
              row.stateHash === where.stateHash &&
              row.userId === where.userId &&
              row.provider === where.provider &&
              row.usedAt === null &&
              row.expiresAt > where.expiresAt.gt
          ) ?? null
      ),
      updateMany: vi.fn(async ({ where }: { where: { id: string; usedAt: null } }) => {
        const row = states.find((entry) => entry.id === where.id && entry.usedAt === null);
        if (!row) return { count: 0 };
        row.usedAt = new Date();
        return { count: 1 };
      }),
    },
    mailbox: {
      findFirst: vi.fn(async () => null),
      create: mailboxCreate,
      update: mailboxUpdate,
    },
  };
}

function caller(user: { id: string; organizationId: string; passwordAuthenticatedAt?: number }) {
  return emailRouter.createCaller({
    db: fakeDb(user.organizationId),
    entitlements: { enabledModules: [] },
    session: {
      expires: 'later',
      user: { role: 'EMPLOYEE', department: 'ENGINEERING', status: 'ACTIVE', ...user },
    },
    organization: { id: user.organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const attacker = { id: 'user_attacker', organizationId: 'org_a', passwordAuthenticatedAt: 1000 };
const victim = { id: 'user_victim', organizationId: 'org_a', passwordAuthenticatedAt: 2000 };

describe('email OAuth connect state (F11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    states = [];
    mailboxCreate = vi.fn(async ({ data }: { data: { emailAddress: string } }) => ({
      id: 'mb_1',
      ...data,
    }));
    mailboxUpdate = vi.fn();
    mocks.buildConsentUrl.mockImplementation(
      (_provider: string, state: string) => `https://provider.example/consent?state=${state}`
    );
    mocks.exchangeCode.mockResolvedValue({
      refreshToken: 'refresh',
      emailAddress: 'owner@mail.example',
    });
    mocks.syncMailbox.mockResolvedValue(undefined);
  });

  it('persists only a hash of the state, bound to the starting user and provider', async () => {
    const { state, url } = await caller(victim).connectStart({ provider: 'GMAIL' });

    expect(url).toContain(state);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ userId: victim.id, provider: 'GMAIL', usedAt: null });
    expect(states[0]!.stateHash).toBe(createHash('sha256').update(state).digest('hex'));
    expect(JSON.stringify(states[0])).not.toContain(state);
    expect(states[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('links the mailbox when the same session completes its own connect, exactly once', async () => {
    const session = caller(victim);
    const { state } = await session.connectStart({ provider: 'GMAIL' });

    await expect(
      session.connectCallback({ provider: 'GMAIL', code: 'code-1', state })
    ).resolves.toEqual({ mailboxId: 'mb_1', emailAddress: 'owner@mail.example' });
    expect(mocks.exchangeCode).toHaveBeenCalledWith('GMAIL', 'code-1');
    expect(mailboxCreate).toHaveBeenCalledTimes(1);
    expect(mailboxCreate.mock.calls[0]![0].data.userId).toBe(victim.id);
    expect(states[0]!.usedAt).toBeInstanceOf(Date);

    // A replay of the same callback is refused before a second exchange.
    await expect(
      session.connectCallback({ provider: 'GMAIL', code: 'code-1', state })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.exchangeCode).toHaveBeenCalledTimes(1);
    expect(mailboxCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses an attacker's callback delivered to another signed-in user, before any write", async () => {
    const { state } = await caller(attacker).connectStart({ provider: 'GMAIL' });

    await expect(
      caller(victim).connectCallback({ provider: 'GMAIL', code: 'attacker-code', state })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mailboxCreate).not.toHaveBeenCalled();
    expect(mailboxUpdate).not.toHaveBeenCalled();
    // The attacker's own state is left untouched.
    expect(states[0]!.usedAt).toBeNull();
  });

  it('refuses a callback delivered to a different sign-in session of the same user', async () => {
    const { state } = await caller(victim).connectStart({ provider: 'OUTLOOK' });

    await expect(
      caller({ ...victim, passwordAuthenticatedAt: 9999 }).connectCallback({
        provider: 'OUTLOOK',
        code: 'code',
        state,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mailboxCreate).not.toHaveBeenCalled();
  });

  it('refuses a callback delivered into another workspace', async () => {
    const { state } = await caller(victim).connectStart({ provider: 'GMAIL' });

    await expect(
      caller({ ...victim, organizationId: 'org_b' }).connectCallback({
        provider: 'GMAIL',
        code: 'code',
        state,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mailboxCreate).not.toHaveBeenCalled();
  });

  it('refuses a state started for a different provider', async () => {
    const { state } = await caller(victim).connectStart({ provider: 'GMAIL' });

    await expect(
      caller(victim).connectCallback({ provider: 'OUTLOOK', code: 'code', state })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses an unknown, missing or expired state', async () => {
    await expect(
      caller(victim).connectCallback({ provider: 'GMAIL', code: 'code', state: 'GMAIL:forged' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller(victim).connectCallback({ provider: 'GMAIL', code: 'code' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const { state } = await caller(victim).connectStart({ provider: 'GMAIL' });
    states[0]!.expiresAt = new Date(Date.now() - 1000);
    await expect(
      caller(victim).connectCallback({ provider: 'GMAIL', code: 'code', state })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mailboxCreate).not.toHaveBeenCalled();
  });
});
