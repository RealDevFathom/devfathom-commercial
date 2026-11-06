// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  completedAtForColumnChange,
  entersDone,
  isDoneColumnName,
  syncCompletionForColumnRename,
} from './task-completion';

const NOW = new Date('2026-11-02T09:03:00.000Z');

describe('isDoneColumnName', () => {
  it.each(['Done', 'done', 'DONE', 'Complete', 'Completed', 'Shipped', 'Closed'])(
    'treats %s as done',
    (name) => expect(isDoneColumnName(name)).toBe(true)
  );

  it.each([
    'To Do',
    'In Progress',
    'Review',
    'Done-ish',
    'Not done',
    'Archived',
    '',
    null,
    undefined,
  ])('treats %s as not done', (name) => expect(isDoneColumnName(name)).toBe(false));
});

describe('completedAtForColumnChange', () => {
  it('stamps a task created straight into a done column', () => {
    expect(completedAtForColumnChange(null, 'Done', NOW)).toEqual({ completedAt: NOW });
  });

  it('leaves a task created outside done uncompleted', () => {
    expect(completedAtForColumnChange(null, 'To Do', NOW)).toEqual({ completedAt: null });
  });

  it('stamps a task entering done from a non-done column', () => {
    expect(completedAtForColumnChange('In Progress', 'Shipped', NOW)).toEqual({
      completedAt: NOW,
    });
  });

  it('keeps the original completion when moving between done columns or within one', () => {
    expect(completedAtForColumnChange('Done', 'Closed', NOW)).toEqual({});
    expect(completedAtForColumnChange('Done', 'Done', NOW)).toEqual({});
  });

  it('clears completion when the task leaves done', () => {
    expect(completedAtForColumnChange('Done', 'In Progress', NOW)).toEqual({ completedAt: null });
  });

  it('defaults the completion time to now', () => {
    vi.useFakeTimers({ now: NOW });
    try {
      expect(completedAtForColumnChange('To Do', 'Done')).toEqual({ completedAt: NOW });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('entersDone', () => {
  it('is true only for a non-done (or new) task landing in done', () => {
    expect(entersDone('To Do', 'Done')).toBe(true);
    expect(entersDone(null, 'Done')).toBe(true);
    expect(entersDone('Done', 'Shipped')).toBe(false);
    expect(entersDone('Done', 'To Do')).toBe(false);
    expect(entersDone('To Do', 'Review')).toBe(false);
  });
});

describe('syncCompletionForColumnRename', () => {
  const db = () => ({ task: { updateMany: vi.fn(async () => ({ count: 2 })) } });

  it('completes the column’s open tasks when it is renamed to a done name', async () => {
    const client = db();
    await expect(syncCompletionForColumnRename(client, 'col', 'QA', 'Done', NOW)).resolves.toBe(
      true
    );
    expect(client.task.updateMany).toHaveBeenCalledWith({
      where: { columnId: 'col', completedAt: null },
      data: { completedAt: NOW },
    });
  });

  it('reopens the column’s tasks when it is renamed away from done', async () => {
    const client = db();
    await expect(syncCompletionForColumnRename(client, 'col', 'Done', 'QA', NOW)).resolves.toBe(
      true
    );
    expect(client.task.updateMany).toHaveBeenCalledWith({
      where: { columnId: 'col' },
      data: { completedAt: null },
    });
  });

  it.each([
    ['Done', 'Shipped'],
    ['To Do', 'Doing'],
    ['Done', 'Done'],
  ])('writes nothing for %s → %s', async (from, to) => {
    const client = db();
    await expect(syncCompletionForColumnRename(client, 'col', from, to, NOW)).resolves.toBe(false);
    expect(client.task.updateMany).not.toHaveBeenCalled();
  });
});
