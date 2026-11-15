// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantHelpers } from '@/lib/ai/context';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/meetings/materialize', () => ({ materializeMeetingOccurrences: vi.fn() }));
const mocks = vi.hoisted(() => ({
  db: {
    user: { findUnique: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    meeting: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    meetingAttendee: { deleteMany: vi.fn(), createMany: vi.fn() },
  },
}));
vi.mock('@/lib/api-auth', () => ({
  withApiAuth: (_scope: string, handler: (...args: never[]) => unknown) => (request: Request) =>
    handler({ db: mocks.db, userId: 'admin', userRole: 'ADMIN' } as never, request as never),
}));

import { meetingsRouter } from '@/server/routers/meetings';
import { POST } from '@/app/api/v1/meetings/route';
import { buildMeetingsTools } from '@/lib/ai/tools/meetings';
import { MEETING_TIME_ORDER_ERROR } from './time-range';

const start = new Date('2026-12-01T10:00:00Z');
const end = new Date('2026-12-01T11:00:00Z');
const caller = () =>
  meetingsRouter.createCaller({
    db: mocks.db,
    session: { user: { id: 'admin', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org' } },
    entitlements: { enabledModules: ['meetings'] },
  } as never);

const helpers = () =>
  ({
    db: mocks.db,
    ctx: { userId: 'admin', role: 'ADMIN' },
    isAdmin: true,
    resolveNamed: () => ({ kind: 'found', value: { id: 'meeting', name: 'Planning' } }),
    audit: vi.fn(),
    notifyUsers: vi.fn(),
  }) as unknown as AssistantHelpers;

const executeAI = (name: string, input: object) => {
  const execute = buildMeetingsTools(helpers())[name].execute as (
    input: object,
    options: object
  ) => Promise<unknown>;
  return execute(input, { toolCallId: 'test', messages: [] });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.user.findUnique.mockResolvedValue({ id: 'admin' });
  mocks.db.user.count.mockResolvedValue(1);
  mocks.db.user.findMany.mockResolvedValue([{ id: 'admin' }]);
  mocks.db.meeting.findUnique.mockResolvedValue({ startTime: start, endTime: end });
  mocks.db.meeting.create.mockImplementation(async ({ data }) => ({ id: 'meeting', ...data }));
  mocks.db.meeting.update.mockImplementation(async ({ data }) => ({
    id: 'meeting',
    title: 'Planning',
    startTime: start,
    endTime: end,
    ...data,
  }));
  mocks.db.meeting.findMany.mockResolvedValue([{ id: 'meeting', title: 'Planning' }]);
});

function expectNoWrites() {
  expect(mocks.db.meeting.create).not.toHaveBeenCalled();
  expect(mocks.db.meeting.update).not.toHaveBeenCalled();
  expect(mocks.db.meetingAttendee.deleteMany).not.toHaveBeenCalled();
  expect(mocks.db.meetingAttendee.createMany).not.toHaveBeenCalled();
}

const invalidEnds = [new Date('2026-12-01T09:00:00Z'), start];
const invalidUpdates = [
  { startTime: end },
  { startTime: new Date('2026-12-01T12:00:00Z') },
  { endTime: start },
  { endTime: new Date('2026-12-01T09:00:00Z') },
  { startTime: end, endTime: start },
];

describe('meeting time order at write boundaries', () => {
  it.each(invalidEnds)('tRPC rejects create ending at %s before writing', async (endTime) => {
    await expect(
      caller().create({ title: 'Planning', startTime: start, endTime, attendeeIds: [] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expectNoWrites();
  });

  it.each(invalidUpdates)(
    'tRPC rejects invalid partial or full update %j before attendee writes',
    async (times) => {
      await expect(
        caller().update({ id: 'meeting', ...times, attendeeIds: ['admin'] })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: MEETING_TIME_ORDER_ERROR });
      expectNoWrites();
    }
  );

  it.each(invalidEnds)('REST rejects create ending at %s', async (endTime) => {
    const response = await POST(
      new Request('https://example.test/api/v1/meetings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Planning', startTime: start, endTime }),
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Invalid input',
      details: [expect.objectContaining({ path: ['endTime'], message: MEETING_TIME_ORDER_ERROR })],
    });
    expectNoWrites();
  });

  it.each(invalidUpdates)(
    'AI rejects invalid partial or full update %j before attendee writes',
    async (times) => {
      const input = Object.fromEntries(
        Object.entries(times).map(([key, value]) => [key, value.toISOString()])
      );
      expect(
        await executeAI('updateMeeting', { meeting: 'Planning', ...input, attendees: [] })
      ).toEqual({ error: MEETING_TIME_ORDER_ERROR });
      expectNoWrites();
    }
  );

  it.each(invalidEnds)('AI create retains its rejection of end %s', async (endTime) => {
    expect(
      await executeAI('createMeeting', {
        title: 'Planning',
        startTime: start.toISOString(),
        endTime: endTime.toISOString(),
      })
    ).toEqual({ error: MEETING_TIME_ORDER_ERROR });
    expectNoWrites();
  });

  it('accepts a positive duration and a valid partial update through tRPC', async () => {
    await caller().create({ title: 'Planning', startTime: start, endTime: end, attendeeIds: [] });
    expect(mocks.db.meeting.create).toHaveBeenCalledOnce();
    await caller().update({ id: 'meeting', endTime: new Date('2026-12-01T12:00:00Z') });
    expect(mocks.db.meeting.update).toHaveBeenCalledOnce();
  });

  it('accepts an overnight meeting through REST', async () => {
    const response = await POST(
      new Request('https://example.test/api/v1/meetings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Planning',
          startTime: '2026-12-01T23:00:00Z',
          endTime: '2026-12-02T00:00:00Z',
        }),
      })
    );
    expect(response.status).toBe(201);
    expect(mocks.db.meeting.create).toHaveBeenCalledOnce();
  });

  it('accepts a valid partial AI update', async () => {
    expect(
      await executeAI('updateMeeting', { meeting: 'Planning', endTime: '2026-12-01T12:00:00Z' })
    ).toMatchObject({ updated: true });
    expect(mocks.db.meeting.update).toHaveBeenCalledOnce();
  });
});
