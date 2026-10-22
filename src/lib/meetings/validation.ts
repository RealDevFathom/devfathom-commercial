import { z } from 'zod';

export const MEETING_TIME_RANGE_ERROR = 'End time must be after start time.';

export function meetingEndsAfterStart(startTime: Date, endTime: Date): boolean {
  return endTime.getTime() > startTime.getTime();
}

export function meetingUpdateEndsAfterStart(
  current: { startTime: Date; endTime: Date },
  update: { startTime?: Date; endTime?: Date }
): boolean {
  return meetingEndsAfterStart(
    update.startTime ?? current.startTime,
    update.endTime ?? current.endTime
  );
}

export const createMeetingInput = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    startTime: z.date(),
    endTime: z.date(),
    location: z.string().optional(),
    recurrence: z.enum(['daily', 'weekly', 'biweekly', 'monthly']).nullable().default(null),
    attendeeIds: z.array(z.string()),
  })
  .strict()
  .refine(({ startTime, endTime }) => meetingEndsAfterStart(startTime, endTime), {
    message: MEETING_TIME_RANGE_ERROR,
    path: ['endTime'],
  });

export const updateMeetingInput = z
  .object({
    id: z.string(),
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    startTime: z.date().optional(),
    endTime: z.date().optional(),
    location: z.string().nullable().optional(),
    recurrence: z.enum(['daily', 'weekly', 'biweekly', 'monthly']).nullable().optional(),
    attendeeIds: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine(({ startTime, endTime }, ctx) => {
    if (startTime && endTime && !meetingEndsAfterStart(startTime, endTime)) {
      ctx.addIssue({ code: 'custom', message: MEETING_TIME_RANGE_ERROR, path: ['endTime'] });
    }
  });
