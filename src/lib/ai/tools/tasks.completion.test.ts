// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://www.devfathom.com'),
  templates: {},
}));

import { buildTasksTools } from './tasks';
import type { AssistantHelpers } from '@/lib/ai/context';

// DEV-250: the assistant's task tools keep Task.completedAt in step with the
// column a task is in — the same rule as the board and the REST API.

const tx = {
  task: { updateMany: vi.fn(async () => ({ count: 0 })), update: vi.fn(async () => ({})) },
  columnDefaultAssignee: { findMany: vi.fn(async () => []) },
};
const db = {
  task: {
    findMany: vi.fn(),
    aggregate: vi.fn(async () => ({ _max: { order: 2 } })),
    create: vi.fn(async () => ({
      id: 'task_new',
      title: 'New',
      priority: 'MEDIUM',
      dueDate: null,
      description: null,
    })),
    update: vi.fn(async () => ({ title: 'Renamed', priority: 'HIGH', dueDate: null })),
  },
  column: { findMany: vi.fn() },
  project: { findUnique: vi.fn(async () => ({ id: 'project_1', name: 'Website launch' })) },
  board: { findFirst: vi.fn() },
  columnDefaultAssignee: { findMany: vi.fn(async () => []) },
  user: { findMany: vi.fn(async () => [{ name: 'Me' }]) },
  $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
};
const activity = vi.fn();

const columns = [
  { id: 'col_todo', name: 'To Do' },
  { id: 'col_progress', name: 'In Progress' },
  { id: 'col_done', name: 'Done' },
  { id: 'col_shipped', name: 'Shipped' },
];

function taskIn(columnId: string) {
  const column = columns.find((c) => c.id === columnId)!;
  return {
    id: 'task_1',
    title: 'Publish launch notes',
    description: null,
    priority: 'HIGH',
    dueDate: null,
    order: 0,
    columnId,
    column: {
      ...column,
      board: {
        id: 'board_1',
        name: 'Launch',
        projectId: 'project_1',
        project: { id: 'project_1', name: 'Website launch' },
      },
    },
  };
}

type Tool = { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> };
function tools() {
  return buildTasksTools({
    db,
    ctx: { userId: 'me', organizationId: 'org_1', role: 'ADMIN', name: 'Me' },
    isAdmin: true,
    canAccessProject: vi.fn(async () => true),
    taskVisibility: vi.fn(() => ({})),
    audit: vi.fn(),
    activity,
    notifyUsers: vi.fn(),
    now: () => new Date(),
    DONE_COLUMNS: ['Done', 'Completed', 'Complete', 'Shipped', 'Closed'],
  } as unknown as AssistantHelpers) as unknown as Record<string, Tool>;
}

const lastTaskUpdateData = () =>
  (tx.task.update.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>).at(-1)![0]
    .data;

beforeEach(() => {
  vi.clearAllMocks();
  db.column.findMany.mockResolvedValue(columns);
  db.board.findFirst.mockResolvedValue({ id: 'board_1', name: 'Launch', columns });
});

describe('assistant moveTask completedAt', () => {
  it('stamps completedAt and reports a completion when entering Done', async () => {
    db.task.findMany.mockResolvedValue([taskIn('col_progress')]);
    await expect(
      tools().moveTask.execute({ taskId: 'task_1', columnName: 'Done' })
    ).resolves.toMatchObject({ success: true, completed: true });
    expect(lastTaskUpdateData()).toMatchObject({
      columnId: 'col_done',
      completedAt: expect.any(Date),
    });
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_completed' }));
  });

  it('keeps the original completion on a Done → Shipped move', async () => {
    db.task.findMany.mockResolvedValue([taskIn('col_done')]);
    await expect(
      tools().moveTask.execute({ taskId: 'task_1', columnName: 'Shipped' })
    ).resolves.toMatchObject({ completed: false });
    expect(lastTaskUpdateData()).not.toHaveProperty('completedAt');
    expect(activity).not.toHaveBeenCalled();
  });

  it('clears completedAt when leaving Done', async () => {
    db.task.findMany.mockResolvedValue([taskIn('col_done')]);
    await tools().moveTask.execute({ taskId: 'task_1', columnName: 'In Progress' });
    expect(lastTaskUpdateData()).toMatchObject({ columnId: 'col_progress', completedAt: null });
  });
});

describe('assistant createTask and updateTask completedAt', () => {
  it('stamps a task created into the Done column, not one created into To Do', async () => {
    await tools().createTask.execute({ projectId: 'project_1', title: 'New', columnName: 'Done' });
    await tools().createTask.execute({ projectId: 'project_1', title: 'New' });
    const created = (
      db.task.create.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>
    ).map(([args]) => args.data);
    expect(created[0]).toMatchObject({ columnId: 'col_done', completedAt: expect.any(Date) });
    expect(created[1]).toMatchObject({ columnId: 'col_todo', completedAt: null });
  });

  it('never writes completedAt when editing a Done task', async () => {
    db.task.findMany.mockResolvedValue([taskIn('col_done')]);
    await tools().updateTask.execute({ taskId: 'task_1', title: 'Renamed', priority: 'HIGH' });
    const [[args]] = db.task.update.mock.calls as unknown as Array<[{ data: object }]>;
    expect(args.data).toEqual({ title: 'Renamed', priority: 'HIGH' });
  });
});
