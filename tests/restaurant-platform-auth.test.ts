// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureTotp, platformActorCode } from './e2e/fixtures/restaurant-platform-auth';

// RFC 6238 SHA-1 vectors, reduced to the six digits accepted by the application.
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
describe('restaurant fixture authenticator', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('matches the independent RFC vector at %i seconds', (seconds, code) => {
    expect(fixtureTotp(secret, Number(seconds) * 1000)).toBe(code);
  });
  it('refuses missing and malformed setup keys without echoing them', () => {
    expect(() => fixtureTotp('')).toThrow('Missing fixture authenticator setup key.');
    expect(() => fixtureTotp('!not-a-key')).toThrow('Invalid fixture authenticator setup key.');
  });
  it('never invents an OTP for an actor that has not enrolled', () => {
    expect(() =>
      platformActorCode('http://admin.localhost:4319', 'unenrolled@e2e.invalid')
    ).toThrow('Sign in through the fixture enrollment UI before requesting OTP.');
  });
});

describe('restaurant fixture authenticator cache', () => {
  const origin = 'http://admin.localhost:4319';
  const email = 'cache-owner@e2e.invalid';
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'restaurant-auth-cache-test-'));
    vi.stubEnv('TMPDIR', directory);
    vi.stubEnv(
      'RESTAURANT_E2E_DATABASE_URL',
      'postgresql://fixture:fixture@127.0.0.1:55439/restaurant_e2e_cache_test'
    );
    vi.stubEnv('DATABASE_URL', undefined);
    vi.stubEnv('TEST_DATABASE_URL', undefined);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('replaces a stale key when a re-created disposable database is enrolled again', async () => {
    const earlierRun = await import('./e2e/fixtures/restaurant-platform-auth');
    earlierRun.storeEnrolledAuthenticator(origin, email, 'JBSWY3DPEHPK3PXP');

    // A later worker sees the earlier run's private cache file, then the real
    // enrollment UI issues a new key for the re-created database.
    vi.resetModules();
    const laterRun = await import('./e2e/fixtures/restaurant-platform-auth');
    expect(laterRun.platformActorCode(origin, email)).toBe(fixtureTotp('JBSWY3DPEHPK3PXP'));
    expect(() => laterRun.storeEnrolledAuthenticator(origin, email, secret)).not.toThrow();

    vi.resetModules();
    const restartedWorker = await import('./e2e/fixtures/restaurant-platform-auth');
    expect(restartedWorker.platformActorCode(origin, email)).toBe(fixtureTotp(secret));

    const [cache] = readdirSync(directory);
    const files = readdirSync(join(directory, cache!));
    expect(files).toEqual(['authenticator']);
    expect(statSync(join(directory, cache!, 'authenticator')).mode & 0o777).toBe(0o600);
  });
});
