import { describe, expect, it } from 'vitest';

import { createMeetingInput } from '@/lib/meetings/validation';

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
