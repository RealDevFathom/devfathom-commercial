import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  platformOccurrence: vi.fn(),
  tenantOccurrence: vi.fn(),
  participantByUser: vi.fn(),
  participantByToken: vi.fn(),
  canAccessMeeting: vi.fn(),
  toJwt: vi.fn(() => Promise.resolve('signed-livekit-token')),
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
vi.mock('livekit-server-sdk', () => ({
  AccessToken: class {
    addGrant() {}
    toJwt = mocks.toJwt;
  },
}));

import { admitToMeeting, hashGuestToken } from './admission';

const publicId = '7e3c19c6-79a4-4db1-a436-68efbf00f309';
const now = new Date('2026-08-27T10:00:00Z');
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

describe('meeting admission isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_LIVEKIT_URL', 'wss://meet.example.test');
    vi.stubEnv('LIVEKIT_API_KEY', 'test-key');
    vi.stubEnv('LIVEKIT_API_SECRET', 'test-secret');
    mocks.platformOccurrence.mockResolvedValue({ organizationId: 'org_a' });
    mocks.tenantOccurrence.mockResolvedValue(occurrence);
    mocks.participantByUser.mockResolvedValue(null);
    mocks.participantByToken.mockResolvedValue(null);
    mocks.canAccessMeeting.mockResolvedValue(false);
  });

  it('admits a valid occurrence-scoped guest without exposing the room name', async () => {
    mocks.participantByToken.mockResolvedValue({
      id: 'guest_1',
      occurrenceId: 'occ_1',
      displayName: 'Guest',
      roleOverride: 'OBSERVER',
      guestTokenExpiresAt: new Date('2026-08-27T10:30:00Z'),
      guestTokenRevokedAt: null,
      removedAt: null,
      lobbyStatus: 'ADMITTED',
    });
    const result = await admitToMeeting({ publicId, guestToken: 'guest-secret', now });
    expect(result).toMatchObject({
      token: 'signed-livekit-token',
      title: 'Private planning',
      role: 'OBSERVER',
    });
    expect(JSON.stringify(result)).not.toContain('mtg_randomroom');
    expect(mocks.participantByToken).toHaveBeenCalledWith(
      expect.objectContaining({ where: { guestTokenHash: hashGuestToken('guest-secret') } })
    );
  });

  it('rejects a valid guest credential scoped to another occurrence', async () => {
    mocks.participantByToken.mockResolvedValue({
      id: 'guest_2',
      occurrenceId: 'occ_other',
      displayName: 'Guest',
      roleOverride: null,
      guestTokenExpiresAt: new Date('2026-08-27T10:30:00Z'),
      guestTokenRevokedAt: null,
      removedAt: null,
      lobbyStatus: 'ADMITTED',
    });
    await expect(admitToMeeting({ publicId, guestToken: 'guest-secret', now })).resolves.toBeNull();
  });

  it('does not use a cross-tenant session as meeting authority', async () => {
    await expect(
      admitToMeeting({
        publicId,
        now,
        sessionUser: { id: 'admin_b', organizationId: 'org_b', role: 'ADMIN' },
      })
    ).resolves.toBeNull();
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
      now,
      sessionUser: { id: 'member_1', organizationId: 'org_a', role: 'MEMBER' },
    });
    expect(result).toMatchObject({ token: 'signed-livekit-token', role: 'PRESENTER' });
  });
});
