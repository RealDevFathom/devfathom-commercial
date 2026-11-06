import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, isAppLocale, localeCookieName } from './config';
import en from '@/messages/en.json';
import ur from '@/messages/ur.json';

export default getRequestConfig(async () => {
  const saved = (await cookies()).get(localeCookieName)?.value;
  const locale = isAppLocale(saved) ? saved : defaultLocale;
  return { locale, messages: locale === 'ur' ? ur : en, timeZone: 'Asia/Karachi' };
});
