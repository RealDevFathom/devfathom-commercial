import { describe, expect, it } from 'vitest';

import {
  createMeetingInput,
  meetingUpdateEndsAfterStart,
  updateMeetingInput,
} from '@/lib/meetings/validation';

const input = (startTime: Date, endTime: Date) => ({
  title: 'Planning',
  startTime,
  endTime,
  recurrence: null,
  attendeeIds: [],
});

describe('meeting create time range', () => {
  const startTime = new Date('2026-10-22T09:00:00.000Z');

  it('accepts an end time after the start time', () => {
    expect(
      createMeetingInput.safeParse(input(startTime, new Date('2026-10-22T09:30:00.000Z'))).success
    ).toBe(true);
  });

  it.each([
    ['equal to', '2026-10-22T09:00:00.000Z'],
    ['before', '2026-10-22T08:59:00.000Z'],
  ])('rejects an end time %s the start time', (_relationship, endTime) => {
    const result = createMeetingInput.safeParse(input(startTime, new Date(endTime)));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['endTime'],
          message: 'End time must be after start time.',
        })
      );
    }
  });
});

describe('meeting update time range', () => {
  const current = {
    startTime: new Date('2026-10-22T09:00:00.000Z'),
    endTime: new Date('2026-10-22T10:00:00.000Z'),
  };

  it('rejects an invalid range when both endpoints are supplied', () => {
    const result = updateMeetingInput.safeParse({
      id: 'meeting_1',
      startTime: current.startTime,
      endTime: current.startTime,
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ['start only', { startTime: current.endTime }],
    ['end only', { endTime: current.startTime }],
  ])('rejects a %s partial update after merging the persisted endpoint', (_label, update) => {
    // A partial shape necessarily passes input parsing; the mutation must then
    // merge the stored counterpart before it performs any write.
    expect(updateMeetingInput.safeParse({ id: 'meeting_1', ...update }).success).toBe(true);
    expect(meetingUpdateEndsAfterStart(current, update)).toBe(false);
  });

  it('accepts a partial update that leaves a positive duration', () => {
    expect(
      meetingUpdateEndsAfterStart(current, {
        endTime: new Date('2026-10-22T10:30:00.000Z'),
      })
    ).toBe(true);
  });
});
