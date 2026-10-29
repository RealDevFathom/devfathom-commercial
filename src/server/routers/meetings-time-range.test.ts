import { beforeEach, describe, expect, it, vi } from 'vitest';

const { assertMeetingManage, findUniqueOrThrow, update } = vi.hoisted(() => ({
  assertMeetingManage: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('../audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('../authz', () => ({
  assertMeetingAccess: vi.fn(),
  assertMeetingManage,
}));
vi.mock('@/lib/meetings/materialize', () => ({ materializeMeetingOccurrences: vi.fn() }));

import { meetingsRouter } from './meetings';

const caller = () =>
  meetingsRouter.createCaller({
    db: { meeting: { findUniqueOrThrow, update } },
    session: { user: { id: 'owner_1', role: 'ADMIN', status: 'ACTIVE' } },
    entitlements: { enabledModules: ['meetings'] },
  } as never);

describe('meetings router time order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertMeetingManage.mockResolvedValue(undefined);
    findUniqueOrThrow.mockResolvedValue({
      startTime: new Date('2026-10-29T10:00:00.000Z'),
      endTime: new Date('2026-10-29T11:00:00.000Z'),
    });
  });

  it('rejects create when the meeting has no positive duration', async () => {
    await expect(
      caller().create({
        title: 'Impossible meeting',
        startTime: new Date('2026-10-29T10:00:00.000Z'),
        endTime: new Date('2026-10-29T10:00:00.000Z'),
        attendeeIds: [],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects a one-sided update using the persisted opposite endpoint', async () => {
    await expect(
      caller().update({ id: 'meeting_1', startTime: new Date('2026-10-29T11:00:00.000Z') })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'The end time must be after the start time.',
    });
    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'meeting_1' },
      select: { startTime: true, endTime: true },
    });
    expect(update).not.toHaveBeenCalled();
  });
});
