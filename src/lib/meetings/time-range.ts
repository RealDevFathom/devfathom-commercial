import { z } from 'zod';

export const MEETING_TIME_ORDER_MESSAGE = 'The end time must be after the start time.';

/** The invariant shared by every meeting write surface. */
export function isValidMeetingTimeRange(startTime: Date, endTime: Date): boolean {
  return endTime.getTime() > startTime.getTime();
}

export const meetingTimeRangeSchema = z
  .object({ startTime: z.date(), endTime: z.date() })
  .refine(({ startTime, endTime }) => isValidMeetingTimeRange(startTime, endTime), {
    message: MEETING_TIME_ORDER_MESSAGE,
    path: ['endTime'],
  });
