// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    column: {
      findUnique: vi.fn(
        async (): Promise<{
          id: string;
          board: { project: { id: string; name: string } };
          defaultAssignees: Array<{ userId: string }>;
        }> => ({
          id: 'column-1',
          board: { project: { id: 'project-1', name: 'Project' } },
          defaultAssignees: [],
        })
      ),
    },
    projectMember: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    },
    label: { count: vi.fn(async () => 0) },
    task: {
      aggregate: vi.fn(async () => ({ _max: { order: null } })),
      create: vi.fn(async () => ({ id: 'task-1', title: 'Task' })),
    },
  },
}));

vi.mock('@/lib/api-auth', () => ({
  withApiAuth:
    (_scope: string, handler: (...args: never[]) => unknown) =>
    (request: Request) =>
      handler(
        { db: mocks.db, userId: 'actor', userRole: 'ADMIN' } as never,
        request as never
      ),
}));
vi.mock('@/lib/authz', () => ({ canAccessProject: vi.fn(async () => true) }));
vi.mock('@/server/activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/audit', () => ({ recordRestAudit: vi.fn() }));

import { POST } from './route';

beforeEach(() => vi.clearAllMocks());

describe('POST /api/v1/tasks', () => {
  it('rejects an assignee who is not a member of the task project', async () => {
    const response = await POST(
      new Request('https://example.test/api/v1/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Task',
          columnId: 'column-1',
          assigneeIds: ['other-project-user'],
        }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'All assignees must be members of the project.',
    });
    expect(mocks.db.projectMember.count).toHaveBeenCalledWith({
      where: { projectId: 'project-1', userId: { in: ['other-project-user'] } },
    });
    expect(mocks.db.task.create).not.toHaveBeenCalled();
  });

  it('deduplicates explicit assignees before validating and creating assignments', async () => {
    mocks.db.projectMember.count.mockResolvedValueOnce(1);
    mocks.db.task.create.mockResolvedValueOnce({ id: 'task-1', title: 'Task' });

    const response = await POST(
      new Request('https://example.test/api/v1/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Task',
          columnId: 'column-1',
          assigneeIds: ['project-member', 'project-member'],
        }),
      })
    );

    expect(response.status).toBe(201);
    expect(mocks.db.projectMember.count).toHaveBeenCalledWith({
      where: { projectId: 'project-1', userId: { in: ['project-member'] } },
    });
    expect(mocks.db.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignees: { create: [{ userId: 'project-member' }] },
        }),
      })
    );
  });

  it('does not assign a stale column default that is no longer a project member', async () => {
    mocks.db.column.findUnique.mockResolvedValueOnce({
      id: 'column-1',
      board: { project: { id: 'project-1', name: 'Project' } },
      defaultAssignees: [{ userId: 'removed-user' }],
    });
    mocks.db.task.create.mockResolvedValueOnce({ id: 'task-1', title: 'Task' });

    const response = await POST(
      new Request('https://example.test/api/v1/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Task', columnId: 'column-1', assigneeIds: [] }),
      })
    );

    expect(response.status).toBe(201);
    expect(mocks.db.projectMember.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1', userId: { in: ['removed-user'] } },
      select: { userId: true },
    });
    expect(mocks.db.task.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignees: undefined }) })
    );
  });
});
