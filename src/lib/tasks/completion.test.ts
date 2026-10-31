import { describe, expect, it, vi } from 'vitest';
import { completionTimestampForMove, isDoneColumn } from './completion';

describe('task completion timestamps', () => {
  it('records the instant a task enters a completion column', () => {
    const now = new Date('2026-10-29T12:00:00.000Z');
    expect(completionTimestampForMove('In Progress', 'Done', now)).toEqual(now);
  });

  it('clears completion when work is reopened', () => {
    expect(completionTimestampForMove('Completed', 'In Progress')).toBeNull();
  });

  it('does not rewrite completion for moves within Done or ordinary edits', () => {
    const clock = vi.fn(() => new Date());
    expect(completionTimestampForMove('Done', 'Done', clock())).toBeUndefined();
    expect(isDoneColumn(' Done ')).toBe(true);
  });
});
