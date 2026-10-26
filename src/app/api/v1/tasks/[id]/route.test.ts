// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const taskAssignee = {
    deleteMany: vi.fn(async () => ({ count: 1 })),
    createMany: vi.fn(async () => ({ count: 1 })),
  };
  const db: Record<string, unknown> = {
    task: {
      findUnique: vi.fn(async () => ({
        id: 'task-1',
        title: 'Private task',
        columnId: 'source-column',
        order: 0,
        column: { id: 'source-column', name: 'To Do' },
      })),
      aggregate: vi.fn(async () => ({ _max: { order: null } })),
      updateMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async () => ({ id: 'task-1', title: 'Private task' })),
    },
    column: {
      findUnique: vi.fn(async () => ({
        id: 'target-column',
        name: 'In Progress',
        board: { project: { id: 'destination-project', name: 'Destination' } },
        defaultAssignees: [{ userId: 'stale-default' }, { userId: 'destination-member' }],
      })),
    },
    taskAssignee,
    projectMember: {
      findMany: vi.fn(async () => [{ userId: 'destination-member' }]),
      count: vi.fn(async () => 1),
    },
  };
  db.$transaction = vi.fn(async (callback: (tx: typeof db) => unknown) => callback(db));
  return { db, taskAssignee };
});

vi.mock('@/lib/api-auth', () => ({
  withApiAuth:
    (_scope: string, handler: (...args: never[]) => unknown) =>
    (request: Request, context: unknown) =>
      handler(
        {
          db: mocks.db,
          userId: 'actor',
          userRole: 'ADMIN',
        } as never,
        request as never,
        context as never
      ),
}));
vi.mock('@/lib/authz', () => ({
  canAccessProject: vi.fn(async () => true),
  canManageProject: vi.fn(async () => true),
  projectIdOfTask: vi.fn(async () => 'source-project'),
}));
vi.mock('@/server/activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/audit', () => ({ recordRestAudit: vi.fn() }));

import { PATCH } from './route';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PATCH /api/v1/tasks/:id cross-project moves', () => {
  it('drops destination non-members and only applies authorized column defaults', async () => {
    const response = await PATCH(
      new Request('https://example.test/api/v1/tasks/task-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          columnId: 'target-column',
          addAssigneeIds: ['source-project-only-user'],
        }),
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.taskAssignee.deleteMany).toHaveBeenCalledWith({
      where: {
        taskId: 'task-1',
        user: {
          projectMembers: { none: { projectId: 'destination-project' } },
        },
      },
    });
    expect(mocks.db.projectMember.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'destination-project',
        userId: { in: ['stale-default', 'destination-member'] },
      },
      select: { userId: true },
    });
    expect(mocks.taskAssignee.createMany).toHaveBeenLastCalledWith({
      data: [{ taskId: 'task-1', userId: 'destination-member' }],
      skipDuplicates: true,
    });
  });

  it.each([
    ['assigneeIds', ['non-member']],
    ['addAssigneeIds', ['non-member']],
  ])('rejects non-project members supplied through %s before writing', async (field, ids) => {
    mocks.db.projectMember.count.mockResolvedValueOnce(0);

    const response = await PATCH(
      new Request('https://example.test/api/v1/tasks/task-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: ids }),
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'All assignees must be members of the project.',
    });
    expect(mocks.db.projectMember.count).toHaveBeenCalledWith({
      where: { projectId: 'source-project', userId: { in: ['non-member'] } },
    });
    expect(mocks.taskAssignee.deleteMany).not.toHaveBeenCalled();
    expect(mocks.taskAssignee.createMany).not.toHaveBeenCalled();
  });
});
