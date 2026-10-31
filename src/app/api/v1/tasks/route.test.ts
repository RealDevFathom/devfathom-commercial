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
