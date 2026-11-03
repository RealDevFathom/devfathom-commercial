export const locales = ['en', 'ur'] as const;
export type AppLocale = (typeof locales)[number];
export const defaultLocale: AppLocale = 'en';
export const localeCookieName = 'devfathom-locale';

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && locales.includes(value as AppLocale);
}

export function localeDirection(locale: AppLocale): 'ltr' | 'rtl' {
  return locale === 'ur' ? 'rtl' : 'ltr';
}
