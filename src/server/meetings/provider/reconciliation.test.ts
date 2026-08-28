import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  withPlatformDb: vi.fn(),
  withTenantDb: vi.fn(),
  warning: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.withPlatformDb,
  withTenantDb: mocks.withTenantDb,
}));
vi.mock('./events', () => ({ recordAndApplyProviderEvent: mocks.record }));

import { reconcileMeetingOccurrences } from './reconciliation';

const now = new Date('2026-08-28T04:00:00Z');
const occurrence = {
  id: 'occ-1',
  organizationId: 'org-1',
  providerRoomName: 'mtg_random',
  status: 'SCHEDULED',
};

describe('meeting reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withPlatformDb.mockImplementation(async (run) =>
      run({ meetingOccurrence: { findMany: vi.fn(async () => [occurrence]) } })
    );
    mocks.withTenantDb.mockImplementation(async (_organizationId, run) =>
      run({ meetingParticipantSession: { findMany: vi.fn(async () => []) } })
    );
    mocks.record.mockResolvedValue('processed');
  });

  it('repairs missed room-start and participant-join events idempotently', async () => {
    const result = await reconcileMeetingOccurrences(
      {
        getRoomState: vi.fn(async () => ({
          exists: true,
          active: true,
          startedAt: new Date('2026-08-28T03:55:00Z'),
          participants: [
            { id: 'PA-1', identity: 'grant-1', joinedAt: new Date('2026-08-28T03:56:00Z') },
          ],
        })),
      },
      { now }
    );
    expect(result).toEqual({ inspected: 1, repaired: 2 });
    expect(mocks.record.mock.calls.map((call) => call[1].type)).toEqual([
      'room.started',
      'participant.joined',
    ]);
    expect(mocks.warning).toHaveBeenCalledWith(
      'meeting_reconciliation_repaired',
      expect.objectContaining({ occurrenceId: 'occ-1', repairs: 2 })
    );
  });

  it('repairs a missed room finish so open sessions are closed by the common applier', async () => {
    await reconcileMeetingOccurrences(
      {
        getRoomState: vi.fn(async () => ({
          exists: false,
          active: false,
          endedAt: new Date('2026-08-28T03:59:00Z'),
          participants: [],
        })),
      },
      { now }
    );
    expect(mocks.record).toHaveBeenCalledWith(
      occurrence,
      expect.objectContaining({
        type: 'room.finished',
        occurredAt: new Date('2026-08-28T03:59:00Z'),
      })
    );
  });
});
