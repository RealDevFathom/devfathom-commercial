export const PROJECT_DATE_RANGE_MESSAGE = 'End date must be on or after start date';

export function isValidProjectDateRange(
  startDate: Date | null | undefined,
  endDate: Date | null | undefined
): boolean {
  return !startDate || !endDate || endDate >= startDate;
}

export const PROJECT_DATE_RANGE_CONSTRAINT = 'projects_date_range_check';

/**
 * True when a write was refused by the `projects_date_range_check` CHECK
 * constraint (e.g. two concurrent valid partial updates combining into an
 * invalid range). Walks the Prisma/driver error chain for the constraint name.
 */
export function isProjectDateRangeViolation(error: unknown, seen = new Set<unknown>()): boolean {
  if (typeof error === 'string') return error.includes(PROJECT_DATE_RANGE_CONSTRAINT);
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const record = error as Record<string, unknown>;
  return [
    'message',
    'constraint',
    'cause',
    'originalError',
    'driverError',
    'driverAdapterError',
    'meta',
    'database_error',
  ].some((key) => isProjectDateRangeViolation(record[key], seen));
}
