// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
const count = vi.fn();

vi.mock('@/lib/api-auth', () => ({
  withApiAuth: (_scope: string, handler: unknown) => handler,
}));
vi.mock('@/lib/meetings/materialize', () => ({ materializeMeetingOccurrences: vi.fn() }));

import { POST } from './route';

const callPost = (body: unknown) =>
  (POST as unknown as (ctx: unknown, request: Request) => Promise<Response>)(
    { userId: 'owner_1', db: { user: { count }, meeting: { create } } },
    new Request('https://example.test/api/v1/meetings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

describe('POST /api/v1/meetings time order', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an end time equal to the start before any database write', async () => {
    const response = await callPost({
      title: 'Impossible meeting',
      startTime: '2026-10-29T10:00:00.000Z',
      endTime: '2026-10-29T10:00:00.000Z',
      attendeeIds: [],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'The end time must be after the start time.',
    });
    expect(count).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
