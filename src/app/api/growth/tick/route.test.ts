// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vercel from '../../../../../vercel.json';

const mocks = vi.hoisted(() => ({
  withPlatformDb: vi.fn(),
  isGrowthEnabled: vi.fn(),
  runCustomerMetrics: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));
vi.mock('@/lib/growth/metrics', () => ({ runCustomerMetrics: mocks.runCustomerMetrics }));
vi.mock('@/lib/growth', () => ({ isGrowthEnabled: mocks.isGrowthEnabled }));

import { GET, POST } from './route';

const secret = 'growth-unit-test-secret';
const findMany = vi.fn();

describe.each([
  ['GET', GET],
  ['POST', POST],
] as const)('growth tick %s', (method, handler) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CRON_SECRET', secret);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.runCustomerMetrics.mockResolvedValue(true);
    mocks.withPlatformDb.mockImplementation((run) => run({ organization: { findMany } }));
    findMany.mockResolvedValue([{ id: 'org_enabled' }, { id: 'org_disabled' }]);
    mocks.isGrowthEnabled.mockImplementation(async (id) => id === 'org_enabled');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([undefined, 'Bearer wrong', `Bearer ${'x'.repeat(secret.length)}`, secret])(
    'rejects missing or incorrect authorization before any database read: %s',
    async (authorization) => {
      const response = await handler(
        new Request('http://localhost/api/growth/tick', {
          method,
          headers: authorization ? { authorization } : {},
        })
      );
      expect(response.status).toBe(401);
      expect(mocks.withPlatformDb).not.toHaveBeenCalled();
      expect(mocks.isGrowthEnabled).not.toHaveBeenCalled();
      expect(console.info).not.toHaveBeenCalled();
    }
  );

  it('fails closed without CRON_SECRET even with a bearer header', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const response = await handler(
      new Request('http://localhost/api/growth/tick', {
        method,
        headers: { authorization: `Bearer ${secret}` },
      })
    );
    expect(response.status).toBe(401);
    expect(mocks.withPlatformDb).not.toHaveBeenCalled();
    expect(mocks.isGrowthEnabled).not.toHaveBeenCalled();
  });

  it('logs exactly once per enabled active organization', async () => {
    const response = await handler(
      new Request('http://localhost/api/growth/tick', {
        method,
        headers: { authorization: `Bearer ${secret}` },
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });
    expect(mocks.isGrowthEnabled.mock.calls).toEqual([['org_enabled'], ['org_disabled']]);
    expect(mocks.runCustomerMetrics).toHaveBeenCalledExactlyOnceWith('org_enabled');
    expect(console.info).toHaveBeenCalledExactlyOnceWith(
      '[growth] tick organizationId=org_enabled'
    );
  });

  it.each(['isGrowthEnabled', 'runCustomerMetrics'] as const)(
    'continues to the next organization when %s fails',
    async (operation) => {
      findMany.mockResolvedValue([{ id: 'org_failing' }, { id: 'org_healthy' }]);
      mocks.isGrowthEnabled.mockResolvedValue(true);
      const error = new Error('tenant processing failed');
      mocks[operation].mockRejectedValueOnce(error);
      const response = await handler(
        new Request('http://localhost/api/growth/tick', {
          method,
          headers: { authorization: `Bearer ${secret}` },
        })
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mocks.runCustomerMetrics).toHaveBeenCalledWith('org_healthy');
      expect(console.error).toHaveBeenCalledExactlyOnceWith(
        '[growth] tick failed organizationId=org_failing',
        error
      );
      expect(console.info).toHaveBeenCalledExactlyOnceWith(
        '[growth] tick organizationId=org_healthy'
      );
    }
  );

  it('logs nothing when no organizations are enabled', async () => {
    mocks.isGrowthEnabled.mockResolvedValue(false);
    const response = await handler(
      new Request('http://localhost/api/growth/tick', {
        method,
        headers: { authorization: `Bearer ${secret}` },
      })
    );
    expect(response.status).toBe(200);
    expect(console.info).not.toHaveBeenCalled();
  });
});

it('registers the five-minute Vercel GET cron against the same POST handler', () => {
  expect(GET).toBe(POST);
  expect(vercel.crons).toContainEqual({ path: '/api/growth/tick', schedule: '*/5 * * * *' });
});
