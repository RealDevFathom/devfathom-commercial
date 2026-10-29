import { afterEach, describe, expect, it, vi } from 'vitest';

import { appUrl } from './theme';

describe('appUrl', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('rejects schemes that cannot safely form public application links', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'javascript:alert(1)');
    expect(() => appUrl()).toThrow('must use HTTP or HTTPS');
  });

  it('requires HTTPS in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://app.example.test');
    expect(() => appUrl()).toThrow('must use HTTPS in production');
  });

  it('normalizes a valid HTTPS application URL', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test/');
    expect(appUrl()).toBe('https://app.example.test');
  });
});
