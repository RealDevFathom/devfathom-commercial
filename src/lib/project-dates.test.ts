import { describe, expect, it } from 'vitest';
import { createProjectSchema } from '@/app/api/v1/projects/schema';

describe('REST project date ranges', () => {
  it('rejects an end date before the start date', () => {
    const result = createProjectSchema.safeParse({
      name: 'Invalid dates',
      type: 'INTERNAL',
      startDate: '2026-10-22T00:00:00.000Z',
      endDate: '2026-10-21T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['endDate'],
        message: 'End date must be on or after start date',
      })
    );
  });

  it('accepts equal dates and either omitted bound', () => {
    expect(
      createProjectSchema.safeParse({
        name: 'One day',
        type: 'INTERNAL',
        startDate: '2026-10-22T00:00:00.000Z',
        endDate: '2026-10-22T00:00:00.000Z',
      }).success
    ).toBe(true);
    expect(createProjectSchema.safeParse({ name: 'No schedule', type: 'INTERNAL' }).success).toBe(
      true
    );
    expect(
      createProjectSchema.safeParse({
        name: 'Start only',
        type: 'INTERNAL',
        startDate: '2026-10-22T00:00:00.000Z',
      }).success
    ).toBe(true);
    expect(
      createProjectSchema.safeParse({
        name: 'End only',
        type: 'INTERNAL',
        endDate: '2026-10-22T00:00:00.000Z',
      }).success
    ).toBe(true);
  });
});
