import { beforeEach, describe, expect, it, vi } from 'vitest';

const checks = vi.hoisted(() => ({
  clientIp: vi.fn(),
  databaseRole: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  assertProductionClientIpConfig: checks.clientIp,
}));
vi.mock('@/lib/db/rls-role', () => ({
  assertProductionDatabaseRole: checks.databaseRole,
}));

import { register } from './instrumentation';

describe('register', () => {
  beforeEach(() => {
    checks.clientIp.mockReset();
    checks.databaseRole.mockReset();
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
    expect(checks.clientIp).not.toHaveBeenCalled();
    expect(checks.databaseRole).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
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
    expect(checks.databaseRole).not.toHaveBeenCalled();
    exit.mockRestore();
    vi.restoreAllMocks();
  });
});
