/**
 * DEV-1055: the assistant's task tools enforce the same rules as the projects
 * router, through the same shared functions (`@/lib/projects/task-rules`):
 * assignees must be members of the task's project, and a reply's parent must be a
 * comment on the same task.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://www.devfathom.com'),
  templates: { taskAssigned: vi.fn(() => ({})) },
}));

import { buildTasksTools } from './tasks';
import type { AssistantHelpers } from '@/lib/ai/context';
import {
  ASSIGNEES_MUST_BE_PROJECT_MEMBERS,
  REPLY_TARGET_NOT_IN_TASK,
} from '@/lib/projects/task-rules';

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

/** Members of project_1. `user_outsider` is in the workspace but not the project. */
let projectMembers: Set<string>;
let existingAssignees: string[];
/** comment id → the task it belongs to. */
let comments: Record<string, string>;

const db = {
  task: {
    findMany: vi.fn(async () => [resolvedTask]),
    aggregate: vi.fn(async () => ({ _max: { order: 2 } })),
    create: vi.fn(async ({ data }: { data: { title: string } }) => ({
      id: 'task_new',
      title: data.title,
      priority: 'MEDIUM',
      dueDate: null,
      description: null,
    })),
  },
  project: {
    findUnique: vi.fn(async () => ({ id: 'project_1', name: 'Website launch' })),
  },
  board: {
    findFirst: vi.fn(async () => ({
      id: 'board_1',
      name: 'Launch',
      columns: [{ id: 'column_1', name: 'To Do' }],
    })),
  },
  columnDefaultAssignee: { findMany: vi.fn(async () => []) },
  projectMember: {
    count: vi.fn(async ({ where }: { where: { projectId: string; userId: { in: string[] } } }) =>
      where.projectId === 'project_1'
        ? where.userId.in.filter((id) => projectMembers.has(id)).length
        : 0
    ),
  },
  taskAssignee: {
    findMany: vi.fn(async () => existingAssignees.map((userId) => ({ userId }))),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    createMany: vi.fn(async () => ({ count: 0 })),
  },
  taskComment: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      comments[where.id] ? { taskId: comments[where.id] } : null
    ),
    create: vi.fn(async () => ({ id: 'comment_new', content: 'ok', createdAt: new Date() })),
  },
  user: { findMany: vi.fn(async () => []) },
};

const people: Record<string, { id: string; name: string }> = {
  member: { id: 'user_member', name: 'Mina Member' },
  outsider: { id: 'user_outsider', name: 'Omar Outsider' },
};

type Result = { error?: string; success?: boolean; id?: string };
type Exec<I> = { execute: (input: I) => Promise<Result> };

function tools(userId = 'user_actor') {
  const built = buildTasksTools({
    db,
    ctx: { userId, name: 'Asha Actor' },
    isAdmin: false,
    canAccessProject: vi.fn(async () => true),
    canManageProject: vi.fn(async () => true),
    taskVisibility: vi.fn(() => ({})),
    resolvePerson: vi.fn(async (name: string) =>
      people[name] ? { kind: 'ok', value: people[name] } : { kind: 'notfound' }
    ),
    notifyUsers: vi.fn(),
    audit: vi.fn(),
    activity: vi.fn(),
    DONE_COLUMNS: ['Done'],
  } as unknown as AssistantHelpers);
  return built as unknown as {
    createTask: Exec<{ title: string; projectId: string; assignees?: string[] }>;
    setTaskAssignees: Exec<{
      taskId: string;
      assignees: string[];
      mode?: 'replace' | 'add' | 'remove';
    }>;
    addTaskComment: Exec<{ taskId: string; content: string; replyToCommentId?: string }>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  projectMembers = new Set(['user_actor', 'user_member']);
  existingAssignees = [];
  comments = { comment_same_task: 'task_1', comment_other_task: 'task_2' };
});

describe('DEV-1055: assistant createTask assigns project members only', () => {
  it('refuses to create a task assigned to someone outside the project', async () => {
    const result = await tools().createTask.execute({
      title: 'Draft copy',
      projectId: 'project_1',
      assignees: ['member', 'outsider'],
    });

    expect(result).toEqual({ error: ASSIGNEES_MUST_BE_PROJECT_MEMBERS });
    expect(db.task.create).not.toHaveBeenCalled();
  });

  it('creates the task for project members', async () => {
    const result = await tools().createTask.execute({
      title: 'Draft copy',
      projectId: 'project_1',
      assignees: ['member'],
    });

    expect(result).toMatchObject({ id: 'task_new' });
    expect(db.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ assignees: { create: [{ userId: 'user_member' }] } }),
      })
    );
  });

  it('self-assigns by default only when the actor is a project member', async () => {
    await tools().createTask.execute({ title: 'Mine', projectId: 'project_1' });
    expect(db.task.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ assignees: { create: [{ userId: 'user_actor' }] } }),
      })
    );

    // An administrator can reach every project without being a member of it.
    await tools('user_admin_not_member').createTask.execute({
      title: 'Unowned',
      projectId: 'project_1',
    });
    expect(db.task.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignees: { create: [] } }) })
    );
  });
});

describe('DEV-1055: assistant setTaskAssignees assigns project members only', () => {
  it.each(['replace', 'add'] as const)(
    'refuses to %s assignees with someone outside the project',
    async (mode) => {
      existingAssignees = ['user_member'];

      const result = await tools().setTaskAssignees.execute({
        taskId: 'task_1',
        assignees: ['outsider'],
        mode,
      });

      expect(result).toEqual({ error: ASSIGNEES_MUST_BE_PROJECT_MEMBERS });
      expect(db.taskAssignee.deleteMany).not.toHaveBeenCalled();
      expect(db.taskAssignee.createMany).not.toHaveBeenCalled();
    }
  );

  it('assigns a project member and still lets anyone be removed', async () => {
    await expect(
      tools().setTaskAssignees.execute({ taskId: 'task_1', assignees: ['member'] })
    ).resolves.toMatchObject({ success: true });
    expect(db.taskAssignee.createMany).toHaveBeenCalledWith({
      data: [{ taskId: 'task_1', userId: 'user_member' }],
    });

    // Someone who has since left the project can still be taken off the task.
    existingAssignees = ['user_member', 'user_outsider'];
    await expect(
      tools().setTaskAssignees.execute({
        taskId: 'task_1',
        assignees: ['outsider'],
        mode: 'remove',
      })
    ).resolves.toMatchObject({ success: true });
    expect(db.taskAssignee.createMany).toHaveBeenLastCalledWith({
      data: [{ taskId: 'task_1', userId: 'user_member' }],
    });
  });
});

describe('DEV-1055: assistant addTaskComment keeps a reply inside its task', () => {
  it.each(['comment_other_task', 'comment_missing'])(
    'refuses a reply whose parent (%s) is not a comment on this task',
    async (replyToCommentId) => {
      const result = await tools().addTaskComment.execute({
        taskId: 'task_1',
        content: 'Threaded across tasks',
        replyToCommentId,
      });

      expect(result).toEqual({ error: REPLY_TARGET_NOT_IN_TASK });
      expect(db.taskComment.create).not.toHaveBeenCalled();
    }
  );

  it('adds a reply to a comment on the same task, and a top-level comment', async () => {
    await expect(
      tools().addTaskComment.execute({
        taskId: 'task_1',
        content: 'Agreed',
        replyToCommentId: 'comment_same_task',
      })
    ).resolves.toMatchObject({ success: true });
    expect(db.taskComment.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ taskId: 'task_1', parentId: 'comment_same_task' }),
      })
    );

    await expect(
      tools().addTaskComment.execute({ taskId: 'task_1', content: 'Top level' })
    ).resolves.toMatchObject({ success: true });
    expect(db.taskComment.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ parentId: null }) })
    );
  });
});
