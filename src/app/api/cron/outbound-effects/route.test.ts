import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  drain: vi.fn(),
}));

vi.mock('@/lib/side-effects/drain', () => ({
  drainDueOrganizations: mocks.drain,
}));

import { POST } from './route';

const originalSecret = process.env.CRON_SECRET;

function request(authorization: string | null = 'Bearer cron-test-secret'): Request {
  const headers = new Headers();
  if (authorization !== null) headers.set('authorization', authorization);
  return new Request('https://www.devfathom.com/api/cron/outbound-effects', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'cron-test-secret';
  mocks.drain.mockResolvedValue({ organizations: 2 });
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe('POST /api/cron/outbound-effects', () => {
  it.each([null, '', 'Bearer wrong', 'Bearer cron-test-secre'])(
    'rejects unauthorized calls (%s)',
    async (value) => {
      const response = await POST(request(value));
      expect(response.status).toBe(401);
      expect(mocks.drain).not.toHaveBeenCalled();
    }
  );

  it('requires CRON_SECRET to be configured', async () => {
    delete process.env.CRON_SECRET;
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.drain).not.toHaveBeenCalled();
  });

  it('rejects a secret that differs only by a same-length mismatch', async () => {
    const response = await POST(request('Bearer cron-test-secreT'));
    expect(response.status).toBe(401);
    expect(mocks.drain).not.toHaveBeenCalled();
  });

  it('drains every due organization for the shared secret', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ organizations: 2 });
    expect(mocks.drain).toHaveBeenCalledOnce();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
