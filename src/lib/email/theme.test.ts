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
});
