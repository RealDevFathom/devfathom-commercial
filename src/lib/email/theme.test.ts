import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('appUrl protocol hardening', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['http://localhost:3100', 'http://localhost:3100'],
    ['http://lvh.me:3100', 'http://lvh.me:3100'],
    ['http://acme.localhost:3100', 'http://acme.localhost:3100'],
    ['http://app.example.com', 'https://app.example.com'],
    ['https://app.example.com', 'https://app.example.com'],
  ])('builds links for %s with the appropriate protocol', (configuredUrl, expectedUrl) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', configuredUrl);

    expect(appUrl()).toBe(expectedUrl);
  });

  it.each([
    ['HTTP://app.example.com', 'https://app.example.com'],
    ['hTtP://APP.example.com/base', 'https://app.example.com/base'],
    [' HTTP://app.example.com/base ', 'https://app.example.com/base'],
    ['ht\ttp://app.example.com/base', 'https://app.example.com/base'],
    [
      'HTTP://app.example.com:8080/base?next=reset#token',
      'https://app.example.com:8080/base?next=reset#token',
    ],
    [
      'HTTP://app.example.com/a%2Fb?next=http://other.example.com',
      'https://app.example.com/a%2Fb?next=http://other.example.com',
    ],
    ['HTTP://localhost.evil.example.com', 'https://localhost.evil.example.com'],
    ['HTTP://lvh.me.evil.example.com', 'https://lvh.me.evil.example.com'],
  ])(
    'CTO-P2 normalizes external HTTP based on the parsed protocol: %s',
    (configuredUrl, expectedUrl) => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', configuredUrl);

      expect(appUrl()).toBe(expectedUrl);
      expect(new URL(appUrl()).protocol).toBe('https:');
    }
  );

  it.each(['HTTP://localhost:3100', 'hTtP://lvh.me:3100', 'HTTP://acme.localhost:3100'])(
    'CTO-P2 retains the explicit local-development HTTP exception: %s',
    (configuredUrl) => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', configuredUrl);

      // The parsed URL is serialized, so only the scheme/host case is normalized.
      expect(appUrl()).toBe(configuredUrl.toLowerCase());
      expect(new URL(appUrl()).protocol).toBe('http:');
    }
  );

  it.each(['NEXTAUTH_URL', 'AUTH_URL'] as const)(
    'CTO-P2 applies the same secure normalization to the %s fallback',
    (variable) => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
      vi.stubEnv('NEXTAUTH_URL', undefined);
      vi.stubEnv('AUTH_URL', undefined);
      vi.stubEnv(variable, 'HTTP://app.example.com/base');

      expect(appUrl()).toBe('https://app.example.com/base');
    }
  );

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['file:///etc/passwd'],
    ['ftp://example.com'],
    ['mailto:attacker@example.com'],
    ['//evil.example.com'],
    ['not a url'],
    [''],
  ])('fails closed to the default for non-http(s) or unparseable value %p', (configuredUrl) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', configuredUrl);

    expect(appUrl()).toBe('https://dev-fathom-hub.vercel.app');
  });
});
