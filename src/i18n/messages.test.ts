import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import ur from '@/messages/ur.json';

function leaves(value: Record<string, unknown>, prefix = ''): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof child === 'string'
        ? [[path, child]]
        : Object.entries(leaves(child as Record<string, unknown>, path));
    })
  );
}
describe('English and Urdu catalogues', () => {
  it('covers the same messages and formats every ICU message without missing arguments', () => {
    const english = leaves(en),
      urdu = leaves(ur);
    expect(Object.keys(urdu).sort()).toEqual(Object.keys(english).sort());
    for (const [locale, messages] of [
      ['en', en],
      ['ur', ur],
    ] as const) {
      const onError = vi.fn();
      const t = createTranslator({ locale, messages, onError });
      for (const [key, text] of Object.entries(leaves(messages))) {
        expect(text.trim().length, key).toBeGreaterThan(0);
        const args = Object.fromEntries(
          [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)/g)].map((match) => [
            match[1],
            match[1] === 'action' ? 'void' : 2,
          ])
        );
        expect(t(key as Parameters<typeof t>[0], args), `${locale}:${key}`).not.toBe(key);
      }
      expect(onError.mock.calls).toEqual([]);
    }
  });
  it('provides Urdu operator and safety copy rather than English fallbacks', () => {
    const t = createTranslator({ locale: 'ur', messages: ur });
    expect(t('CounterText.pay')).toBe('ادائیگی کریں');
    expect(t('CounterErrors.DAY_CLOSED')).toContain('کاروباری دن');
    expect(
      t('CounterAlerts.value0RequiresAPrescriptionBeforeItCanBeDispensed', {
        value0: 'Synthetic medicine',
      })
    ).toBe('Synthetic medicine دینے سے پہلے نسخہ ضروری ہے۔');
  });
});
