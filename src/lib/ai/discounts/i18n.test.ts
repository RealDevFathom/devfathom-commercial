import { describe, expect, it } from 'vitest';

import {
  DISCOUNT_SCHEDULER_DIRECTION,
  DISCOUNT_SCHEDULER_MESSAGES,
  discountSchedulerMessage,
} from './i18n';

describe('discount scheduler translations', () => {
  it('has a non-empty Urdu value for every English key', () => {
    const englishKeys = Object.keys(DISCOUNT_SCHEDULER_MESSAGES.en).sort();
    const urduKeys = Object.keys(DISCOUNT_SCHEDULER_MESSAGES.ur).sort();

    expect(urduKeys).toEqual(englishKeys);
    for (const key of englishKeys) {
      expect(
        DISCOUNT_SCHEDULER_MESSAGES.ur[
          key as keyof typeof DISCOUNT_SCHEDULER_MESSAGES.ur
        ].trim()
      ).not.toBe('');
    }
  });

  it('marks Urdu as RTL without changing the required product label', () => {
    expect(DISCOUNT_SCHEDULER_DIRECTION).toEqual({ en: 'ltr', ur: 'rtl' });
    expect(discountSchedulerMessage('ur', 'ai.label')).toBe('DevFathom AI');
  });

  it('keeps the Urdu WhatsApp marketing template parameterized and opted out', () => {
    const template = discountSchedulerMessage('ur', 'whatsapp.template');

    expect(template).toMatch(/\{\{1\}\}.*\{\{2\}\}.*\{\{3\}\}.*\{\{4\}\}/);
    expect(template).toContain('STOP');
    expect(template).not.toMatch(/\{\{\d+\}\}\s*\{\{\d+\}\}/);
    expect(template.startsWith('{{')).toBe(false);
    expect(template.endsWith('}}')).toBe(false);
  });
});
