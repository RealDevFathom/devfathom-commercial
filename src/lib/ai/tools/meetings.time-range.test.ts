import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), templates: {} }));
vi.mock('@/lib/authz', () => ({ canManageMeeting: vi.fn(async () => true) }));
vi.mock('@/lib/meetings/materialize', () => ({ materializeMeetingOccurrences: vi.fn() }));

import { buildMeetingsTools } from './meetings';
import type { AssistantHelpers } from '@/lib/ai/context';
import { canManageMeeting } from '@/lib/authz';
import { materializeMeetingOccurrences } from '@/lib/meetings/materialize';

const update = vi.fn();
const deleteMany = vi.fn();
const createMany = vi.fn();
const queryRaw = vi.fn();
const audit = vi.fn();
const outsideWrite = vi.fn(() => {
  throw new Error('Meeting writes must use the transaction client');
});
const tx = {
  $queryRaw: queryRaw,
  meeting: { update },
  meetingAttendee: { deleteMany, createMany },
};
const transaction = vi.fn(async (run: (inner: typeof tx) => Promise<unknown>) => run(tx));
const meeting = {
  id: 'meeting_1',
  title: 'Planning',
  startTime: new Date('2026-10-29T10:00:00.000Z'),
  endTime: new Date('2026-10-29T11:00:00.000Z'),
};

const tool = () => {
  const tools = buildMeetingsTools({
    db: {
      meeting: { findMany: vi.fn(async () => [meeting]), update: outsideWrite },
      meetingAttendee: { deleteMany: outsideWrite, createMany: outsideWrite },
      $transaction: transaction,
    },
    ctx: { userId: 'owner_1', role: 'ADMIN' },
    isAdmin: true,
    resolveNamed: vi.fn(() => ({ kind: 'resolved', value: meeting })),
    resolvePerson: vi.fn(async () => ({
      kind: 'resolved',
      value: { id: 'guest_1', name: 'Guest' },
    })),
    audit,
  } as unknown as AssistantHelpers);
  return tools.updateMeeting as unknown as {
    execute: (input: Record<string, unknown>) => Promise<{ error?: string }>;
  };
};

describe('assistant updateMeeting time order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryRaw.mockResolvedValue([meeting]);
    update.mockImplementation(async ({ data }) => ({ ...meeting, ...data }));
    vi.mocked(canManageMeeting).mockResolvedValue(true);
    vi.mocked(materializeMeetingOccurrences).mockResolvedValue({
      created: 0,
      cancelled: 0,
      materializedThrough: new Date('2026-11-29T00:00:00.000Z'),
    });
  });

  it('rejects a one-sided partial update using the existing end time', async () => {
    await expect(
      tool().execute({ meeting: 'Planning', startTime: '2026-10-29T11:00:00.000Z' })
    ).resolves.toEqual({ error: 'The end time must be after the start time.' });
    expect(update).not.toHaveBeenCalled();
  });

  it('validates the locked range after a concurrent edit, before replacing attendees', async () => {
    // Resolution saw 10:00–11:00. Another request shortened the meeting while
    // the assistant was resolving attendees; 10:45 is no longer a valid start.
    queryRaw.mockResolvedValueOnce([{ ...meeting, endTime: new Date('2026-10-29T10:30:00.000Z') }]);
    await expect(
      tool().execute({
        meeting: 'Planning',
        startTime: '2026-10-29T10:45:00.000Z',
        attendees: ['Guest'],
      })
    ).resolves.toEqual({ error: 'The end time must be after the start time.' });

    const [sql, id] = queryRaw.mock.calls[0];
    expect(sql.join('?')).toMatch(/FROM meetings\s+WHERE id = \? FOR UPDATE/);
    expect(id).toBe(meeting.id);
    expect(transaction).toHaveBeenCalledOnce();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(outsideWrite).not.toHaveBeenCalled();
  });

  it('accepts a partial update made valid by a concurrent extension', async () => {
    queryRaw.mockResolvedValueOnce([{ ...meeting, endTime: new Date('2026-10-29T12:00:00.000Z') }]);
    await expect(
      tool().execute({ meeting: 'Planning', startTime: '2026-10-29T11:00:00.000Z' })
    ).resolves.toMatchObject({ updated: true });
    expect(update).toHaveBeenCalledOnce();
  });

  it('writes attendees, meeting and occurrences through the same transaction', async () => {
    await expect(
      tool().execute({ meeting: 'Planning', title: 'Updated planning', attendees: ['Guest'] })
    ).resolves.toMatchObject({ updated: true, title: 'Updated planning' });

    expect(deleteMany).toHaveBeenCalledWith({ where: { meetingId: meeting.id } });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { meetingId: meeting.id, userId: 'owner_1' },
        { meetingId: meeting.id, userId: 'guest_1' },
      ],
    });
    expect(materializeMeetingOccurrences).toHaveBeenCalledWith(tx, meeting.id);
    expect(audit).toHaveBeenCalledOnce();
    expect(outsideWrite).not.toHaveBeenCalled();
  });

  it.each(['meeting update', 'occurrence reconciliation'])(
    'propagates %s failure to roll back the attendee replacement',
    async (failureAt) => {
      const failure = new Error('Database write failed');
      if (failureAt === 'meeting update') update.mockRejectedValueOnce(failure);
      else vi.mocked(materializeMeetingOccurrences).mockRejectedValueOnce(failure);

      await expect(
        tool().execute({ meeting: 'Planning', attendees: ['Guest'] })
      ).rejects.toBe(failure);
      await expect(transaction.mock.results[0].value).rejects.toBe(failure);
      expect(deleteMany).toHaveBeenCalledOnce();
      expect(createMany).toHaveBeenCalledOnce();
      expect(audit).not.toHaveBeenCalled();
      expect(outsideWrite).not.toHaveBeenCalled();
    }
  );

  it('does not replace attendees if the meeting was deleted before locking', async () => {
    queryRaw.mockResolvedValueOnce([]);
    await expect(tool().execute({ meeting: 'Planning', attendees: ['Guest'] })).resolves.toEqual({
      error: 'That meeting was not found.',
    });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('checks management permission again inside the locked transaction', async () => {
    vi.mocked(canManageMeeting).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(tool().execute({ meeting: 'Planning', attendees: ['Guest'] })).resolves.toEqual({
      error: 'You can only edit meetings you created (admins can edit any meeting).',
    });
    expect(canManageMeeting).toHaveBeenLastCalledWith(tx, 'owner_1', 'ADMIN', meeting.id);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
