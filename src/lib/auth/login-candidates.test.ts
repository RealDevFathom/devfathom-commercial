/**
 * D6 — the one new cross-tenant read surface in this change.
 *
 * `withPlatformDb` bypasses the users RLS policy, so these tests pin the two
 * properties that make the helper safe to review: the predicates are the
 * normalized email plus the non-demo boundary, and nothing outside the
 * whitelist ever leaves the query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), withPlatformDb: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.withPlatformDb.mockImplementation(
    async (run: (db: unknown) => Promise<unknown>) => run({ user: { findMany: mocks.findMany } })
  ),
}));

import { findLoginCandidates, LOGIN_CANDIDATE_CAP } from './login-candidates';

function row(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `user_${index}`,
    organizationId: `org_${index}`,
    password: `$2b$10$hash${index}`,
    tokenVersion: 3,
    status: 'ACTIVE',
    organization: {
      id: `org_${index}`,
      slug: `org-${index}`,
      displayName: `Org ${index}`,
      status: 'ACTIVE',
    },
    ...overrides,
  };
}

describe('findLoginCandidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withPlatformDb.mockImplementation(async (run: (db: unknown) => Promise<unknown>) =>
      run({ user: { findMany: mocks.findMany } })
    );
    mocks.findMany.mockResolvedValue([]);
  });

  it('opens exactly one privileged transaction', async () => {
    mocks.findMany.mockResolvedValue([row(1)]);

    await findLoginCandidates('alex@company.com');

    expect(mocks.withPlatformDb).toHaveBeenCalledTimes(1);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
  });

  it('filters on the normalized email and excludes demo principals', async () => {
    await findLoginCandidates('alex@company.com');

    const [args] = mocks.findMany.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(args.where).toEqual({
      email: 'alex@company.com',
      organization: { isDemo: false },
    });
    expect(Object.keys(args.where)).toHaveLength(2);
  });

  it('selects only whitelisted fields, never a full user row', async () => {
    await findLoginCandidates('alex@company.com');

    const [args] = mocks.findMany.mock.calls[0] as [{ select: Record<string, unknown> }];
    expect(args.select).toEqual({
      id: true,
      organizationId: true,
      password: true,
      tokenVersion: true,
      status: true,
      organization: { select: { id: true, slug: true, displayName: true, status: true } },
    });
  });

  it('returns only the shaped candidate, dropping anything else', async () => {
    mocks.findMany.mockResolvedValue([
      { ...row(1), twoFactorSecret: 'leak', phone: '+123', avatar: 'a.png' },
    ]);

    const { candidates } = await findLoginCandidates('alex@company.com');

    expect(candidates).toEqual([
      {
        userId: 'user_1',
        organizationId: 'org_1',
        passwordHash: '$2b$10$hash1',
        tokenVersion: 3,
        userStatus: 'ACTIVE',
        organization: {
          id: 'org_1',
          slug: 'org-1',
          displayName: 'Org 1',
          status: 'ACTIVE',
        },
      },
    ]);
    expect(JSON.stringify(candidates)).not.toContain('leak');
    expect(JSON.stringify(candidates)).not.toContain('+123');
  });

  it('carries a null password through for a SSO-only member', async () => {
    mocks.findMany.mockResolvedValue([row(1, { password: null })]);

    const { candidates } = await findLoginCandidates('alex@company.com');

    expect(candidates[0]!.passwordHash).toBeNull();
  });

  it('returns nothing for an empty address without querying', async () => {
    await expect(findLoginCandidates('')).resolves.toEqual({
      candidates: [],
      capExceeded: false,
    });
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
  });

  it(`accepts exactly ${LOGIN_CANDIDATE_CAP} candidates`, async () => {
    mocks.findMany.mockResolvedValue(
      Array.from({ length: LOGIN_CANDIDATE_CAP }, (_, index) => row(index))
    );

    const result = await findLoginCandidates('alex@company.com');

    expect(result.capExceeded).toBe(false);
    expect(result.candidates).toHaveLength(LOGIN_CANDIDATE_CAP);
  });

  it('reports and discards a set beyond the cap', async () => {
    mocks.findMany.mockResolvedValue(
      Array.from({ length: LOGIN_CANDIDATE_CAP + 1 }, (_, index) => row(index))
    );

    const result = await findLoginCandidates('alex@company.com');

    expect(result.capExceeded).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  it('bounds the query itself so an unbounded set is never materialized', async () => {
    await findLoginCandidates('alex@company.com');

    const [args] = mocks.findMany.mock.calls[0] as [{ take: number }];
    expect(args.take).toBe(LOGIN_CANDIDATE_CAP + 1);
  });
});
