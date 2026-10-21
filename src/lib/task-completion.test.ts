import { describe, expect, it } from 'vitest';
import { completionTimeAfterMove } from './task-completion';

describe('completionTimeAfterMove', () => {
  const movedAt = new Date('2026-10-21T12:00:00.000Z');

  it('records the instant a task enters a done column', () => {
    expect(completionTimeAfterMove('In Progress', 'Done', movedAt)).toBe(movedAt);
  });

  it('clears completion when a task leaves a done column', () => {
    expect(completionTimeAfterMove('Done', 'Review', movedAt)).toBeNull();
  });

  it('does not rewrite completion while moving between done columns', () => {
    expect(completionTimeAfterMove('Done', 'Closed', movedAt)).toBeUndefined();
  });

  it('does not mark ordinary column moves complete', () => {
    expect(completionTimeAfterMove('Backlog', 'Review', movedAt)).toBeUndefined();
  });
});
