import { expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import ur from '@/messages/ur.json';
const state = vi.hoisted(() => ({ locale: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: state.locale }) }),
}));
vi.mock('next-intl/server', () => ({ getRequestConfig: (configure: unknown) => configure }));
import configure from './request';
it.each([
  [undefined, 'en'],
  ['ur', 'ur'],
  ['unsupported', 'en'],
])('resolves request cookie %s to %s', async (cookie, locale) => {
  state.locale = cookie;
  const config = await configure({ requestLocale: Promise.resolve(undefined) });
  expect(config).toEqual({ locale, messages: locale === 'ur' ? ur : en, timeZone: 'Asia/Karachi' });
});
