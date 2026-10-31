import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantHelpers } from '@/lib/ai/context';

const mocks = vi.hoisted(() => ({
  canManage: vi.fn(),
  materialize: vi.fn(),
}));
vi.mock('@/lib/authz', () => ({ canManageMeeting: mocks.canManage }));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), templates: {} }));
vi.mock('@/lib/meetings/materialize', () => ({ materializeMeetingOccurrences: mocks.materialize }));

import { buildMeetingsTools } from './meetings';

const start = new Date('2026-10-31T10:00:00Z');
const end = new Date('2026-10-31T11:00:00Z');
const db = {
  meeting: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  meetingAttendee: { deleteMany: vi.fn(), createMany: vi.fn() },
};
const audit = vi.fn();
const resolvePerson = vi.fn();

type UpdateInput = {
  meeting: string;
  title?: string;
  startTime?: string | null;
  endTime?: string | null;
  attendees?: string[];
};

function update(input: Omit<UpdateInput, 'meeting'>) {
  const tools = buildMeetingsTools({
    db,
    ctx: { userId: 'actor', organizationId: 'org-a', role: 'EMPLOYEE' },
    isAdmin: false,
    resolveNamed: () => ({ kind: 'resolved', value: { id: 'meeting-1', name: 'Planning' } }),
    resolvePerson,
    audit,
  } as unknown as AssistantHelpers);
  const tool = tools.updateMeeting as unknown as {
    execute: (input: UpdateInput) => Promise<{ error?: string; updated?: boolean }>;
  };
  return tool.execute({ meeting: 'Planning', ...input });
}

describe('assistant meeting time updates', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.canManage.mockResolvedValue(true);
    db.meeting.findMany.mockResolvedValue([{ id: 'meeting-1', title: 'Planning' }]);
    db.meeting.findFirst.mockResolvedValue({ startTime: start, endTime: end });
    db.meeting.update.mockResolvedValue({ title: 'Planning', startTime: start, endTime: end });
    resolvePerson.mockResolvedValue({ kind: 'resolved', value: { id: 'guest', name: 'Guest' } });
  });

  it.each([
    { startTime: end.toISOString() },
    { startTime: '2026-10-31T12:00:00Z' },
    { endTime: start.toISOString() },
    { endTime: '2026-10-31T09:00:00Z' },
    { startTime: start.toISOString(), endTime: start.toISOString() },
    { startTime: end.toISOString(), endTime: start.toISOString() },
  ])('rejects an invalid merged range before rewriting attendees: %j', async (times) => {
    await expect(update({ ...times, attendees: ['Guest'] })).resolves.toEqual({
      error: 'End time must be after start time.',
    });
    expect(db.meeting.findFirst).toHaveBeenCalledWith({
      where: { id: 'meeting-1', organizationId: 'org-a' },
      select: { startTime: true, endTime: true },
    });
    expect(db.meeting.update).not.toHaveBeenCalled();
    expect(db.meetingAttendee.deleteMany).not.toHaveBeenCalled();
    expect(db.meetingAttendee.createMany).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('writes a valid time edit and attendee replacement atomically, keeping the actor', async () => {
    await expect(update({ endTime: '2026-10-31T12:00:00Z', attendees: ['Guest', 'Guest'] }))
      .resolves.toMatchObject({ updated: true });
    expect(db.meeting.update).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        endTime: new Date('2026-10-31T12:00:00Z'),
        attendees: { deleteMany: {}, create: [{ userId: 'actor' }, { userId: 'guest' }] },
      },
    }));
    expect(db.meetingAttendee.deleteMany).not.toHaveBeenCalled();
    expect(db.meetingAttendee.createMany).not.toHaveBeenCalled();
    expect(mocks.materialize).toHaveBeenCalledWith(db, 'meeting-1');
    expect(audit).toHaveBeenCalledOnce();
  });

  it('returns an error when a concurrent time edit violates the constraint', async () => {
    db.meeting.update.mockRejectedValue({
      code: 'P2004',
      meta: { database_error: 'violates check constraint "meetings_endTime_after_startTime_check"' },
    });
    await expect(update({ endTime: '2026-10-31T12:00:00Z', attendees: ['Guest'] }))
      .resolves.toEqual({ error: 'End time must be after start time.' });
    expect(db.meetingAttendee.deleteMany).not.toHaveBeenCalled();
    expect(db.meetingAttendee.createMany).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('does not swallow unrelated write errors', async () => {
    const error = new Error('Database unavailable');
    db.meeting.update.mockRejectedValue(error);
    await expect(update({ title: 'New title' })).rejects.toBe(error);
  });

  it('authorizes before reading meeting times', async () => {
    mocks.canManage.mockResolvedValue(false);
    await expect(update({ endTime: '2026-10-31T12:00:00Z' })).resolves.toHaveProperty('error');
    expect(db.meeting.findFirst).not.toHaveBeenCalled();
    expect(db.meeting.update).not.toHaveBeenCalled();
  });
});
