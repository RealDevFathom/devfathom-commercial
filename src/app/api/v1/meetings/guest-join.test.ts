// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authorizeGuestOccurrence = vi.fn();
vi.mock('@/lib/meetings/guest-access', () => ({ authorizeGuestOccurrence }));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => 'test-ip',
  rateLimit: () => ({ ok: true, retryAfter: 0, remaining: 1 }),
}));
vi.mock('@/lib/api-auth', () => ({ withApiAuth: () => vi.fn() }));

describe('PUT /api/v1/meetings guest join', () => {
  beforeEach(() => authorizeGuestOccurrence.mockReset());

  it('keeps the secret in the JSON body and returns a generic denial', async () => {
    authorizeGuestOccurrence.mockResolvedValue(null);
    const { PUT } = await import('./route');
    const response = await PUT(
      new Request('https://example.test/api/v1/meetings', {
        method: 'PUT',
        body: JSON.stringify({ publicId: 'public-id-123', secret: 'x'.repeat(32) }),
      })
    );
    expect(response.status).toBe(401);
    expect(authorizeGuestOccurrence).toHaveBeenCalledWith('public-id-123', 'x'.repeat(32));
    expect(response.headers.get('location')).toBeNull();
  });

  it('returns only bounded occurrence metadata for a valid active grant', async () => {
    authorizeGuestOccurrence.mockResolvedValue({
      publicId: 'public-id-123',
      scheduledStart: new Date(Date.now() - 1_000),
      scheduledEnd: new Date(Date.now() + 1_000),
      joinOpensAt: new Date(Date.now() - 2_000),
      joinClosesAt: new Date(Date.now() + 2_000),
      status: 'SCHEDULED',
      meeting: { title: 'Planning' },
    });
    const { PUT } = await import('./route');
    const response = await PUT(
      new Request('https://example.test/api/v1/meetings', {
        method: 'PUT',
        body: JSON.stringify({ publicId: 'public-id-123', secret: 'y'.repeat(32) }),
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('secret');
  });
});
