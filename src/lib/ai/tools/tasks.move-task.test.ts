import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantHelpers } from '@/lib/ai/context';
import { buildTasksTools } from './tasks';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), templates: {} }));

const original = {
  id: 'task-1',
  title: 'Task',
  columnId: 'closed-column',
  order: 0,
  column: {
    name: 'Closed',
    board: { id: 'board-1', projectId: 'project-1', project: { name: 'Project' } },
  },
};
const tx = {
  $queryRaw: vi.fn(),
  task: { findUnique: vi.fn(), aggregate: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  column: { findUnique: vi.fn() },
  columnDefaultAssignee: { findMany: vi.fn() },
};
const activity = vi.fn();
const audit = vi.fn();
const now = new Date('2026-10-31T12:00:00.000Z');

function move() {
  const tools = buildTasksTools({
    db: {
      task: { findMany: vi.fn(async () => [original]) },
      column: { findMany: vi.fn(async () => [{ id: 'done-column', name: 'Done' }]) },
      $transaction: async (run: (client: typeof tx) => unknown) => run(tx),
    },
    taskVisibility: () => ({}),
    canAccessProject: async () => true,
    now: () => now,
    DONE_COLUMNS: ['Done', 'Closed'],
    activity,
    audit,
  } as unknown as AssistantHelpers);
  return (
    tools.moveTask as unknown as {
      execute: (input: { taskId: string; columnName: string }) => Promise<unknown>;
    }
  ).execute({ taskId: 'task-1', columnName: 'Done' });
}

beforeEach(() => {
  vi.resetAllMocks();
  tx.task.findUnique.mockResolvedValue(original);
  tx.column.findUnique.mockResolvedValue({ name: 'Done' });
  tx.task.aggregate.mockResolvedValue({ _max: { order: null } });
  tx.columnDefaultAssignee.findMany.mockResolvedValue([]);
});

describe('assistant moveTask completion concurrency', () => {
  it('rejects a Closed → Done move after another request reopens the task', async () => {
    tx.task.findUnique.mockResolvedValue({
      columnId: 'todo-column',
      order: 0,
      column: { name: 'To Do' },
    });

    expect(await move()).toMatchObject({ error: expect.stringContaining('concurrently') });
    expect(tx.$queryRaw.mock.calls[0][1]).toEqual(['closed-column', 'done-column']);
    expect(tx.task.update).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects a column renamed after resolution', async () => {
    tx.column.findUnique.mockResolvedValue({ name: 'To Do' });
    expect(await move()).toMatchObject({ error: expect.stringContaining('concurrently') });
    expect(tx.task.update).not.toHaveBeenCalled();
  });

  it('preserves a Done-to-Done timestamp and calculates append order under the lock', async () => {
    expect(await move()).toMatchObject({ success: true });
    expect(tx.task.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { columnId: 'done-column', order: 0, completedAt: undefined },
    });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.task.aggregate.mock.invocationCallOrder[0]
    );
  });
});
