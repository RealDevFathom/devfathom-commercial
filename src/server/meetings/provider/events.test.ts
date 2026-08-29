import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platformDb: {} as Record<string, unknown>,
  tenantDb: {} as Record<string, unknown>,
  withPlatformDb: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.withPlatformDb,
  withTenantDb: mocks.withTenantDb,
}));

import { recordAndApplyProviderEvent, resolveProviderRoom } from './events';
import type { NormalizedMeetingEvent } from './types';

const occurrence = { id: 'occ-1', organizationId: 'org-1' };
const joined: NormalizedMeetingEvent = {
  id: 'evt-join',
  type: 'participant.joined',
  providerType: 'participant_joined',
  roomName: 'mtg_random',
  participantId: 'PA-1',
  participantIdentity: 'grant-1',
  occurredAt: new Date('2026-08-28T04:00:00Z'),
  payload: { safe: true },
};

describe('provider event ingestion', () => {
  const createMany = vi.fn();
  const update = vi.fn();
  const executeRaw = vi.fn();
  const findFirst = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.platformDb, {
      meetingOccurrence: { findUnique: vi.fn(async () => occurrence) },
    });
    Object.assign(mocks.tenantDb, {
      meetingProviderEvent: { createMany, update },
      meetingOccurrenceParticipant: { findFirst },
      meetingParticipantSession: { updateMany: vi.fn() },
      $executeRaw: executeRaw,
    });
    mocks.withPlatformDb.mockImplementation(async (run) => run(mocks.platformDb));
    mocks.withTenantDb.mockImplementation(async (_organizationId, run) => run(mocks.tenantDb));
    createMany.mockResolvedValue({ count: 1 });
    update.mockResolvedValue({});
    executeRaw.mockResolvedValue(1);
    findFirst.mockResolvedValue({ id: 'grant-1', userId: 'user-1' });
  });

  it('resolves the opaque provider room only in platform scope', async () => {
    await expect(resolveProviderRoom('mtg_random')).resolves.toEqual(occurrence);
    expect(mocks.platformDb.meetingOccurrence).toMatchObject({ findUnique: expect.any(Function) });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('records and applies a participant event atomically in tenant scope', async () => {
    await expect(recordAndApplyProviderEvent(occurrence, joined)).resolves.toBe('processed');
    expect(mocks.withTenantDb).toHaveBeenCalledWith('org-1', expect.any(Function));
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { processedAt: expect.any(Date) } })
    );
  });

  it('makes a replay a no-op before any attendance or processed-state write', async () => {
    createMany.mockResolvedValue({ count: 0 });
    await expect(recordAndApplyProviderEvent(occurrence, joined)).resolves.toBe('duplicate');
    expect(findFirst).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('uses convergent SQL for a leave arriving before or after its join', async () => {
    await recordAndApplyProviderEvent(occurrence, {
      ...joined,
      id: 'evt-left',
      type: 'participant.left',
      providerType: 'participant_left',
    });
    const statement = executeRaw.mock.calls[0][0];
    expect(statement.strings.join('')).toContain('ON CONFLICT');
    expect(statement.strings.join('')).toContain('GREATEST');
  });

  it('rolls back instead of marking an event processed when applying its effect fails', async () => {
    executeRaw.mockRejectedValue(new Error('database write failed'));
    await expect(recordAndApplyProviderEvent(occurrence, joined)).rejects.toThrow(
      'database write failed'
    );
    expect(update).not.toHaveBeenCalled();
  });
});
