// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const taskAssignee = {
    deleteMany: vi.fn(async () => ({ count: 1 })),
    createMany: vi.fn(async () => ({ count: 1 })),
  };
  const db = {
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
      count: vi.fn(
        async ({ where }: { where: { userId: { in: string[] } } }) => where.userId.in.length
      ),
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
});

describe('PATCH /api/v1/tasks/:id assignees', () => {
  it.each([
    { field: 'assigneeIds', ids: ['project-member', 'outside-user'] },
    { field: 'addAssigneeIds', ids: ['outside-user'] },
  ])('rejects non-project members supplied through $field', async ({ field, ids }) => {
    mocks.db.projectMember.count.mockResolvedValueOnce(ids.length - 1);

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
      where: { projectId: 'source-project', userId: { in: ids } },
    });
    expect(mocks.taskAssignee.deleteMany).not.toHaveBeenCalled();
    expect(mocks.taskAssignee.createMany).not.toHaveBeenCalled();
    expect(mocks.db.task.update).not.toHaveBeenCalled();
  });

  it('deduplicates replacement assignees before validation and insertion', async () => {
    const response = await PATCH(
      new Request('https://example.test/api/v1/tasks/task-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assigneeIds: ['project-member', 'project-member'] }),
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.db.projectMember.count).toHaveBeenCalledWith({
      where: { projectId: 'source-project', userId: { in: ['project-member'] } },
    });
    expect(mocks.taskAssignee.createMany).toHaveBeenCalledWith({
      data: [{ taskId: 'task-1', userId: 'project-member' }],
    });
  });
});

describe('PATCH /api/v1/tasks/:id completedAt (DEV-250)', () => {
  const patch = (body: unknown) =>
    PATCH(
      new Request('https://example.test/api/v1/tasks/task-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: 'task-1' }) }
    );
  const updateData = () =>
    (mocks.db.task.update.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>)[0][0]
      .data;
  const inColumn = (name: string) => ({
    id: 'task-1',
    title: 'Private task',
    columnId: 'source-column',
    order: 0,
    column: { id: 'source-column', name },
  });
  const target = (name: string) => ({
    id: 'target-column',
    name,
    board: { project: { id: 'source-project', name: 'Source' } },
    defaultAssignees: [],
  });

  it('stamps completedAt when the move enters a done column', async () => {
    mocks.db.column.findUnique.mockResolvedValueOnce(target('Done'));
    expect((await patch({ columnId: 'target-column' })).status).toBe(200);
    expect(updateData()).toMatchObject({
      columnId: 'target-column',
      completedAt: expect.any(Date),
    });
  });

  it('clears completedAt when the move leaves done', async () => {
    mocks.db.task.findUnique.mockResolvedValueOnce(inColumn('Done'));
    mocks.db.column.findUnique.mockResolvedValueOnce(target('In Progress'));
    expect((await patch({ columnId: 'target-column' })).status).toBe(200);
    expect(updateData()).toMatchObject({ completedAt: null });
  });

  it('keeps completedAt on a done-to-done move and never touches it on a plain edit', async () => {
    mocks.db.task.findUnique.mockResolvedValueOnce(inColumn('Done'));
    mocks.db.column.findUnique.mockResolvedValueOnce(target('Shipped'));
    await patch({ columnId: 'target-column' });
    expect(updateData()).not.toHaveProperty('completedAt');

    mocks.db.task.update.mockClear();
    mocks.db.task.findUnique.mockResolvedValueOnce(inColumn('Done'));
    await patch({ title: 'Edited', completedAt: '2020-01-01T00:00:00.000Z' });
    expect(updateData()).toEqual({ title: 'Edited' });
  });
});
