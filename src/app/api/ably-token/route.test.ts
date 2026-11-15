// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.ABLY_API_KEY = 'app.key:test-secret-not-real';
  return {
    resolveTenantActor: vi.fn(),
    createTokenRequest: vi.fn(),
    withTenantDb: vi.fn(),
    findMany: vi.fn(),
  };
});

vi.mock('ably', () => ({
  Rest: class {
    auth = { createTokenRequest: mocks.createTokenRequest };
  },
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
vi.mock('@/lib/auth/session-state', () => ({ responseForPasswordChange: () => null }));

import { GET } from './route';
import { presenceRoom } from '@/lib/chat/contract';

type Capability = Record<string, string[]>;

/**
 * Ably capability matching: a resource key grants an operation on a channel when
 * it equals the channel name, is `*`, or ends in `:*` / `*` and prefixes it.
 */
function grants(capability: Capability, channel: string, operation: string): boolean {
  return Object.entries(capability).some(([resource, ops]) => {
    const matches =
      resource === channel ||
      resource === '*' ||
      (resource.endsWith('*') && channel.startsWith(resource.slice(0, -1)));
    return matches && (ops.includes(operation) || ops.includes('*'));
  });
}

function actorFor(userId: string, organizationId: string) {
  return {
    session: { user: { id: userId, organizationId } },
    organization: { id: organizationId },
    support: null,
  };
}

async function issueCapability(userId: string, organizationId: string): Promise<Capability> {
  mocks.resolveTenantActor.mockResolvedValueOnce(actorFor(userId, organizationId));
  mocks.createTokenRequest.mockClear();
  const response = await GET(new Request(`https://${organizationId}.example.test/api/ably-token`));
  expect(response.status).toBe(200);
  expect(mocks.createTokenRequest).toHaveBeenCalledTimes(1);
  const [params] = mocks.createTokenRequest.mock.calls[0];
  expect(params.clientId).toBe(userId);
  return JSON.parse(params.capability) as Capability;
}

describe('GET /api/ably-token presence scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTokenRequest.mockResolvedValue({ keyName: 'app.key', mac: 'x' });
    mocks.findMany.mockResolvedValue([{ channelId: 'chan-a' }]);
    mocks.withTenantDb.mockImplementation(
      (_orgId: string, fn: (db: unknown) => unknown) =>
        fn({ channelMember: { findMany: mocks.findMany } })
    );
  });

  it('derives the presence room from the verified organization', () => {
    expect(presenceRoom('org-a')).toBe('presence:org:org-a');
    expect(presenceRoom('org-a')).not.toBe(presenceRoom('org-b'));
  });

  it('grants presence only on the caller tenant roster', async () => {
    const capability = await issueCapability('user-a', 'org-a');

    expect(capability[presenceRoom('org-a')]).toEqual(['subscribe', 'presence']);
    expect(grants(capability, presenceRoom('org-a'), 'subscribe')).toBe(true);
    expect(grants(capability, presenceRoom('org-a'), 'presence')).toBe(true);
    // Membership-scoped rooms keep working.
    expect(grants(capability, 'channel:chan-a', 'subscribe')).toBe(true);
    expect(grants(capability, 'typing:chan-a', 'publish')).toBe(true);
    expect(mocks.withTenantDb).toHaveBeenCalledWith('org-a', expect.any(Function));
  });

  it('two tenants on one Ably app cannot attach to or enumerate each other’s roster', async () => {
    const capabilityA = await issueCapability('user-a', 'org-a');
    const capabilityB = await issueCapability('user-b', 'org-b');

    for (const op of ['subscribe', 'presence', 'publish', 'history']) {
      expect(grants(capabilityA, presenceRoom('org-b'), op)).toBe(false);
      expect(grants(capabilityB, presenceRoom('org-a'), op)).toBe(false);
    }
    // No shared, constant presence room and no wildcard resource in either token.
    for (const capability of [capabilityA, capabilityB]) {
      expect(grants(capability, 'presence:global', 'subscribe')).toBe(false);
      expect(grants(capability, 'presence:global', 'presence')).toBe(false);
      expect(Object.keys(capability).some((resource) => resource.includes('*'))).toBe(false);
      const presenceKeys = Object.keys(capability).filter((key) => key.startsWith('presence:'));
      expect(presenceKeys).toHaveLength(1);
    }
  });

  it('issues no token when the caller is not an authenticated tenant actor', async () => {
    mocks.resolveTenantActor.mockResolvedValueOnce(null);
    const response = await GET(new Request('https://org-a.example.test/api/ably-token'));
    expect(response.status).toBe(401);
    expect(mocks.createTokenRequest).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
