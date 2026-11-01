import { beforeEach, describe, expect, it, vi } from 'vitest';

const checks = vi.hoisted(() => ({
  hmac: vi.fn(),
  clientIp: vi.fn(),
  databaseRole: vi.fn(),
  appEnv: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  assertProductionRateLimitHmacSecret: checks.hmac,
  assertProductionClientIpConfig: checks.clientIp,
}));
vi.mock('@/lib/db/rls-role', () => ({
  assertProductionDatabaseRole: checks.databaseRole,
}));
vi.mock('@/lib/app-env', () => ({
  assertProductionAppEnv: checks.appEnv,
}));

import { register } from './instrumentation';

describe('register', () => {
  beforeEach(() => {
    checks.hmac.mockReset();
    checks.clientIp.mockReset();
    checks.databaseRole.mockReset();
    checks.appEnv.mockReset();
    vi.unstubAllEnvs();
  });

  it('does not run production checks outside a production node server', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    await register();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    await register();
    expect(checks.hmac).not.toHaveBeenCalled();
    expect(checks.clientIp).not.toHaveBeenCalled();
    expect(checks.databaseRole).not.toHaveBeenCalled();
    expect(checks.appEnv).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('runs every production startup check and exits when one fails', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NEXT_PHASE', '');
    checks.appEnv.mockImplementation(() => {
      throw new Error('invalid app environment');
    });

    await expect(register()).rejects.toThrow('exit');

    expect(checks.hmac).toHaveBeenCalledOnce();
    expect(checks.clientIp).toHaveBeenCalledOnce();
    expect(checks.databaseRole).toHaveBeenCalledOnce();
    expect(checks.appEnv).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
    vi.restoreAllMocks();
  });

  it('exits when a production startup check throws', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NEXT_PHASE', '');
    checks.clientIp.mockImplementation(() => {
      throw new Error('no proxy');
    });
    await expect(register()).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(checks.hmac).toHaveBeenCalled();
    expect(checks.databaseRole).not.toHaveBeenCalled();
    exit.mockRestore();
    vi.restoreAllMocks();
  });

  it('exits when the rate-limit HMAC secret is missing', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NEXT_PHASE', '');
    checks.hmac.mockImplementation(() => {
      throw new Error('no hmac secret');
    });
    await expect(register()).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(checks.clientIp).not.toHaveBeenCalled();
    expect(checks.databaseRole).not.toHaveBeenCalled();
    exit.mockRestore();
    vi.restoreAllMocks();
  });

  it('exits when APP_ENV is unset on a production server, and starts when it is set', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NEXT_PHASE', '');
    checks.appEnv.mockImplementation(() => {
      if (!process.env.APP_ENV) throw new Error('APP_ENV is required');
    });
    vi.stubEnv('APP_ENV', '');
    await expect(register()).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockClear();
    vi.stubEnv('APP_ENV', 'staging');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await register();
    expect(exit).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('[startup] APP_ENV=staging');
    exit.mockRestore();
    vi.restoreAllMocks();
  });
});
