import { describe, expect, it } from 'vitest';
import { MEETING_TIME_ORDER_MESSAGE, meetingTimeRangeSchema } from './time-range';

describe('meetingTimeRangeSchema', () => {
  const startTime = new Date('2026-10-29T10:00:00.000Z');

  it('accepts an end time after the start time', () => {
    expect(
      meetingTimeRangeSchema.safeParse({
        startTime,
        endTime: new Date('2026-10-29T10:01:00.000Z'),
      }).success
    ).toBe(true);
  });

  it.each([
    ['equal', '2026-10-29T10:00:00.000Z'],
    ['before', '2026-10-29T09:59:00.000Z'],
  ])('rejects an end time %s to the start time', (_case, endTime) => {
    const result = meetingTimeRangeSchema.safeParse({ startTime, endTime: new Date(endTime) });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(MEETING_TIME_ORDER_MESSAGE);
  });
});
