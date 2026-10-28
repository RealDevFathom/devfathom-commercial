/**
 * D8 — the pending shared-host login. Copies the df_sso_ticket pattern: hash at
 * rest, short TTL, single use via a conditional update, plus a host binding and
 * a server-computed candidate set that a submitted organization id must belong
 * to. These tests drive the real logic against an in-memory row store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: string;
  tokenHash: string;
  email: string;
  host: string;
  candidates: unknown;
  expiresAt: Date;
  usedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
};

const rows: Row[] = [];

function matches(row: Row, where: Record<string, unknown>): boolean {
  if ('id' in where && row.id !== where.id) return false;
  if ('tokenHash' in where && row.tokenHash !== where.tokenHash) return false;
  if ('usedAt' in where && where.usedAt === null && row.usedAt !== null) return false;
  const expires = where.expiresAt as { gt?: Date } | undefined;
  if (expires?.gt && !(row.expiresAt > expires.gt)) return false;
  return true;
}

const store = {
  pendingLoginIntent: {
    create: vi.fn(async ({ data }: { data: Omit<Row, 'id' | 'usedAt'> }) => {
      const row: Row = { id: `intent_${rows.length + 1}`, usedAt: null, ...data };
      rows.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return rows.find((row) => matches(row, where)) ?? null;
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: { usedAt: Date } }) => {
        const affected = rows.filter((row) => matches(row, where));
        for (const row of affected) row.usedAt = data.usedAt;
        return { count: affected.length };
      }
    ),
  },
};

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(store)),
}));

import {
  consumeLoginIntent,
  createLoginIntent,
  discardLoginIntent,
  LOGIN_INTENT_TTL_MS,
  loginIntentCookieOptions,
  peekLoginIntent,
} from './login-intent';

const HOST = 'www.devfathom.com';
const CANDIDATES = [
  { organizationId: 'org_a', userId: 'user_a', tokenVersion: 7 },
  { organizationId: 'org_b', userId: 'user_b', tokenVersion: 9 },
];

async function mint(host = HOST) {
  return createLoginIntent({ email: 'alex@company.com', host, candidates: CANDIDATES });
}

describe('login intent', () => {
  beforeEach(() => {
    rows.length = 0;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('stores only the hash of the token, never the token', async () => {
    const { token } = await mint();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it('mints a high-entropy single-use token', async () => {
    const first = await mint();
    const second = await mint();

    expect(first.token).not.toBe(second.token);
    expect(first.token.length).toBeGreaterThanOrEqual(43);
  });

  it('expires five minutes after creation', async () => {
    const before = Date.now();
    const { expiresAt } = await mint();

    expect(expiresAt.getTime() - before).toBeGreaterThan(LOGIN_INTENT_TTL_MS - 2_000);
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(LOGIN_INTENT_TTL_MS + 2_000);
  });

  it('is unreadable once expired', async () => {
    const { token } = await mint();
    rows[0]!.expiresAt = new Date(Date.now() - 1);

    await expect(peekLoginIntent(token, HOST)).resolves.toBeNull();
    await expect(consumeLoginIntent(token, HOST, 'org_a')).resolves.toBeNull();
  });

  it('reads back the candidate set without consuming it', async () => {
    const { token } = await mint();

    await expect(peekLoginIntent(token, HOST)).resolves.toEqual({
      email: 'alex@company.com',
      candidates: CANDIDATES,
    });
    expect(rows[0]!.usedAt).toBeNull();
  });

  it('preserves server-owned demo expiry metadata for the Auth.js exchange', async () => {
    const expiresAt = Date.now() + 60_000;
    const { token } = await createLoginIntent({
      email: 'manager.seat1@demo.devfathom.invalid',
      host: HOST,
      candidates: [
        {
          organizationId: 'org_demo_restaurant_seat_1',
          userId: 'user_demo_restaurant_seat_1_manager',
          demoAccessExpiresAt: expiresAt,
        },
      ],
    });

    await expect(peekLoginIntent(token, HOST)).resolves.toEqual({
      email: 'manager.seat1@demo.devfathom.invalid',
      candidates: [
        {
          organizationId: 'org_demo_restaurant_seat_1',
          userId: 'user_demo_restaurant_seat_1_manager',
          demoAccessExpiresAt: expiresAt,
        },
      ],
    });
  });

  it('consumes exactly once and rejects the replay', async () => {
    const { token } = await mint();

    await expect(consumeLoginIntent(token, HOST, 'org_a')).resolves.toMatchObject({
      email: 'alex@company.com',
      organizationId: 'org_a',
      userId: 'user_a',
    });
    // Replay, including for a different organization in the same set.
    await expect(consumeLoginIntent(token, HOST, 'org_a')).resolves.toBeNull();
    await expect(consumeLoginIntent(token, HOST, 'org_b')).resolves.toBeNull();
    await expect(peekLoginIntent(token, HOST)).resolves.toBeNull();
  });

  it('refuses consumption on a different host', async () => {
    const { token } = await mint('www.devfathom.com');

    await expect(consumeLoginIntent(token, 'acme.devfathom.com', 'org_a')).resolves.toBeNull();
    await expect(consumeLoginIntent(token, 'admin.devfathom.com', 'org_a')).resolves.toBeNull();
    await expect(peekLoginIntent(token, 'acme.devfathom.com')).resolves.toBeNull();
    // Still usable on the host it was minted on — the rejection burned nothing.
    await expect(consumeLoginIntent(token, HOST, 'org_a')).resolves.not.toBeNull();
  });

  it.each([
    ['an organization the user does not belong to', 'org_forged'],
    ['an empty organization id', ''],
    ['a plausible-looking but absent id', 'org_c'],
  ])('refuses %s', async (_label, organizationId) => {
    const { token } = await mint();

    await expect(consumeLoginIntent(token, HOST, organizationId)).resolves.toBeNull();
    // A forged id must not burn a valid intent.
    expect(rows[0]!.usedAt).toBeNull();
    await expect(consumeLoginIntent(token, HOST, 'org_b')).resolves.toMatchObject({
      organizationId: 'org_b',
      userId: 'user_b',
    });
  });

  it.each([[null], [undefined], [''], ['short'], ['x'.repeat(200)]])(
    'refuses the malformed token %j',
    async (token) => {
      await mint();

      await expect(consumeLoginIntent(token, HOST, 'org_a')).resolves.toBeNull();
      await expect(peekLoginIntent(token, HOST)).resolves.toBeNull();
    }
  );

  it('refuses a token that was never minted', async () => {
    await mint();
    const forged = 'f'.repeat(43);

    await expect(consumeLoginIntent(forged, HOST, 'org_a')).resolves.toBeNull();
  });

  it('discards an intent so it can never be consumed', async () => {
    const { token } = await mint();

    await discardLoginIntent(token);

    await expect(consumeLoginIntent(token, HOST, 'org_a')).resolves.toBeNull();
  });

  it('ignores a stored candidate entry that is not a well-formed pair', async () => {
    const { token } = await mint();
    // Defence in depth: the column is JSON, so the reader never trusts its shape.
    rows[0]!.candidates = [
      { organizationId: 'org_a' }, // no userId
      { userId: 'user_b' }, // no organizationId
      'org_c',
      null,
      { organizationId: 'org_e', userId: 'user_e', demoAccessExpiresAt: 'tomorrow' },
      { organizationId: 'org_d', userId: 'user_d' },
    ];

    const peeked = await peekLoginIntent(token, HOST);
    expect(peeked?.candidates).toEqual([
      { organizationId: 'org_e', userId: 'user_e' },
      { organizationId: 'org_d', userId: 'user_d' },
    ]);
    // A half-formed entry is not selectable.
    await expect(consumeLoginIntent(token, HOST, 'org_a')).resolves.toBeNull();
    await expect(consumeLoginIntent(token, HOST, 'org_d')).resolves.toMatchObject({
      organizationId: 'org_d',
      userId: 'user_d',
    });
  });

  it('sets a host-only cookie with no domain attribute', () => {
    const options = loginIntentCookieOptions(new Date(Date.now() + LOGIN_INTENT_TTL_MS));

    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect(options).not.toHaveProperty('domain');
  });
});
