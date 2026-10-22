import { describe, expect, it } from 'vitest';

import { AI_UPSELL_CHECKOUT_STRINGS } from './ai-upsell-checkout-i18n';

describe('AI upsell checkout translations', () => {
  it('defines an Urdu value for every English key', () => {
    const englishKeys = Object.keys(AI_UPSELL_CHECKOUT_STRINGS.en).sort();
    const urduKeys = Object.keys(AI_UPSELL_CHECKOUT_STRINGS.ur).sort();

    expect(urduKeys).toEqual(englishKeys);
    for (const key of englishKeys as Array<keyof typeof AI_UPSELL_CHECKOUT_STRINGS.en>) {
      expect(AI_UPSELL_CHECKOUT_STRINGS.ur[key], `Missing Urdu copy for ${key}`).toBeTruthy();
    }
  });
});

