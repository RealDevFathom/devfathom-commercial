import { z } from 'zod';
import { isValidProjectDateRange, PROJECT_DATE_RANGE_MESSAGE } from '@/lib/project-dates';

export const createProjectSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    type: z.enum(['CLIENT', 'INTERNAL']),
    status: z.enum(['ACTIVE', 'IN_DEVELOPMENT', 'ON_HOLD', 'COMPLETED']).default('ACTIVE'),
    clientId: z.string().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    techStack: z.array(z.string()).default([]),
    memberIds: z.array(z.string()).default([]),
  })
  .refine(
    ({ startDate, endDate }) =>
      isValidProjectDateRange(
        startDate ? new Date(startDate) : undefined,
        endDate ? new Date(endDate) : undefined
      ),
    { message: PROJECT_DATE_RANGE_MESSAGE, path: ['endDate'] }
  );
