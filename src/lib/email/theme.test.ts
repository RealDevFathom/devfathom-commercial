import { afterEach, describe, expect, it, vi } from 'vitest';

import { appUrl } from './theme';

describe('appUrl', () => {
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

      expect(appUrl()).toBe(configuredUrl);
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
