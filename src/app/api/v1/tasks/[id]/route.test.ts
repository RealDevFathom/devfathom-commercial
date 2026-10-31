// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const taskAssignee = {
    deleteMany: vi.fn(async () => ({ count: 1 })),
    createMany: vi.fn(async () => ({ count: 1 })),
  };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
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
    },
  };
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

  it('rejects a stale move before changing tasks or assignees', async () => {
    mocks.db.task.findUnique.mockResolvedValueOnce({
      id: 'task-1',
      title: 'Private task',
      columnId: 'closed-column',
      order: 0,
      column: { id: 'closed-column', name: 'Closed' },
    });
    // The normal mock now returns To Do, representing a concurrent reopening.
    const response = await PATCH(
      new Request('https://example.test/api/v1/tasks/task-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ columnId: 'target-column', assigneeIds: [] }),
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(409);
    expect(mocks.db.$queryRaw.mock.calls[0][1]).toEqual(['closed-column', 'target-column']);
    expect(mocks.db.task.update).not.toHaveBeenCalled();
    expect(mocks.db.task.updateMany).not.toHaveBeenCalled();
    expect(mocks.taskAssignee.deleteMany).not.toHaveBeenCalled();
    expect(mocks.taskAssignee.createMany).not.toHaveBeenCalled();
  });

  it('uses the current source status after a concurrent column rename', async () => {
    mocks.db.task.findUnique.mockResolvedValueOnce({
      id: 'task-1',
      title: 'Private task',
      columnId: 'source-column',
      order: 0,
      column: { id: 'source-column', name: 'Closed' },
    });
    mocks.db.column.findUnique.mockResolvedValueOnce({
      id: 'target-column',
      name: 'Done',
      board: { project: { id: 'destination-project', name: 'Destination' } },
      defaultAssignees: [],
    });

    const response = await PATCH(
      new Request('https://example.test/api/v1/tasks/task-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ columnId: 'target-column' }),
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.db.task.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: expect.objectContaining({ completedAt: expect.any(Date) }),
    });
  });
});
