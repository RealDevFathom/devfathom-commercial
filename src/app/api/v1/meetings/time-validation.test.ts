// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    user: { count: vi.fn() },
    meeting: { create: vi.fn() },
  },
  materialize: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  withApiAuth: (_scope: string, handler: (...args: unknown[]) => unknown) => (request: Request) =>
    handler({ db: mocks.db, userId: 'actor' }, request),
}));
vi.mock('@/lib/meetings/materialize', () => ({ materializeMeetingOccurrences: mocks.materialize }));

import { POST } from './route';

function post(startTime: string, endTime: string) {
  return POST(new Request('https://example.test/api/v1/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Planning', startTime, endTime, attendeeIds: ['actor'] }),
  }));
}

describe('REST meeting time validation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.db.user.count.mockResolvedValue(1);
    mocks.db.meeting.create.mockResolvedValue({ id: 'meeting-1' });
  });

  it.each(['2026-10-31T10:00:00Z', '2026-10-31T09:00:00Z'])(
    'rejects end %s with 400 before any database writes',
    async (end) => {
      const response = await post('2026-10-31T10:00:00Z', end);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'Invalid input',
        details: [{ path: ['endTime'], message: 'End time must be after start time.' }],
      });
      expect(mocks.db.user.count).not.toHaveBeenCalled();
      expect(mocks.db.meeting.create).not.toHaveBeenCalled();
      expect(mocks.materialize).not.toHaveBeenCalled();
    }
  );

  it('creates and materializes a valid meeting, including across midnight', async () => {
    const response = await post('2026-10-31T23:30:00Z', '2026-11-01T00:30:00Z');
    expect(response.status).toBe(201);
    expect(mocks.db.meeting.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        startTime: new Date('2026-10-31T23:30:00Z'),
        endTime: new Date('2026-11-01T00:30:00Z'),
        attendees: { create: [{ userId: 'actor' }] },
      }),
    });
    expect(mocks.materialize).toHaveBeenCalledWith(mocks.db, 'meeting-1');
  });
});
