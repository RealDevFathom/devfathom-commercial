// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    column: {
      findUnique: vi.fn(async () => ({
        id: 'column-a',
        board: { id: 'board-a', project: { id: 'project-a', name: 'Project A' } },
        defaultAssignees: [],
      })),
    },
    label: { findMany: vi.fn() },
    task: { aggregate: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('@/lib/api-auth', () => ({
  withApiAuth:
    (_scope: string, handler: (...args: never[]) => unknown) => (request: Request) =>
      handler(
        { db: mocks.db, userId: 'user-a', userRole: 'EMPLOYEE' } as never,
        request as never
      ),
}));
vi.mock('@/lib/authz', () => ({ canAccessProject: vi.fn(async () => true) }));
vi.mock('@/server/activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/audit', () => ({ recordRestAudit: vi.fn() }));

import { POST } from './route';

beforeEach(() => vi.clearAllMocks());

describe('POST /api/v1/tasks label isolation', () => {
  it('rejects labels that do not belong to the selected column board', async () => {
    mocks.db.label.findMany.mockResolvedValue([]);

    const response = await POST(
      new Request('https://example.test/api/v1/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Task A', columnId: 'column-a', labelIds: ['label-b'] }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'One or more labelIds do not belong to the selected column’s board.',
    });
    expect(mocks.db.label.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['label-b'] }, boardId: 'board-a' },
      select: { id: true },
    });
    expect(mocks.db.task.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate label IDs before creating the task', async () => {
    const response = await POST(
      new Request('https://example.test/api/v1/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Task A',
          columnId: 'column-a',
          labelIds: ['label-a', 'label-a'],
        }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'labelIds must not contain duplicates.',
    });
    expect(mocks.db.label.findMany).not.toHaveBeenCalled();
    expect(mocks.db.task.create).not.toHaveBeenCalled();
  });
});
