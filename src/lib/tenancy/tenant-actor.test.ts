import type { Session } from 'next-auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getSupportSession: vi.fn(),
  requireOrganizationForRequest: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/tenancy/host', () => {
  class TenantHostError extends Error {
    constructor(
      message: string,
      readonly status: 404 | 409 | 423
    ) {
      super(message);
    }
  }

  return {
    isTenantLifecycleAccessible: vi.fn(() => true),
    requireOrganizationForRequest: mocks.requireOrganizationForRequest,
    resolveOrganizationByHost: vi.fn(),
    TenantHostError,
    TENANT_HOST_HEADER: 'x-devfathom-host',
  };
});
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/support-session', () => ({
  getSupportSession: mocks.getSupportSession,
}));

import { TenantHostError } from '@/lib/tenancy/host';
import { resolveTenantActor } from './tenant-actor';

function sessionFor(user: Record<string, unknown>): Session {
  return {
    expires: new Date(Date.now() + 60_000).toISOString(),
    user: { id: 'user_1', organizationId: 'org_other', ...user },
  } as Session;
}

// #16: the actor resolver now applies the session verdict, so a fixture without
// a status would be rejected before the host check it is meant to exercise.
const session = sessionFor({ status: 'ACTIVE' });

const request = () => new Request('http://devfathom.localhost:3000/dashboard');

describe('resolveTenantActor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSupportSession.mockResolvedValue(null);
  });

  it('treats a session for another workspace as unauthenticated', async () => {
    mocks.requireOrganizationForRequest.mockRejectedValue(
      new TenantHostError('This session belongs to a different workspace.', 409)
    );

    await expect(resolveTenantActor({ request: request(), session })).resolves.toBeNull();
  });

  it('does not hide unexpected resolution failures', async () => {
    mocks.requireOrganizationForRequest.mockRejectedValue(new Error('Database unavailable'));

    await expect(resolveTenantActor({ request: request(), session })).rejects.toThrow(
      'Database unavailable'
    );
  });

  // #16: no route handler should have to remember the revocation check, so the
  // resolver refuses to produce an actor for a session that is not usable — and
  // it does so BEFORE touching the database.
  it.each([
    ['a revoked session', { status: 'ACTIVE', sessionRevoked: true }],
    ['a legacy REVOKED sentinel', { status: 'REVOKED' }],
    ['a session with no status', {}],
    ['a deactivated account', { status: 'INACTIVE' }],
  ])('refuses to build an actor for %s', async (_label, user) => {
    mocks.requireOrganizationForRequest.mockResolvedValue({ id: 'org_other' });

    await expect(
      resolveTenantActor({ request: request(), session: sessionFor(user) })
    ).resolves.toBeNull();
    expect(mocks.requireOrganizationForRequest).not.toHaveBeenCalled();
  });

  it('still builds an actor for an ON_LEAVE session', async () => {
    mocks.requireOrganizationForRequest.mockResolvedValue({ id: 'org_other' });

    const actor = await resolveTenantActor({
      request: request(),
      session: sessionFor({ status: 'ON_LEAVE' }),
    });
    expect(actor?.organization).toEqual({ id: 'org_other' });
  });
});
