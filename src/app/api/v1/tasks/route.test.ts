// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    column: {
      findUnique: vi.fn(async () => ({
        id: 'column-1',
        board: { project: { id: 'project-1', name: 'Project' } },
        defaultAssignees: [],
      })),
    },
    projectMember: { count: vi.fn(async () => 0) },
    label: { count: vi.fn(async () => 0) },
    task: {
      aggregate: vi.fn(async () => ({ _max: { order: null } })),
      create: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api-auth', () => ({
  withApiAuth: (_scope: string, handler: (...args: never[]) => unknown) => (request: Request) =>
    handler({ db: mocks.db, userId: 'actor', userRole: 'ADMIN' } as never, request as never),
}));
vi.mock('@/lib/authz', () => ({ canAccessProject: vi.fn(async () => true) }));
vi.mock('@/server/activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/audit', () => ({ recordRestAudit: vi.fn() }));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/tasks assignees', () => {
  it('rejects an assignee who is a tenant user but not a project member', async () => {
    const response = await POST(
      new Request('https://example.test/api/v1/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Restricted task',
          columnId: 'column-1',
          assigneeIds: ['project-member', 'tenant-only-user'],
        }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'All assignees must be members of the project.',
    });
    expect(mocks.db.projectMember.count).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        userId: { in: ['project-member', 'tenant-only-user'] },
      },
    });
    expect(mocks.db.task.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/tasks completedAt (DEV-250)', () => {
  const post = () =>
    POST(
      new Request('https://example.test/api/v1/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Task', columnId: 'column-1' }),
      })
    );
  const column = (name: string) => ({
    id: 'column-1',
    name,
    board: { project: { id: 'project-1', name: 'Project' } },
    defaultAssignees: [],
  });
  const createData = () =>
    (mocks.db.task.create.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>)[0][0]
      .data;

  it.each([
    ['Done', expect.any(Date)],
    ['closed', expect.any(Date)],
    ['To Do', null],
  ])('creating into %s writes completedAt %s', async (name, completedAt) => {
    mocks.db.column.findUnique.mockResolvedValueOnce(column(name) as never);
    mocks.db.task.create.mockResolvedValueOnce({ id: 'task-1', title: 'Task' });
    expect((await post()).status).toBe(201);
    expect(createData()).toMatchObject({ columnId: 'column-1', completedAt });
  });
});
