export const PROJECT_DATE_RANGE_MESSAGE = 'End date must be on or after start date';

export function isValidProjectDateRange(
  startDate: Date | null | undefined,
  endDate: Date | null | undefined
): boolean {
  return !startDate || !endDate || endDate >= startDate;
}
