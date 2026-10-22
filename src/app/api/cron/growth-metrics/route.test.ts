import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runNightlyCustomerMetrics: vi.fn() }));
vi.mock('@/lib/growth/nightly-customer-metrics', () => mocks);
import { POST } from './route';

describe('growth metrics cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-secret';
  });

  it('fails closed without the exact bearer secret', async () => {
    const response = await POST(new Request('http://localhost/api/cron/growth-metrics'));
    expect(response.status).toBe(401);
    expect(mocks.runNightlyCustomerMetrics).not.toHaveBeenCalled();
  });

  it('runs the collector for an authenticated request', async () => {
    mocks.runNightlyCustomerMetrics.mockResolvedValue({ tenants: 1, rows: 4 });
    const response = await POST(
      new Request('http://localhost/api/cron/growth-metrics', {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tenants: 1, rows: 4 });
  });
});
