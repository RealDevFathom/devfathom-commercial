import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), templates: {} }));
vi.mock('@/lib/authz', () => ({ canManageMeeting: vi.fn(async () => true) }));
vi.mock('@/lib/meetings/materialize', () => ({ materializeMeetingOccurrences: vi.fn() }));

import { buildMeetingsTools } from './meetings';
import type { AssistantHelpers } from '@/lib/ai/context';

const update = vi.fn();
const meeting = {
  id: 'meeting_1',
  title: 'Planning',
  startTime: new Date('2026-10-29T10:00:00.000Z'),
  endTime: new Date('2026-10-29T11:00:00.000Z'),
};

const tool = () => {
  const tools = buildMeetingsTools({
    db: { meeting: { findMany: vi.fn(async () => [meeting]), update } },
    ctx: { userId: 'owner_1', role: 'ADMIN' },
    isAdmin: true,
    resolveNamed: vi.fn(() => ({ kind: 'resolved', value: meeting })),
    audit: vi.fn(),
  } as unknown as AssistantHelpers);
  return tools.updateMeeting as unknown as {
    execute: (input: Record<string, unknown>) => Promise<{ error?: string }>;
  };
};

describe('assistant updateMeeting time order', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a one-sided partial update using the existing end time', async () => {
    await expect(
      tool().execute({ meeting: 'Planning', startTime: '2026-10-29T11:00:00.000Z' })
    ).resolves.toEqual({ error: 'The end time must be after the start time.' });
    expect(update).not.toHaveBeenCalled();
  });
});
