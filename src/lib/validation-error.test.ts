import { describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';
import { formatValidationError } from './validation-error';

describe('formatValidationError', () => {
  it('returns a readable field name and message', () => {
    const result = z
      .object({
        key: z
          .string()
          .regex(
            /^[a-z0-9._-]+$/,
            'Use lowercase letters, numbers, dots, underscores, and hyphens only.'
          ),
      })
      .safeParse({ key: 'PM' });

    if (result.success) throw new Error('Expected validation to fail.');

    expect(formatValidationError(result.error)).toEqual({
      message: 'Key: Use lowercase letters, numbers, dots, underscores, and hyphens only.',
      fields: {
        key: ['Use lowercase letters, numbers, dots, underscores, and hyphens only.'],
      },
    });
  });

  it('ignores non-validation errors', () => {
    expect(formatValidationError(new Error('Unavailable'))).toBeNull();
  });

  // A whole-object refinement lands on path [], so `flatten().fieldErrors` is
  // empty and there is no field to label. The message still has to survive.
  it('falls back to the first issue when no single field carries the error', () => {
    const result = z
      .object({ start: z.string(), end: z.string() })
      .refine((value) => value.start <= value.end, 'End must come after start.')
      .safeParse({ start: 'b', end: 'a' });

    if (result.success) throw new Error('Expected validation to fail.');

    expect(formatValidationError(result.error)).toEqual({
      message: 'End must come after start.',
      fields: {},
    });
  });

  it('falls back to a generic message when the error carries no issues at all', () => {
    expect(formatValidationError(new ZodError([]))).toEqual({
      message: 'Check the highlighted fields.',
      fields: {},
    });
  });
});
