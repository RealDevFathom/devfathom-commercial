import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ manage: vi.fn(), materialize: vi.fn() }));
vi.mock('../trpc', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC.create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    entitlementIndependentHistoryProcedure: t.procedure,
  };
});
vi.mock('../authz', () => ({ assertMeetingManage: mocks.manage, assertMeetingAccess: vi.fn() }));
vi.mock('@/lib/meetings/materialize', () => ({ materializeMeetingOccurrences: mocks.materialize }));

import { assertValidMeetingTimeRange, meetingsRouter } from './meetings';

describe('meeting time validation', () => {
  const start = new Date('2026-10-26T10:00:00.000Z');

  it('accepts an end time after the start time', () => {
    expect(() =>
      assertValidMeetingTimeRange(start, new Date('2026-10-26T10:01:00.000Z'))
    ).not.toThrow();
  });

  it.each([
    ['equal to', new Date('2026-10-26T10:00:00.000Z')],
    ['before', new Date('2026-10-26T09:59:00.000Z')],
  ])('rejects an end time %s the start time', (_description, end) => {
    expect(() => assertValidMeetingTimeRange(start, end)).toThrowError(
      'End time must be after start time.'
    );
  });
});

describe('meeting update time validation', () => {
  const startTime = new Date('2026-10-31T10:00:00Z');
  const endTime = new Date('2026-10-31T11:00:00Z');
  const db = {
    meeting: { findFirst: vi.fn(), update: vi.fn() },
    meetingAttendee: { deleteMany: vi.fn(), createMany: vi.fn() },
    user: { findMany: vi.fn() },
  };
  const caller = () => meetingsRouter.createCaller({
    db,
    organization: { id: 'org-a' },
    session: { user: { id: 'actor', organizationId: 'org-a' } },
  } as never);

  beforeEach(() => {
    vi.resetAllMocks();
    db.meeting.findFirst.mockResolvedValue({ startTime, endTime });
    db.meeting.update.mockResolvedValue({ id: 'meeting-1', startTime, endTime });
    db.user.findMany.mockResolvedValue([{ id: 'actor' }, { id: 'guest' }]);
  });

  it.each([
    { startTime: endTime },
    { endTime: startTime },
    { startTime: endTime, endTime: startTime },
  ])('rejects invalid merged times before replacing attendees: %j', async (times) => {
    await expect(caller().update({ id: 'meeting-1', ...times, attendeeIds: ['guest'] }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'End time must be after start time.' });
    expect(db.meeting.update).not.toHaveBeenCalled();
    expect(db.meetingAttendee.deleteMany).not.toHaveBeenCalled();
    expect(db.meetingAttendee.createMany).not.toHaveBeenCalled();
  });

  it('maps a concurrent constraint failure to BAD_REQUEST without separate attendee writes', async () => {
    db.meeting.update.mockRejectedValue({
      code: 'P2004',
      meta: { database_error: 'violates check constraint "meetings_endTime_after_startTime_check"' },
    });
    await expect(caller().update({
      id: 'meeting-1', endTime: new Date('2026-10-31T12:00:00Z'), attendeeIds: ['guest'],
    })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'End time must be after start time.' });
    expect(db.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        attendees: { deleteMany: {}, create: [{ userId: 'actor' }, { userId: 'guest' }] },
      }),
    }));
    expect(db.meetingAttendee.deleteMany).not.toHaveBeenCalled();
    expect(db.meetingAttendee.createMany).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it('preserves unrelated errors', async () => {
    db.meeting.update.mockRejectedValue(new Error('Database unavailable'));
    await expect(caller().update({ id: 'meeting-1', title: 'Renamed' }))
      .rejects.toThrow('Database unavailable');
  });

  it('saves valid partial times and keeps the actor in the replacement attendee list', async () => {
    await expect(caller().update({
      id: 'meeting-1', endTime: new Date('2026-10-31T12:00:00Z'), attendeeIds: ['guest', 'guest'],
    })).resolves.toMatchObject({ id: 'meeting-1' });
    expect(db.meeting.update).toHaveBeenCalledWith({
      where: { id: 'meeting-1' },
      data: {
        endTime: new Date('2026-10-31T12:00:00Z'),
        attendees: { deleteMany: {}, create: [{ userId: 'actor' }, { userId: 'guest' }] },
      },
    });
    expect(mocks.materialize).toHaveBeenCalledWith(db, 'meeting-1');
  });
});
