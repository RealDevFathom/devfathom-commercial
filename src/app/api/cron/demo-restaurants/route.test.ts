import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  seatCount: vi.fn(),
  process: vi.fn(),
}));

vi.mock('@/lib/demo/config', () => ({
  isDemoEnabled: mocks.enabled,
  getDemoSeatCount: mocks.seatCount,
}));
vi.mock('@/lib/demo/jobs', () => ({ processDueDemoResetJobs: mocks.process }));

import { POST } from './route';

const originalSecret = process.env.CRON_SECRET;

function request(
  body?: unknown,
  authorization: string | null = 'Bearer cron-test-secret'
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authorization !== null) headers.set('authorization', authorization);
  return new Request('https://www.devfathom.com/api/cron/demo-restaurants', {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'cron-test-secret';
  mocks.enabled.mockReturnValue(true);
  mocks.seatCount.mockReturnValue(5);
  mocks.process.mockResolvedValue({
    organizations: 1,
    recovered: 0,
    jobs: { claimed: 1, succeeded: 1, retried: 0, dead: 0, failed: 0, released: 0 },
  });
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe('POST /api/cron/demo-restaurants', () => {
  it('is inert with a 404 when demo access is disabled', async () => {
    mocks.enabled.mockReturnValue(false);
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it.each([null, '', 'Bearer wrong'])('rejects unauthorized calls (%s)', async (value) => {
    const response = await POST(request({}, value));
    expect(response.status).toBe(401);
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it('requires CRON_SECRET to be configured', async () => {
    delete process.env.CRON_SECRET;
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it('processes an authenticated bounded request', async () => {
    const response = await POST(request({ maxJobs: 2 }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      organizations: 1,
      jobs: { claimed: 1, succeeded: 1 },
    });
    expect(mocks.process).toHaveBeenCalledWith({ maxJobs: 2 });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('defaults an authenticated request to one job', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.process).toHaveBeenCalledWith({ maxJobs: 1 });
  });

  it.each([{ maxJobs: 0 }, { maxJobs: 6 }, { maxJobs: 1.5 }, { maxJobs: 1, extra: true }])(
    'rejects invalid input %#',
    async (body) => {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(mocks.process).not.toHaveBeenCalled();
    }
  );

  it('rejects malformed JSON', async () => {
    const response = await POST(
      new Request('https://www.devfathom.com/api/cron/demo-restaurants', {
        method: 'POST',
        headers: {
          authorization: 'Bearer cron-test-secret',
          'content-type': 'application/json',
        },
        body: '{',
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.process).not.toHaveBeenCalled();
  });
});
