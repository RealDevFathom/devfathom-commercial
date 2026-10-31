import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appUrl } from './theme';

describe('appUrl', () => {
  let originalAppUrl: string | undefined;
  let originalNextAuthUrl: string | undefined;
  let originalAuthUrl: string | undefined;

  beforeEach(() => {
    originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    originalNextAuthUrl = process.env.NEXTAUTH_URL;
    originalAuthUrl = process.env.AUTH_URL;
    delete process.env.NEXTAUTH_URL;
    delete process.env.AUTH_URL;
  });

  afterEach(() => {
    restoreEnv('NEXT_PUBLIC_APP_URL', originalAppUrl);
    restoreEnv('NEXTAUTH_URL', originalNextAuthUrl);
    restoreEnv('AUTH_URL', originalAuthUrl);
  });

  it.each([
    ['http://lvh.me:3100', 'http://lvh.me:3100'],
    ['http://cafe.lvh.me:3100', 'http://cafe.lvh.me:3100'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://cafe.localhost:3000', 'http://cafe.localhost:3000'],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
  ])('keeps HTTP for the development host %s', (configuredUrl, expected) => {
    process.env.NEXT_PUBLIC_APP_URL = configuredUrl;

    expect(`${appUrl()}/invite/T`).toBe(`${expected}/invite/T`);
  });

  it.each([
    ['http://app.example.com/', 'https://app.example.com'],
    ['http://127.0.0.1.example.com:3000', 'https://127.0.0.1.example.com:3000'],
    ['http://[::2]:3000', 'https://[::2]:3000'],
  ])('upgrades a non-development HTTP URL to HTTPS: %s', (configuredUrl, expected) => {
    process.env.NEXT_PUBLIC_APP_URL = configuredUrl;

    expect(appUrl()).toBe(expected);
  });

  it.each(['javascript:alert(1)', '//evil.example', 'not a URL'])(
    'falls back to the default for an unsafe or invalid URL: %s',
    (configuredUrl) => {
      process.env.NEXT_PUBLIC_APP_URL = configuredUrl;

      expect(appUrl()).toBe('https://dev-fathom-hub.vercel.app');
    }
  );
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
