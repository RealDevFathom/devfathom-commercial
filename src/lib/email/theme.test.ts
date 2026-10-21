import { afterEach, describe, expect, it, vi } from 'vitest';

import { appUrl } from './theme';

describe('appUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['http://localhost:3100', 'http://localhost:3100'],
    ['http://lvh.me:3100', 'http://lvh.me:3100'],
    ['http://cafe.lvh.me:3100', 'http://cafe.lvh.me:3100'],
    ['http://127.0.0.1:3100', 'http://127.0.0.1:3100'],
    ['http://acme.localhost:3100', 'https://acme.localhost:3100'],
    ['http://app.example.com', 'https://app.example.com'],
    ['https://app.example.com', 'https://app.example.com'],
  ])('builds links for %s with the appropriate protocol', (configuredUrl, expectedUrl) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', configuredUrl);

    expect(appUrl()).toBe(expectedUrl);
  });

  it.each(['localhost', '127.0.0.1', 'cafe.lvh.me'])(
    'forces https for the development host %s in production',
    (hostname) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NEXT_PUBLIC_APP_URL', `http://${hostname}:3100`);

      expect(appUrl()).toBe(`https://${hostname}:3100`);
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
