import { describe, expect, it } from 'vitest';
import { assertValidMeetingTimeRange } from './meetings';

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
