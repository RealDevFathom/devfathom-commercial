import { describe, expect, it } from 'vitest';

import { REFILL_REMINDER_COPY } from './refill-reminder-copy';

describe('refill reminder translations', () => {
  it('provides an Urdu translation for every English key', () => {
    expect(Object.keys(REFILL_REMINDER_COPY.ur).sort()).toEqual(
      Object.keys(REFILL_REMINDER_COPY.en).sort()
    );

    for (const key of Object.keys(REFILL_REMINDER_COPY.en) as Array<
      keyof typeof REFILL_REMINDER_COPY.en
    >) {
      expect(REFILL_REMINDER_COPY.ur[key].trim(), `missing Urdu copy for ${key}`).not.toBe('');
    }
  });
});
