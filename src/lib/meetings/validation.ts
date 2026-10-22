import { z } from 'zod';

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
  .refine(({ startTime, endTime }) => endTime > startTime, {
    message: 'End time must be after start time.',
    path: ['endTime'],
  });
