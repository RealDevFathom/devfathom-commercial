import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://www.devfathom.com'),
  templates: {},
}));

import { buildTasksTools } from './tasks';
import type { AssistantHelpers } from '@/lib/ai/context';

const findMany = vi.fn();
const deleteTask = vi.fn();
const canManageProject = vi.fn();
const db = { task: { findMany, delete: deleteTask } };

const resolvedTask = {
  id: 'task_1',
  title: 'Publish launch notes',
  description: null,
  priority: 'HIGH',
  dueDate: null,
  order: 0,
  columnId: 'column_1',
  column: {
    id: 'column_1',
    name: 'To Do',
    board: {
      id: 'board_1',
      name: 'Launch',
      projectId: 'project_1',
      project: { id: 'project_1', name: 'Website launch' },
    },
  },
};

function tool() {
  const tools = buildTasksTools({
    db,
    canManageProject,
    taskVisibility: vi.fn(() => ({})),
    audit: vi.fn(),
    activity: vi.fn(),
    DONE_COLUMNS: ['Done'],
  } as unknown as AssistantHelpers);
  return tools.deleteTask as unknown as {
    execute: (input: { taskId: string }) => Promise<{ error?: string; success?: boolean }>;
  };
}

describe('assistant deleteTask authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue([resolvedTask]);
    deleteTask.mockResolvedValue(resolvedTask);
  });

  it('refuses a project member who cannot manage the project', async () => {
    canManageProject.mockResolvedValue(false);

    await expect(tool().execute({ taskId: 'task_1' })).resolves.toEqual({
      error: 'You do not have access to that task’s project.',
    });
    expect(canManageProject).toHaveBeenCalledWith('project_1');
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it('allows a lead or admin who can manage the project', async () => {
    canManageProject.mockResolvedValue(true);

    await expect(tool().execute({ taskId: 'task_1' })).resolves.toMatchObject({ success: true });
    expect(deleteTask).toHaveBeenCalledWith({ where: { id: 'task_1' } });
  });
});
