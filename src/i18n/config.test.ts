import { describe, expect, it } from 'vitest';
import { defaultLocale, isAppLocale, localeDirection } from './config';

describe('application locales', () => {
  it('keeps English as the default and enables Urdu RTL', () => {
    expect(defaultLocale).toBe('en');
    expect(localeDirection('en')).toBe('ltr');
    expect(localeDirection('ur')).toBe('rtl');
  });

  it('rejects unsupported persisted locale values', () => {
    expect(isAppLocale('en')).toBe(true);
    expect(isAppLocale('ur')).toBe(true);
    expect(isAppLocale('ar')).toBe(false);
  });
});
