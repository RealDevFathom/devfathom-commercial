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

  it.each(['localhost', 'www.localhost', '127.0.0.1', '[::1]'])(
    'allows production builds on HTTP loopback host %s',
    (hostname) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NEXT_PUBLIC_APP_URL', `http://${hostname}:4331/`);
      expect(appUrl()).toBe(`http://${hostname}:4331`);
    }
  );

  it('supports the pharmacy lane AUTH_URL in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined);
    vi.stubEnv('NEXTAUTH_URL', undefined);
    vi.stubEnv('AUTH_URL', 'http://www.localhost:4331');
    expect(appUrl()).toBe('http://www.localhost:4331');
  });

  it.each([
    'localhost.example.test',
    'www.localhost.example.test',
    '127.0.0.1.example.test',
    'localhost@public.example.test',
    '192.168.1.10',
  ])('still requires production HTTPS for non-loopback host %s', (hostname) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', `http://${hostname}:4331`);
    expect(() => appUrl()).toThrow('must use HTTPS in production');
  });

  it('normalizes a valid HTTPS application URL', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test/');
    expect(appUrl()).toBe('https://app.example.test');
  });
});
