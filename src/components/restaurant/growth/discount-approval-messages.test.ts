import { describe, expect, it } from 'vitest';

import { DISCOUNT_APPROVAL_MESSAGES } from './discount-approval-messages';

describe('discount approval translations', () => {
  it('provides an Urdu translation for every English key', () => {
    expect(Object.keys(DISCOUNT_APPROVAL_MESSAGES.ur).sort()).toEqual(
      Object.keys(DISCOUNT_APPROVAL_MESSAGES.en).sort()
    );
    expect(Object.keys(DISCOUNT_APPROVAL_MESSAGES.ur.statuses).sort()).toEqual(
      Object.keys(DISCOUNT_APPROVAL_MESSAGES.en.statuses).sort()
    );
  });
});
