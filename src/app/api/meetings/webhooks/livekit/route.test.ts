import { oversizedRequest } from '../../../../../../tests/fixtures/bounded-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  rateLimit: vi.fn(),
  resolveProviderRoom: vi.fn(),
  recordAndApplyProviderEvent: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({ clientIp: () => '192.0.2.17', rateLimit: mocks.rateLimit }));

vi.mock('@/server/meetings/provider/livekit', () => ({
  createLiveKitWebhookVerifier: () => mocks.verify,
}));
vi.mock('@/server/meetings/provider/events', () => ({
  resolveProviderRoom: mocks.resolveProviderRoom,
  recordAndApplyProviderEvent: mocks.recordAndApplyProviderEvent,
}));

import { POST } from './route';
import { MeetingProviderError } from '@/server/meetings/provider/types';

describe('LiveKit webhook route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimit.mockResolvedValue({ ok: true });
    process.env.LIVEKIT_API_KEY = 'key';
    process.env.LIVEKIT_API_SECRET = 'secret';
  });

  it('passes exact raw bytes to verification and durably ingests a known room', async () => {
    const body = '{ "event": "room_created" }\n';
    const normalized = { id: 'event-1', roomName: 'mtg_random' };
    const occurrence = { id: 'occ-1', organizationId: 'org-1' };
    mocks.verify.mockResolvedValue(normalized);
    mocks.resolveProviderRoom.mockResolvedValue(occurrence);
    mocks.recordAndApplyProviderEvent.mockResolvedValue('processed');

    const response = await POST(
      new Request('https://example.test/api/meetings/webhooks/livekit', {
        method: 'POST',
        headers: { authorization: 'signed' },
        body,
      })
    );

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(mocks.verify.mock.calls[0][0])).toBe(body);
    expect(mocks.recordAndApplyProviderEvent).toHaveBeenCalledWith(occurrence, normalized);
  });

  it('acknowledges an unknown room without creating any event', async () => {
    mocks.verify.mockResolvedValue({ id: 'event-1', roomName: 'unknown' });
    mocks.resolveProviderRoom.mockResolvedValue(null);
    const response = await POST(
      new Request('https://example.test/api/meetings/webhooks/livekit', {
        method: 'POST',
        body: '{}',
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.recordAndApplyProviderEvent).not.toHaveBeenCalled();
  });

  it('rejects oversized input before verification', async () => {
    const response = await POST(
      new Request('https://example.test/api/meetings/webhooks/livekit', {
        method: 'POST',
        headers: { 'content-length': String(256 * 1024 + 1) },
        body: '{}',
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('bounds a chunked request before verification or ingestion', async () => {
    const { request, cancelled, bytesRead } = oversizedRequest(256 * 1024);
    expect((await POST(request)).status).toBe(400);
    expect(cancelled()).toBe(true);
    expect(bytesRead()).toBeLessThanOrEqual(256 * 1024 + 16_384);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.recordAndApplyProviderEvent).not.toHaveBeenCalled();
  });

  it('rate-limits before reading or verifying a request', async () => {
    mocks.rateLimit.mockResolvedValueOnce({ ok: false, retryAfter: 12 });
    const { request, bytesRead } = oversizedRequest(256 * 1024);
    const response = await POST(request);
    expect(mocks.rateLimit).toHaveBeenCalledWith('meetings-livekit:ip:192.0.2.17', 120, 60_000);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('12');
    expect(bytesRead()).toBe(0);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.recordAndApplyProviderEvent).not.toHaveBeenCalled();
  });

  it('returns one generic rejection for verifier failures', async () => {
    mocks.verify.mockRejectedValue(new MeetingProviderError('invalid'));
    const response = await POST(
      new Request('https://example.test/api/meetings/webhooks/livekit', {
        method: 'POST',
        body: '{}',
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid webhook.' });
  });
});
