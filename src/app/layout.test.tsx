import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ locale: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: () => (state.locale === undefined ? undefined : { value: state.locale }),
  }),
}));
vi.mock('next/font/local', () => ({ default: () => ({ variable: 'font-fixture' }) }));
vi.mock('@/components/providers', () => ({ Providers: () => null }));
import RootLayout from './layout';

beforeEach(() => {
  state.locale = undefined;
});
describe('server-rendered document locale', () => {
  it.each([
    [undefined, 'en', 'ltr'],
    ['en', 'en', 'ltr'],
    ['ur', 'ur', 'rtl'],
    ['<script>ur</script>', 'en', 'ltr'],
    ['ar', 'en', 'ltr'],
  ])('renders %s with the supported language and direction', async (cookie, lang, dir) => {
    state.locale = cookie;
    const html = await RootLayout({ children: null });
    expect(html.props.lang).toBe(lang);
    expect(html.props.dir).toBe(dir);
  });
});
