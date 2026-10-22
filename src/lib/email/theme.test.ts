import { afterEach, describe, expect, it, vi } from 'vitest';

import { appUrl } from './theme';

const APP_URL_ENV = ['NEXT_PUBLIC_APP_URL', 'NEXTAUTH_URL', 'AUTH_URL'] as const;

afterEach(() => vi.unstubAllEnvs());

describe('appUrl', () => {
  it('accepts HTTP and HTTPS application URLs and removes the trailing slash', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test/');
    expect(appUrl()).toBe('https://app.example.test');

    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000/');
    expect(appUrl()).toBe('http://localhost:3000');
  });

  it.each(['javascript:alert(1)', 'data:text/html,unsafe', 'ftp://files.example.test'])(
    'rejects the non-HTTP application URL %s',
    (configuredUrl) => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', configuredUrl);

      expect(() => appUrl()).toThrow('The application URL must use HTTP or HTTPS');
    }
  );

  it('fails closed instead of falling back when the highest-priority URL is invalid', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'not a URL');
    vi.stubEnv('NEXTAUTH_URL', 'https://fallback.example.test');

    expect(() => appUrl()).toThrow();
  });

  it('uses the existing production fallback when no URL is configured', () => {
    for (const name of APP_URL_ENV) vi.stubEnv(name, undefined);

    expect(appUrl()).toBe('https://dev-fathom-hub.vercel.app');
  });
});
