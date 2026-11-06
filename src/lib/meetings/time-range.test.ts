import { describe, expect, it } from 'vitest';
import { isMeetingTimeConstraintError } from './time-range';

const constraint = 'meetings_endTime_after_startTime_check';

describe('meeting time constraint errors', () => {
  it.each([
    { code: '23514', constraint },
    { code: 'P2004', meta: { database_error: `violates check constraint "${constraint}"` } },
    { meta: { driverAdapterError: { cause: {
      originalCode: '23514', originalMessage: `violates check constraint "${constraint}"`,
    } } } },
  ])('recognizes the named constraint in database and Prisma errors', (error) => {
    expect(isMeetingTimeConstraintError(error)).toBe(true);
  });

  it('leaves unrelated database failures alone and handles cyclic causes', () => {
    const error = { code: 'P2004', message: 'violates check constraint "another_check"', cause: {} };
    error.cause = error;
    expect(isMeetingTimeConstraintError(error)).toBe(false);
    expect(isMeetingTimeConstraintError(null)).toBe(false);
  });
});
