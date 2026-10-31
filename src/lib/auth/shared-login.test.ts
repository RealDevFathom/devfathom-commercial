/**
 * D7 — the password is verified against EVERY candidate before anything about
 * the organizations is revealed, and every failure looks identical.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DUMMY_PASSWORD_HASH } from '@/lib/auth/constants';

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  findLoginCandidates: vi.fn(),
  recordAuthAudit: vi.fn(),
  ssoConnectionFindFirst: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ compare: mocks.compare }));
vi.mock('@/lib/auth/login-candidates', () => ({
  findLoginCandidates: mocks.findLoginCandidates,
  LOGIN_CANDIDATE_CAP: 10,
}));
vi.mock('@/server/audit', () => ({ recordAuthAudit: mocks.recordAuthAudit }));
vi.mock('@/lib/tenancy/host', () => ({
  isTenantLifecycleAccessible: (status: string) =>
    ['ONBOARDING', 'ACTIVE', 'GRACE'].includes(status),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: mocks.withTenantDb.mockImplementation(
    async (_organizationId: string, run: (db: unknown) => Promise<unknown>) =>
      run({
        organizationIdentityConnection: { findFirst: mocks.ssoConnectionFindFirst },
      })
  ),
}));

import { resolveSharedLogin } from './shared-login';

function candidate(overrides: Record<string, unknown> = {}) {
  const index = (overrides.index as number) ?? 1;
  return {
    userId: `user_${index}`,
    organizationId: `org_${index}`,
    passwordHash: `$2b$10$hash${index}`,
    tokenVersion: 3,
    userStatus: 'ACTIVE',
    organization: {
      id: `org_${index}`,
      slug: `org-${index}`,
      displayName: `Org ${index}`,
      status: 'ACTIVE',
    },
    ...overrides,
  };
}

function resolve(password = 'correct') {
  return resolveSharedLogin({
    email: 'alex@company.com',
    password,
    ip: '203.0.113.9',
    userAgent: 'vitest',
  });
}

describe('resolveSharedLogin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ssoConnectionFindFirst.mockResolvedValue(null);
    mocks.withTenantDb.mockImplementation(
      async (_organizationId: string, run: (db: unknown) => Promise<unknown>) =>
        run({ organizationIdentityConnection: { findFirst: mocks.ssoConnectionFindFirst } })
    );
    mocks.findLoginCandidates.mockResolvedValue({ candidates: [], capExceeded: false });
    mocks.compare.mockResolvedValue(false);
  });

  // The timing defence from the per-host provider, preserved exactly.
  it('still performs one bcrypt compare when there are no candidates', async () => {
    await expect(resolve()).resolves.toEqual({ outcome: 'failed' });

    expect(mocks.compare).toHaveBeenCalledTimes(1);
    expect(mocks.compare).toHaveBeenCalledWith('correct', DUMMY_PASSWORD_HASH);
  });

  it('performs one compare per candidate, including SSO-only members', async () => {
    mocks.findLoginCandidates.mockResolvedValue({
      candidates: [
        candidate({ index: 1 }),
        candidate({ index: 2, passwordHash: null }),
        candidate({ index: 3 }),
      ],
      capExceeded: false,
    });

    await resolve();

    expect(mocks.compare).toHaveBeenCalledTimes(3);
    // The password-less member is compared against the dummy hash, so the number
    // of compares depends only on the candidate count.
    expect(mocks.compare).toHaveBeenCalledWith('correct', DUMMY_PASSWORD_HASH);
  });

  it('matches only the organizations whose stored hash the password satisfies', async () => {
    mocks.findLoginCandidates.mockResolvedValue({
      candidates: [candidate({ index: 1 }), candidate({ index: 2 })],
      capExceeded: false,
    });
    // Same address in two organizations with DIFFERENT password hashes.
    mocks.compare.mockImplementation(
      async (_password: string, hash: string) => hash === '$2b$10$hash2'
    );

    const result = await resolve();

    expect(result.outcome).toBe('eligible');
    if (result.outcome !== 'eligible') return;
    expect(result.organizations).toHaveLength(1);
    expect(result.organizations[0]!.organizationId).toBe('org_2');
  });

  it('fails uniformly when the password matches nowhere', async () => {
    mocks.findLoginCandidates.mockResolvedValue({
      candidates: [candidate({ index: 1 }), candidate({ index: 2 })],
      capExceeded: false,
    });
    mocks.compare.mockResolvedValue(false);

    await expect(resolve()).resolves.toEqual({ outcome: 'failed' });
  });

  it('never treats a null stored hash as a match', async () => {
    mocks.findLoginCandidates.mockResolvedValue({
      candidates: [candidate({ index: 1, passwordHash: null })],
      capExceeded: false,
    });
    // Even if bcrypt somehow said yes for the dummy hash, an SSO-only member has
    // no password path.
    mocks.compare.mockResolvedValue(true);

    await expect(resolve()).resolves.toEqual({ outcome: 'failed' });
  });

  it.each([
    ['a deactivated account', { userStatus: 'INACTIVE' }],
    ['a not-yet-onboarded account', { userStatus: 'INVITED' }],
  ])('excludes %s even with the right password', async (_label, overrides) => {
    mocks.findLoginCandidates.mockResolvedValue({
      candidates: [candidate({ index: 1, ...overrides })],
      capExceeded: false,
    });
    mocks.compare.mockResolvedValue(true);

    await expect(resolve()).resolves.toEqual({ outcome: 'failed' });
  });

  it.each([['PROSPECT'], ['SUSPENDED'], ['TERMINATED'], ['PURGING'], ['PURGED']])(
    'excludes an organization in %s',
    async (status) => {
      mocks.findLoginCandidates.mockResolvedValue({
        candidates: [
          candidate({
            index: 1,
            organization: { id: 'org_1', slug: 'o', displayName: 'O', status },
          }),
        ],
        capExceeded: false,
      });
      mocks.compare.mockResolvedValue(true);

      await expect(resolve()).resolves.toEqual({ outcome: 'failed' });
    }
  );

  it.each([['ONBOARDING'], ['ACTIVE'], ['GRACE']])(
    'includes an organization in %s',
    async (status) => {
      mocks.findLoginCandidates.mockResolvedValue({
        candidates: [
          candidate({
            index: 1,
            organization: { id: 'org_1', slug: 'o', displayName: 'O', status },
          }),
        ],
        capExceeded: false,
      });
      mocks.compare.mockResolvedValue(true);

      const result = await resolve();
      expect(result.outcome).toBe('eligible');
    }
  );

  it('keeps ON_LEAVE staff eligible', async () => {
    mocks.findLoginCandidates.mockResolvedValue({
      candidates: [candidate({ index: 1, userStatus: 'ON_LEAVE' })],
      capExceeded: false,
    });
    mocks.compare.mockResolvedValue(true);

    const result = await resolve();
    expect(result.outcome).toBe('eligible');
  });

  it('treats a candidate set beyond the cap as a failed login', async () => {
    mocks.findLoginCandidates.mockResolvedValue({ candidates: [], capExceeded: true });

    await expect(resolve()).resolves.toEqual({ outcome: 'failed' });
    expect(mocks.compare).toHaveBeenCalledTimes(1);
    expect(mocks.recordAuthAudit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Login candidate cap exceeded' })
    );
  });

  // D12
  it('marks an SSO-enforced organization without removing it', async () => {
    mocks.findLoginCandidates.mockResolvedValue({
      candidates: [candidate({ index: 1 }), candidate({ index: 2 })],
      capExceeded: false,
    });
    mocks.compare.mockResolvedValue(true);
    mocks.withTenantDb.mockImplementation(
      async (organizationId: string, run: (db: unknown) => Promise<unknown>) =>
        run({
          organizationIdentityConnection: {
            findFirst: async () => (organizationId === 'org_2' ? { id: 'conn' } : null),
          },
        })
    );

    const result = await resolve();

    expect(result.outcome).toBe('eligible');
    if (result.outcome !== 'eligible') return;
    expect(result.organizations).toHaveLength(2);
    expect(result.organizations.find((o) => o.organizationId === 'org_2')?.ssoEnforced).toBe(true);
    expect(result.organizations.find((o) => o.organizationId === 'org_1')?.ssoEnforced).toBe(false);
  });

  it('fails closed on SSO enforcement when the check itself fails', async () => {
    mocks.findLoginCandidates.mockResolvedValue({
      candidates: [candidate({ index: 1 })],
      capExceeded: false,
    });
    mocks.compare.mockResolvedValue(true);
    mocks.withTenantDb.mockRejectedValue(new Error('database unavailable'));

    const result = await resolve();

    expect(result.outcome).toBe('eligible');
    if (result.outcome !== 'eligible') return;
    // Unproven means enforced: no password path is offered.
    expect(result.organizations[0]!.ssoEnforced).toBe(true);
  });

  // D17
  describe('audit attribution', () => {
    it('keeps a genuinely org-less failure out of tenant ledgers', async () => {
      await resolve();

      expect(mocks.recordAuthAudit).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'No such account' })
      );
      const [entry] = mocks.recordAuthAudit.mock.calls[0] as [Record<string, unknown>];
      expect(entry.organizationId).toBeUndefined();
    });

    it('attributes a wrong password to every candidate organization', async () => {
      mocks.findLoginCandidates.mockResolvedValue({
        candidates: [candidate({ index: 1 }), candidate({ index: 2 })],
        capExceeded: false,
      });
      mocks.compare.mockResolvedValue(false);

      await resolve();

      expect(mocks.recordAuthAudit).toHaveBeenCalledTimes(2);
      const organizationIds = mocks.recordAuthAudit.mock.calls.map(
        ([entry]) => (entry as Record<string, unknown>).organizationId
      );
      expect(organizationIds.sort()).toEqual(['org_1', 'org_2']);
    });

    it('attributes an ineligible match to the matching organization only', async () => {
      mocks.findLoginCandidates.mockResolvedValue({
        candidates: [candidate({ index: 1, userStatus: 'INACTIVE' }), candidate({ index: 2 })],
        capExceeded: false,
      });
      mocks.compare.mockImplementation(
        async (_password: string, hash: string) => hash === '$2b$10$hash1'
      );

      await resolve();

      expect(mocks.recordAuthAudit).toHaveBeenCalledTimes(1);
      expect(mocks.recordAuthAudit).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org_1', reason: 'No eligible organization' })
      );
    });
  });

  it('orders the workspaces by name so the picker is stable', async () => {
    mocks.findLoginCandidates.mockResolvedValue({
      candidates: [
        candidate({
          index: 1,
          organization: { id: 'org_1', slug: 'z', displayName: 'Zephyr', status: 'ACTIVE' },
        }),
        candidate({
          index: 2,
          organization: { id: 'org_2', slug: 'a', displayName: 'Acme', status: 'ACTIVE' },
        }),
      ],
      capExceeded: false,
    });
    mocks.compare.mockResolvedValue(true);

    const result = await resolve();
    if (result.outcome !== 'eligible') throw new Error('expected eligible');
    expect(result.organizations.map((o) => o.displayName)).toEqual(['Acme', 'Zephyr']);
  });
});
