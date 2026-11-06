export const PROJECT_DATE_ORDER_MESSAGE = 'End date must be on or after the start date.';

export function projectDatesAreOrdered(
  startDate: Date | string | null | undefined,
  endDate: Date | string | null | undefined
): boolean {
  if (startDate == null || endDate == null) return true;
  return new Date(endDate).getTime() >= new Date(startDate).getTime();
}
