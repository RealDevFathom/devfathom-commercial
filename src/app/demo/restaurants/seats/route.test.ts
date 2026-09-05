import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  sharedHost: vi.fn(),
  seats: vi.fn(),
}));

vi.mock('@/lib/demo/access', () => ({ getDemoSeatOptions: mocks.seats }));
vi.mock('@/lib/demo/config', () => ({ isDemoEnabled: mocks.enabled }));
vi.mock('@/lib/tenancy/host', () => ({
  isSharedHost: mocks.sharedHost,
  requestHost: (request: Request) => new URL(request.url).hostname,
}));

import { GET } from './route';

const request = () => new Request('https://www.devfathom.com/demo/restaurants/seats');

describe('GET demo restaurant seats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.sharedHost.mockReturnValue(true);
    mocks.seats.mockResolvedValue([{ seat: 1, name: 'Demo Restaurant — Seat 1', ready: true }]);
  });

  it('returns only bounded public seat presentation with noindex caching headers', async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(body).toEqual({
      seats: [{ seat: 1, name: 'Demo Restaurant — Seat 1', ready: true }],
    });
    expect(JSON.stringify(body)).not.toContain('manager');
    expect(JSON.stringify(body)).not.toContain('organizationId');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('returns 404 without querying seats when disabled or off the shared host', async () => {
    mocks.enabled.mockReturnValueOnce(false);
    expect((await GET(request())).status).toBe(404);
    mocks.sharedHost.mockReturnValueOnce(false);
    expect((await GET(request())).status).toBe(404);
    expect(mocks.seats).not.toHaveBeenCalled();
  });
});
