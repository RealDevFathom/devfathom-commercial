/**
 * The assistant's meeting writes apply the shared time-order rule
 * (DEV-249 / #451).
 *
 * `updateMeeting` is the case that matters: "move the standup to 3pm" carries
 * only a start, so the tool has to judge it against the STORED end, and it has
 * to refuse before it touches the attendee list or the meeting row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(() => 'https://example.test'), templates: {} }));
vi.mock('@/lib/meetings/materialize', () => ({ materializeMeetingOccurrences: vi.fn() }));
vi.mock('@/lib/authz', () => ({
  canManageMeeting: vi.fn(async () => true),
  canAccessMeeting: vi.fn(async () => true),
}));

import { buildMeetingsTools } from './meetings';
import { MEETING_TIME_ORDER_MESSAGE } from '@/lib/meetings/time-order';
import type { AssistantHelpers } from '@/lib/ai/context';

const MEETING_ID = 'meeting_1';
const TEN = '2026-11-09T10:00:00.000Z';
const ELEVEN = '2026-11-09T11:00:00.000Z';

const db = {
  user: { findUnique: vi.fn() },
  meeting: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  meetingAttendee: { deleteMany: vi.fn(), createMany: vi.fn() },
};

type Execute = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

function tools() {
  const built = buildMeetingsTools({
    db,
    isAdmin: false,
    ctx: { userId: 'user_1', role: 'EMPLOYEE', name: 'Owner' },
    now: () => new Date('2026-11-02T09:00:00.000Z'),
    resolveNamed: vi.fn((_title: string, rows: Array<{ id: string; name: string }>) => ({
      kind: 'found',
      value: rows[0],
      interpreted: false,
    })),
    resolvePerson: vi.fn(async (name: string) => ({
      kind: 'found',
      value: { id: `user_${name}`, name },
    })),
    notifyUsers: vi.fn(),
    audit: vi.fn(),
  } as unknown as AssistantHelpers);
  return {
    createMeeting: (built.createMeeting as unknown as { execute: Execute }).execute,
    updateMeeting: (built.updateMeeting as unknown as { execute: Execute }).execute,
  };
}

describe('assistant meeting tools — time order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.user.findUnique.mockResolvedValue({ id: 'user_1' });
    db.meeting.findMany.mockResolvedValue([{ id: MEETING_ID, title: 'Standup' }]);
    db.meeting.findUnique.mockResolvedValue({
      startTime: new Date(TEN),
      endTime: new Date(ELEVEN),
    });
    db.meeting.create.mockResolvedValue({ id: MEETING_ID });
    db.meeting.update.mockResolvedValue({
      title: 'Standup',
      startTime: new Date(TEN),
      endTime: new Date(ELEVEN),
      location: null,
      recurrence: null,
    });
  });

  it.each([
    ['equal to', TEN],
    ['before', '2026-11-09T09:00:00.000Z'],
  ])('createMeeting refuses an end %s the start', async (_label, endTime) => {
    await expect(
      tools().createMeeting({ title: 'Standup', startTime: TEN, endTime })
    ).resolves.toEqual({ error: MEETING_TIME_ORDER_MESSAGE });
    expect(db.meeting.create).not.toHaveBeenCalled();
  });

  it('updateMeeting refuses a start-only move that reaches the stored end, writing nothing', async () => {
    await expect(
      tools().updateMeeting({ meeting: 'Standup', startTime: ELEVEN, attendees: ['Sam'] })
    ).resolves.toEqual({ error: MEETING_TIME_ORDER_MESSAGE });

    expect(db.meeting.findUnique).toHaveBeenCalledWith({
      where: { id: MEETING_ID },
      select: { startTime: true, endTime: true },
    });
    expect(db.meetingAttendee.deleteMany).not.toHaveBeenCalled();
    expect(db.meetingAttendee.createMany).not.toHaveBeenCalled();
    expect(db.meeting.update).not.toHaveBeenCalled();
  });

  it('updateMeeting refuses an end-only move that reaches the stored start', async () => {
    await expect(
      tools().updateMeeting({ meeting: 'Standup', endTime: '2026-11-09T09:30:00.000Z' })
    ).resolves.toEqual({ error: MEETING_TIME_ORDER_MESSAGE });
    expect(db.meeting.update).not.toHaveBeenCalled();
  });

  it('updateMeeting refuses both times out of order without reading the stored ones', async () => {
    await expect(
      tools().updateMeeting({ meeting: 'Standup', startTime: ELEVEN, endTime: TEN })
    ).resolves.toEqual({ error: MEETING_TIME_ORDER_MESSAGE });
    expect(db.meeting.findUnique).not.toHaveBeenCalled();
    expect(db.meeting.update).not.toHaveBeenCalled();
  });

  it('updateMeeting applies a start-only move that keeps the range in order', async () => {
    await expect(
      tools().updateMeeting({ meeting: 'Standup', startTime: '2026-11-09T09:30:00.000Z' })
    ).resolves.toMatchObject({ updated: true });
    expect(db.meeting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MEETING_ID },
        data: { startTime: new Date('2026-11-09T09:30:00.000Z') },
      })
    );
  });
});
