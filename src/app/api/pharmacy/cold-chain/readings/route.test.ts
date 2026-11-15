import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  receive: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/pharmacy/cold-chain-sensors', () => ({
  isColdChainSensorSecret: (token: string) => /^pcs_[A-Za-z0-9_-]{43}$/.test(token),
  receiveSensorPush: mocks.receive,
}));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '203.0.113.7',
  rateLimit: mocks.rateLimit,
}));

import { POST } from './route';

const SECRET = `pcs_${'b'.repeat(43)}`;
const BODY = { readings: [{ recordedAt: '2026-10-31T10:00:00.000Z', temperatureC: 5 }] };

function request(init: { authorization?: string; body?: string } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.authorization !== undefined) headers.set('authorization', init.authorization);
  return new Request('https://tenant.example/api/pharmacy/cold-chain/readings', {
    method: 'POST',
    headers,
    body: init.body ?? JSON.stringify(BODY),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({ ok: true, retryAfter: 0, remaining: 1 });
  mocks.receive.mockResolvedValue({
    ok: true,
    accepted: 1,
    duplicates: 0,
    zoneStatus: 'IN_RANGE',
    alertsRefreshed: false,
  });
});

describe('POST /api/pharmacy/cold-chain/readings', () => {
  it('requires a sensor bearer secret and never reaches the store without one', async () => {
    for (const authorization of [undefined, '', `Basic ${SECRET}`, 'Bearer pcd_counter']) {
      const response = await POST(request({ authorization }));
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    }
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it('accepts a push and returns only the ingest summary', async () => {
    const response = await POST(request({ authorization: `Bearer ${SECRET}` }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      accepted: 1,
      duplicates: 0,
      zoneStatus: 'IN_RANGE',
      alertsRefreshed: false,
    });
    expect(mocks.receive).toHaveBeenCalledWith(SECRET, BODY, expect.any(Date));
  });

  it('passes unparseable JSON through so authentication still runs first', async () => {
    mocks.receive.mockResolvedValue({ ok: false, error: 'invalid_body' });
    const response = await POST(request({ authorization: `Bearer ${SECRET}`, body: '{nope' }));
    expect(response.status).toBe(400);
    expect(mocks.receive).toHaveBeenCalledWith(SECRET, undefined, expect.any(Date));
  });

  it.each([
    ['unauthorized', 401],
    ['organization_suspended', 403],
    ['sensor_owner_inactive', 403],
    ['module_disabled', 403],
    ['zone_unavailable', 409],
  ] as const)('maps %s to %i', async (error, status) => {
    mocks.receive.mockResolvedValue({ ok: false, error });
    const response = await POST(request({ authorization: `Bearer ${SECRET}` }));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
  });

  it('rate-limits per address and per sensor without storing the raw secret', async () => {
    mocks.rateLimit.mockResolvedValueOnce({ ok: false, retryAfter: 60, remaining: 0 });
    expect((await POST(request({ authorization: `Bearer ${SECRET}` }))).status).toBe(429);

    mocks.rateLimit
      .mockResolvedValueOnce({ ok: true, retryAfter: 0, remaining: 1 })
      .mockResolvedValueOnce({ ok: false, retryAfter: 60, remaining: 0 });
    expect((await POST(request({ authorization: `Bearer ${SECRET}` }))).status).toBe(429);
    for (const [key] of mocks.rateLimit.mock.calls) expect(key).not.toContain(SECRET);
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it('refuses an oversized body', async () => {
    const response = await POST(
      request({ authorization: `Bearer ${SECRET}`, body: 'x'.repeat(64_001) })
    );
    expect(response.status).toBe(413);
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it('caps a chunked body without Content-Length while streaming it', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        // Would be 10 MB if read in full; the reader must stop at the cap.
        if (pulled > 640) controller.close();
        else controller.enqueue(new Uint8Array(16_000).fill(120));
      },
    });
    const response = await POST(
      new Request('https://tenant.example/api/pharmacy/cold-chain/readings', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit)
    );
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(10);
    expect(mocks.receive).not.toHaveBeenCalled();
  });

  it('never leaks an internal error to the device', async () => {
    mocks.receive.mockRejectedValue(new Error('relation "secret_table" does not exist'));
    const response = await POST(request({ authorization: `Bearer ${SECRET}` }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'internal_error' });
  });
});
