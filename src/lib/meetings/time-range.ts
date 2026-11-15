/** Shared by every meeting write surface after parsing its datetimes. */
export const MEETING_TIME_ORDER_ERROR = 'The end time must be after the start time.';

export function isMeetingTimeRangeValid(startTime: Date, endTime: Date): boolean {
  return endTime.getTime() > startTime.getTime();
}
