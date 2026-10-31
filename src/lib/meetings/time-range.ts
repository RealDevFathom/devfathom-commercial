export const INVALID_MEETING_TIME_MESSAGE = 'End time must be after start time.';

export function isValidMeetingTimeRange(startTime: Date, endTime: Date): boolean {
  return endTime.getTime() > startTime.getTime();
}

/** Match only this constraint, including Prisma's pg adapter error wrappers. */
export function isMeetingTimeConstraintError(error: unknown, seen = new Set<unknown>()): boolean {
  if (typeof error === 'string') {
    return error.includes('meetings_endTime_after_startTime_check');
  }
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const record = error as Record<string, unknown>;
  return [
    'message',
    'originalMessage',
    'constraint',
    'index',
    'cause',
    'originalError',
    'driverError',
    'driverAdapterError',
    'meta',
    'database_error',
  ].some((key) => isMeetingTimeConstraintError(record[key], seen));
}
