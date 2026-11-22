import { oversizedRequest } from '../../../../../../tests/fixtures/bounded-request';
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock('@/lib/restaurant/print-bridge-enrollment', () => ({
  exchangePrintBridgeEnrollmentCode: h.exchange,
}));
import { POST } from './route';
const code = `pbe_${'A'.repeat(32)}`;
const req = (body: unknown) =>
  new Request('https://tenant.test/api/restaurant/print-bridge/enroll', {
    method: 'POST',
    body: JSON.stringify(body),
  });
beforeEach(() => {
  h.exchange.mockReset();
});
it.each([{}, { code: 'short' }, { code, deviceId: 'existing' }])(
  'rejects invalid or overbroad input before exchange',
  async (body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(h.exchange).not.toHaveBeenCalled();
  }
);
it('returns no-store credentials once the exchange commits', async () => {
  h.exchange.mockResolvedValue({ token: 'rdk_synthetic', deviceId: 'bridge' });
  const res = await POST(req({ code }));
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.json()).toEqual({ token: 'rdk_synthetic', deviceId: 'bridge' });
});
it('maps unavailable codes without exposing their state', async () => {
  h.exchange.mockResolvedValue(null);
  const res = await POST(req({ code }));
  expect(res.status).toBe(410);
  expect(res.headers.get('cache-control')).toBe('no-store');
});
it('never leaks exchange errors or retries an uncertain outcome', async () => {
  h.exchange.mockRejectedValue(new Error('private database details rdk_secret'));
  const res = await POST(req({ code }));
  expect(res.status).toBe(500);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.text()).not.toMatch(/private|rdk_secret/);
  expect(h.exchange).toHaveBeenCalledOnce();
});

it('stops reading at the enrolment cap without exchanging a code', async () => {
  const limit = 2 * 1024;
  const input = oversizedRequest(limit, { chunkSize: 1024 });

  const response = await POST(input.request);
  expect(response.status).toBe(413);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(input.cancelled()).toBe(true);
  expect(input.bytesRead()).toBe(limit + 1024);
  expect(h.exchange).not.toHaveBeenCalled();
});
