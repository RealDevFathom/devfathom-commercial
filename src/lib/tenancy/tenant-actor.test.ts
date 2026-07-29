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

const session = {
  expires: new Date(Date.now() + 60_000).toISOString(),
  user: { id: 'user_1', organizationId: 'org_other' },
} as Session;

describe('resolveTenantActor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSupportSession.mockResolvedValue(null);
  });

  it('treats a session for another workspace as unauthenticated', async () => {
    mocks.requireOrganizationForRequest.mockRejectedValue(
      new TenantHostError('This session belongs to a different workspace.', 409)
    );

    await expect(
      resolveTenantActor({
        request: new Request('http://devfathom.localhost:3000/dashboard'),
        session,
      })
    ).resolves.toBeNull();
  });

  it('does not hide unexpected resolution failures', async () => {
    mocks.requireOrganizationForRequest.mockRejectedValue(new Error('Database unavailable'));

    await expect(
      resolveTenantActor({
        request: new Request('http://devfathom.localhost:3000/dashboard'),
        session,
      })
    ).rejects.toThrow('Database unavailable');
  });
});
