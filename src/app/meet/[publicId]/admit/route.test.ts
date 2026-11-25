/**
 * The public admission endpoint.
 *
 * The assertions that matter here are on the RESPONSE, not the UI. Every
 * refusal must be byte-identical whatever the cause (MEET-001 T5), the guest
 * credential must never appear in the URL (MEET-004 D5), and throttling must
 * happen before any admission work is attempted (MEET-004 step 1).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oversizedRequest } from '../../../../../tests/fixtures/bounded-request';

const mocks = vi.hoisted(() => ({
  admitToMeeting: vi.fn(),
  admitAnonymousRequest: vi.fn((): { ok: true } | { ok: false; retryAfter: number } => ({
    ok: true,
  })),
  resolveTenantActor: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/anonymous-rate-limit', () => ({
  admitAnonymousRequest: mocks.admitAnonymousRequest,
}));
vi.mock('@/lib/meetings/admission', () => ({
  admitToMeeting: mocks.admitToMeeting,
  GENERIC_ADMISSION_ERROR: 'This meeting is unavailable or the access code is invalid.',
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));

import { POST } from './route';

const PUBLIC_ID = '7e3c19c6-79a4-4db1-a436-68efbf00f309';
const ADMISSION = {
  token: 'signed-livekit-token',
  serverUrl: 'wss://meet.example.test',
  title: 'Private planning',
  startsAt: '2026-08-27T10:00:00.000Z',
  endsAt: '2026-08-27T11:00:00.000Z',
  role: 'ATTENDEE',
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://www.devfathom.com/meet/${PUBLIC_ID}/admit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'www.devfathom.com', ...headers },
    body: JSON.stringify(body),
  });
}

const params = Promise.resolve({ publicId: PUBLIC_ID });

describe('POST /meet/[publicId]/admit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admitAnonymousRequest.mockReturnValue({ ok: true });
    mocks.resolveTenantActor.mockResolvedValue(null);
    mocks.admitToMeeting.mockResolvedValue({ status: 'refused' });
  });

  it('cancels an oversized body before the throttle or admission sees it', async () => {
    const limit = 2 * 1024;
    const normalRequest = post({});
    const input = oversizedRequest(limit, {
      url: normalRequest.url,
      headers: normalRequest.headers,
      chunkSize: 1024,
    });

    const response = await POST(input.request, { params });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'This meeting is unavailable or the access code is invalid.',
    });
    expect(input.cancelled()).toBe(true);
    expect(input.bytesRead()).toBe(limit + 1024);
    expect(mocks.admitAnonymousRequest).not.toHaveBeenCalled();
    expect(mocks.resolveTenantActor).not.toHaveBeenCalled();
    expect(mocks.admitToMeeting).not.toHaveBeenCalled();
  });

  it('returns the admission for an accepted access code', async () => {
    mocks.admitToMeeting.mockResolvedValue({ status: 'admitted', admission: ADMISSION });

    const response = await POST(post({ accessCode: 'guest-secret' }), { params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(ADMISSION);
  });

  it('passes the request host through so the cross-check can run', async () => {
    await POST(post({ accessCode: 'guest-secret' }, { host: 'acme.devfathom.com' }), { params });

    expect(mocks.admitToMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: PUBLIC_ID, host: 'acme.devfathom.com' })
    );
  });

  it('answers a lobby hold with 200 and no credential', async () => {
    mocks.admitToMeeting.mockResolvedValue({ status: 'waiting' });

    const response = await POST(post({ accessCode: 'guest-secret' }), { params });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ waiting: true });
    expect(JSON.stringify(body)).not.toContain('signed-livekit-token');
  });

  it.each([
    ['a refusal', { status: 'refused' }],
    ['an unexpected failure', null],
  ])('answers %s with one generic 404', async (_label, outcome) => {
    if (outcome) mocks.admitToMeeting.mockResolvedValue(outcome);
    else mocks.admitToMeeting.mockRejectedValue(new Error('boom'));

    const response = await POST(post({ accessCode: 'guest-secret' }), { params });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'This meeting is unavailable or the access code is invalid.',
    });
  });

  it('throttles before attempting any admission work', async () => {
    mocks.admitAnonymousRequest.mockReturnValue({ ok: false, retryAfter: 42 });

    const response = await POST(post({ accessCode: 'guest-secret' }), { params });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(mocks.admitToMeeting).not.toHaveBeenCalled();
  });

  it('keys the throttle on the presented code, not only the address', async () => {
    await POST(post({ accessCode: 'guest-secret' }), { params });

    expect(mocks.admitAnonymousRequest).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'token', token: 'guest-secret' })
    );
  });

  it('rejects an oversized access code without calling admission', async () => {
    const response = await POST(post({ accessCode: 'x'.repeat(513) }), { params });

    expect(response.status).toBe(404);
    expect(mocks.admitToMeeting).not.toHaveBeenCalled();
  });

  it('still answers generically when the session cannot be resolved for this host', async () => {
    mocks.resolveTenantActor.mockRejectedValue(new Error('session belongs to another workspace'));

    const response = await POST(post({ accessCode: 'guest-secret' }), { params });

    expect(response.status).toBe(404);
    expect(mocks.admitToMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ sessionUser: null })
    );
  });

  it('forwards a resolved member session as the meeting authority', async () => {
    mocks.resolveTenantActor.mockResolvedValue({
      session: { user: { id: 'member_1', role: 'MEMBER' } },
      organization: { id: 'org_a' },
    });

    await POST(post({}), { params });

    expect(mocks.admitToMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionUser: { id: 'member_1', organizationId: 'org_a', role: 'MEMBER' },
      })
    );
  });
});
