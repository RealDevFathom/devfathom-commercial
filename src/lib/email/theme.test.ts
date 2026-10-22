import { afterEach, describe, expect, it, vi } from 'vitest';

import { appUrl } from './theme';

afterEach(() => vi.unstubAllEnvs());

describe('appUrl', () => {
  it('requires HTTPS for a public production URL', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://staging.example.com');

    expect(() => appUrl()).toThrow('must use HTTPS in staging and production');
  });

  it('allows an HTTPS production URL and strips its trailing slash', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://staging.example.com/');

    expect(appUrl()).toBe('https://staging.example.com');
  });

  it('keeps loopback HTTP available for local production-build checks', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://127.0.0.1:4319');

    expect(appUrl()).toBe('http://127.0.0.1:4319');
  });
});
