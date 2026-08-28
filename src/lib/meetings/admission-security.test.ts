import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  platformOccurrence: vi.fn(),
  tenantOccurrence: vi.fn(),
  participantByUser: vi.fn(),
  participantByToken: vi.fn(),
  canAccessMeeting: vi.fn(),
  toJwt: vi.fn(() => Promise.resolve('signed-livekit-token')),
  grants: [] as unknown[],
  organizationById: vi.fn(),
  organizationByHost: vi.fn(),
  classifyHost: vi.fn(),
}));

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) =>
    run({ meetingOccurrence: { findUnique: mocks.platformOccurrence } }),
  withTenantDb: (_organizationId: string, run: (db: unknown) => unknown) =>
    run({
      meetingOccurrence: { findUnique: mocks.tenantOccurrence },
      meetingOccurrenceParticipant: {
        findUnique: (input: { where: { guestTokenHash?: string } }) =>
          input.where.guestTokenHash
            ? mocks.participantByToken(input)
            : mocks.participantByUser(input),
      },
    }),
}));
vi.mock('@/lib/authz', () => ({ canAccessMeeting: mocks.canAccessMeeting }));
vi.mock('@/lib/tenancy/host', () => ({
  resolveOrganizationById: mocks.organizationById,
  resolveExplicitOrganizationByHost: mocks.organizationByHost,
  isTenantLifecycleAccessible: (status: string) =>
    ['ONBOARDING', 'ACTIVE', 'GRACE'].includes(status),
}));
vi.mock('@/lib/tenancy/host-routing', () => ({ classifyHost: mocks.classifyHost }));
vi.mock('livekit-server-sdk', () => ({
  AccessToken: class {
    addGrant(grant: unknown) {
      mocks.grants.push(grant);
    }
    toJwt = mocks.toJwt;
  },
}));

import { admitToMeeting, hashGuestToken } from './admission';

const publicId = '7e3c19c6-79a4-4db1-a436-68efbf00f309';
const now = new Date('2026-08-27T10:00:00Z');
const sharedHost = 'www.devfathom.com';
const occurrence = {
  id: 'occ_1',
  meetingId: 'meeting_1',
  providerRoomName: 'mtg_randomroom',
  scheduledStart: new Date('2026-08-27T10:00:00Z'),
  scheduledEnd: new Date('2026-08-27T11:00:00Z'),
  joinOpensAt: new Date('2026-08-27T09:55:00Z'),
  joinClosesAt: new Date('2026-08-27T11:15:00Z'),
  status: 'OPEN',
  cancelledAt: null,
  titleOverride: null,
  meeting: { title: 'Private planning', createdById: 'host_1' },
};

const validGuest = {
  id: 'guest_1',
  occurrenceId: 'occ_1',
  displayName: 'Guest',
  roleOverride: null,
  guestTokenExpiresAt: new Date('2026-08-27T10:30:00Z'),
  guestTokenRevokedAt: null,
  removedAt: null,
  lobbyStatus: 'ADMITTED',
};

describe('meeting admission isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.grants.length = 0;
    vi.stubEnv('NEXT_PUBLIC_LIVEKIT_URL', 'wss://meet.example.test');
    vi.stubEnv('LIVEKIT_API_KEY', 'test-key');
    vi.stubEnv('LIVEKIT_API_SECRET', 'test-secret');
    mocks.platformOccurrence.mockResolvedValue({ organizationId: 'org_a' });
    mocks.tenantOccurrence.mockResolvedValue(occurrence);
    mocks.participantByUser.mockResolvedValue(null);
    mocks.participantByToken.mockResolvedValue(null);
    mocks.canAccessMeeting.mockResolvedValue(false);
    mocks.organizationById.mockResolvedValue({ id: 'org_a', status: 'ACTIVE' });
    mocks.classifyHost.mockReturnValue({ kind: 'shared', host: sharedHost });
    mocks.organizationByHost.mockResolvedValue(null);
  });

  it('admits a valid occurrence-scoped guest without exposing the room name', async () => {
    mocks.participantByToken.mockResolvedValue({ ...validGuest, roleOverride: 'OBSERVER' });
    const result = await admitToMeeting({
      publicId,
      host: sharedHost,
      guestToken: 'guest-secret',
      now,
    });
    expect(result).toMatchObject({
      status: 'admitted',
      admission: { token: 'signed-livekit-token', title: 'Private planning', role: 'OBSERVER' },
    });
    expect(JSON.stringify(result)).not.toContain('mtg_randomroom');
    expect(mocks.participantByToken).toHaveBeenCalledWith(
      expect.objectContaining({ where: { guestTokenHash: hashGuestToken('guest-secret') } })
    );
  });

  it('scopes the media grant to the occurrence room and withholds publish from an observer', async () => {
    mocks.participantByToken.mockResolvedValue({ ...validGuest, roleOverride: 'OBSERVER' });
    await admitToMeeting({ publicId, host: sharedHost, guestToken: 'guest-secret', now });
    expect(mocks.grants).toEqual([
      {
        room: 'mtg_randomroom',
        roomJoin: true,
        canPublish: false,
        canPublishData: false,
        canSubscribe: true,
        roomAdmin: false,
      },
    ]);
  });

  it('rejects a valid guest credential scoped to another occurrence', async () => {
    mocks.participantByToken.mockResolvedValue({ ...validGuest, occurrenceId: 'occ_other' });
    await expect(
      admitToMeeting({ publicId, host: sharedHost, guestToken: 'guest-secret', now })
    ).resolves.toEqual({ status: 'refused' });
  });

  it.each([
    ['expired', { guestTokenExpiresAt: new Date('2026-08-27T09:59:00Z') }],
    ['never given an expiry', { guestTokenExpiresAt: null }],
    ['revoked', { guestTokenRevokedAt: new Date('2026-08-27T09:00:00Z') }],
    ['removed from the occurrence', { removedAt: new Date('2026-08-27T09:00:00Z') }],
    ['denied at the lobby', { lobbyStatus: 'DENIED' }],
  ])('refuses a guest credential that is %s', async (_label, override) => {
    mocks.participantByToken.mockResolvedValue({ ...validGuest, ...override });
    await expect(
      admitToMeeting({ publicId, host: sharedHost, guestToken: 'guest-secret', now })
    ).resolves.toEqual({ status: 'refused' });
  });

  it('holds a credential-proven guest in the lobby without minting a token', async () => {
    mocks.participantByToken.mockResolvedValue({ ...validGuest, lobbyStatus: 'WAITING' });
    await expect(
      admitToMeeting({ publicId, host: sharedHost, guestToken: 'guest-secret', now })
    ).resolves.toEqual({ status: 'waiting' });
    expect(mocks.toJwt).not.toHaveBeenCalled();
  });

  it('does not use a cross-tenant session as meeting authority', async () => {
    await expect(
      admitToMeeting({
        publicId,
        host: sharedHost,
        now,
        sessionUser: { id: 'admin_b', organizationId: 'org_b', role: 'ADMIN' },
      })
    ).resolves.toEqual({ status: 'refused' });
    expect(mocks.canAccessMeeting).not.toHaveBeenCalled();
  });

  it('admits an authorized member with an occurrence-scoped role', async () => {
    mocks.canAccessMeeting.mockResolvedValue(true);
    mocks.participantByUser.mockResolvedValue({
      roleOverride: 'PRESENTER',
      removedAt: null,
      lobbyStatus: 'ADMITTED',
    });
    const result = await admitToMeeting({
      publicId,
      host: sharedHost,
      now,
      sessionUser: { id: 'member_1', organizationId: 'org_a', role: 'MEMBER' },
    });
    expect(result).toMatchObject({
      status: 'admitted',
      admission: { token: 'signed-livekit-token', role: 'PRESENTER' },
    });
  });

  /**
   * MEET-004 D7. A mismatch must be refused exactly like an unknown public id —
   * never a redirect, which would confirm the occurrence belongs to some other
   * named organization.
   */
  describe('host cross-check', () => {
    it('refuses a tenant host that names a different organization', async () => {
      mocks.participantByToken.mockResolvedValue(validGuest);
      mocks.classifyHost.mockReturnValue({ kind: 'tenant', host: 'other.devfathom.com' });
      mocks.organizationByHost.mockResolvedValue({ id: 'org_b', status: 'ACTIVE' });
      await expect(
        admitToMeeting({
          publicId,
          host: 'other.devfathom.com',
          guestToken: 'guest-secret',
          now,
        })
      ).resolves.toEqual({ status: 'refused' });
      expect(mocks.tenantOccurrence).not.toHaveBeenCalled();
    });

    it('refuses a tenant host that names no organization at all', async () => {
      mocks.participantByToken.mockResolvedValue(validGuest);
      mocks.classifyHost.mockReturnValue({ kind: 'tenant', host: 'localhost' });
      mocks.organizationByHost.mockResolvedValue(null);
      await expect(
        admitToMeeting({ publicId, host: 'localhost', guestToken: 'guest-secret', now })
      ).resolves.toEqual({ status: 'refused' });
    });

    it('admits on the occurrence own tenant host', async () => {
      mocks.participantByToken.mockResolvedValue(validGuest);
      mocks.classifyHost.mockReturnValue({ kind: 'tenant', host: 'acme.devfathom.com' });
      mocks.organizationByHost.mockResolvedValue({ id: 'org_a', status: 'ACTIVE' });
      await expect(
        admitToMeeting({
          publicId,
          host: 'acme.devfathom.com',
          guestToken: 'guest-secret',
          now,
        })
      ).resolves.toMatchObject({ status: 'admitted' });
    });

    it('uses the strict host resolver, never the permissive one', async () => {
      mocks.participantByToken.mockResolvedValue(validGuest);
      mocks.classifyHost.mockReturnValue({ kind: 'tenant', host: 'acme.devfathom.com' });
      mocks.organizationByHost.mockResolvedValue({ id: 'org_a', status: 'ACTIVE' });
      await admitToMeeting({ publicId, host: 'acme.devfathom.com', guestToken: 'g', now });
      expect(mocks.organizationByHost).toHaveBeenCalledWith('acme.devfathom.com');
    });

    it('refuses the platform control-plane host', async () => {
      mocks.participantByToken.mockResolvedValue(validGuest);
      mocks.classifyHost.mockReturnValue({ kind: 'platform', host: 'admin.devfathom.com' });
      await expect(
        admitToMeeting({
          publicId,
          host: 'admin.devfathom.com',
          guestToken: 'guest-secret',
          now,
        })
      ).resolves.toEqual({ status: 'refused' });
    });
  });

  /**
   * MEET-004 step 4. A workspace that may not serve traffic is unroutable, not
   * a distinct error, so its status stays unobservable without a session.
   */
  describe('workspace lifecycle', () => {
    it.each([['SUSPENDED'], ['CLOSED'], ['PENDING']])(
      'refuses a valid guest when the workspace is %s',
      async (status) => {
        mocks.participantByToken.mockResolvedValue(validGuest);
        mocks.organizationById.mockResolvedValue({ id: 'org_a', status });
        await expect(
          admitToMeeting({ publicId, host: sharedHost, guestToken: 'guest-secret', now })
        ).resolves.toEqual({ status: 'refused' });
        expect(mocks.tenantOccurrence).not.toHaveBeenCalled();
      }
    );

    it('refuses when the resolved organization no longer exists', async () => {
      mocks.participantByToken.mockResolvedValue(validGuest);
      mocks.organizationById.mockResolvedValue(null);
      await expect(
        admitToMeeting({ publicId, host: sharedHost, guestToken: 'guest-secret', now })
      ).resolves.toEqual({ status: 'refused' });
    });
  });

  it('refuses an unknown public id before entering tenant scope', async () => {
    mocks.platformOccurrence.mockResolvedValue(null);
    await expect(
      admitToMeeting({ publicId, host: sharedHost, guestToken: 'guest-secret', now })
    ).resolves.toEqual({ status: 'refused' });
    expect(mocks.organizationById).not.toHaveBeenCalled();
    expect(mocks.tenantOccurrence).not.toHaveBeenCalled();
  });

  it('refuses a malformed public id without any database round trip', async () => {
    await expect(
      admitToMeeting({ publicId: 'not-a-uuid', host: sharedHost, guestToken: 'g', now })
    ).resolves.toEqual({ status: 'refused' });
    expect(mocks.platformOccurrence).not.toHaveBeenCalled();
  });

  it('refuses a bare link holder who presents no credential at all', async () => {
    await expect(admitToMeeting({ publicId, host: sharedHost, now })).resolves.toEqual({
      status: 'refused',
    });
    expect(mocks.toJwt).not.toHaveBeenCalled();
  });
});
