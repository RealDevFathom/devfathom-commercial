import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoSharedDeploymentOrigin } from './deployment-origin';

const demo = { isDemo: true, vertical: 'RESTAURANT', deploymentMode: 'SHARED' };

afterEach(() => vi.unstubAllEnvs());

function resolve(authUrl: string, sharedHosts: string) {
  vi.stubEnv('AUTH_URL', authUrl);
  vi.stubEnv('NEXTAUTH_URL', 'https://ignored.example.com');
  vi.stubEnv('SHARED_APP_HOSTS', sharedHosts);
  return demoSharedDeploymentOrigin(demo);
}

describe('demoSharedDeploymentOrigin', () => {
  it('preserves an exactly allowlisted loopback port', () => {
    expect(resolve('http://localhost:3217', 'localhost:3217')).toBe('http://localhost:3217');
    expect(resolve('http://[::1]:3217/', '[::1]:3217')).toBe('http://[::1]:3217');
  });

  it.each([
    ['http://localhost:3217', 'localhost'],
    ['http://localhost:3217', 'localhost:3218'],
    ['http://127.0.0.2:3217', '127.0.0.2:3217'],
    ['http://attacker.localhost:3217', 'attacker.localhost:3217'],
    ['http://prefixlocalhost:3217', 'prefixlocalhost:3217'],
    ['https://user:pass@example.com', 'https://example.com'],
    ['https://example.com?x=1', 'https://example.com'],
    ['https://example.com#x', 'https://example.com'],
    ['https://example.com/path', 'https://example.com'],
  ])('rejects invalid or non-exact origin %s with %s', (authUrl, sharedHosts) => {
    expect(resolve(authUrl, sharedHosts)).toBeNull();
  });

  it('requires canonical demo organization flags', () => {
    vi.stubEnv('AUTH_URL', 'https://demo.example.com');
    vi.stubEnv('SHARED_APP_HOSTS', 'https://demo.example.com');
    for (const organization of [
      { ...demo, isDemo: false },
      { ...demo, vertical: 'AGENCY' },
      { ...demo, deploymentMode: 'DEDICATED' },
    ]) {
      expect(demoSharedDeploymentOrigin(organization)).toBeNull();
    }
  });
});
