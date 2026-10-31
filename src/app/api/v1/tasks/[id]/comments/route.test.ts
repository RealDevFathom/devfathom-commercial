// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  taskComment: {
    findFirst: vi.fn(),
    create: vi.fn(async ({ data }) => ({ id: 'comment-2', ...data })),
  },
  canAccessProject: vi.fn(async () => true),
  projectIdOfTask: vi.fn(async () => 'project-1'),
}));

vi.mock('@/lib/api-auth', () => ({
  withApiAuth:
    (_scope: string, handler: (...args: never[]) => unknown) =>
    (request: Request, context: unknown) =>
      handler(
        {
          db: { taskComment: mocks.taskComment },
          userId: 'user-1',
          userRole: 'ADMIN',
        } as never,
        request as never,
        context as never
      ),
}));
vi.mock('@/lib/authz', () => ({
  canAccessProject: mocks.canAccessProject,
  projectIdOfTask: mocks.projectIdOfTask,
}));

import { POST } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAccessProject.mockResolvedValue(true);
  mocks.projectIdOfTask.mockResolvedValue('project-1');
});

async function post(parentId?: string) {
  const response = await POST(
    new Request('https://example.test/api/v1/tasks/task-1/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'A reply', parentId }),
    }),
    { params: Promise.resolve({ id: 'task-1' }) }
  );
  return { response, body: await response.json() };
}

describe('POST /api/v1/tasks/:id/comments', () => {
  it('rejects a parent comment that does not belong to the URL task', async () => {
    mocks.taskComment.findFirst.mockResolvedValue(null);

    const { response, body } = await post('comment-on-another-task');

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Parent comment not found on this task' });
    expect(mocks.taskComment.findFirst).toHaveBeenCalledWith({
      where: { id: 'comment-on-another-task', taskId: 'task-1' },
      select: { id: true },
    });
    expect(mocks.taskComment.create).not.toHaveBeenCalled();
  });

  it('rejects an empty parent ID instead of writing it without validation', async () => {
    mocks.taskComment.findFirst.mockResolvedValue(null);

    const { response, body } = await post('');

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Parent comment not found on this task' });
    expect(mocks.taskComment.findFirst).toHaveBeenCalledWith({
      where: { id: '', taskId: 'task-1' },
      select: { id: true },
    });
    expect(mocks.taskComment.create).not.toHaveBeenCalled();
  });

  it('does not look up the parent before authorizing access to the URL task', async () => {
    mocks.canAccessProject.mockResolvedValue(false);

    const { response, body } = await post('comment-on-another-task');

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'Forbidden' });
    expect(mocks.taskComment.findFirst).not.toHaveBeenCalled();
    expect(mocks.taskComment.create).not.toHaveBeenCalled();
  });

  it('creates a reply when its parent belongs to the URL task', async () => {
    mocks.taskComment.findFirst.mockResolvedValue({ id: 'parent-1' });

    const { response } = await post('parent-1');

    expect(response.status).toBe(201);
    expect(mocks.taskComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          content: 'A reply',
          taskId: 'task-1',
          userId: 'user-1',
          parentId: 'parent-1',
        },
      })
    );
  });

  it('preserves top-level comment creation without a parent lookup', async () => {
    const { response } = await post();

    expect(response.status).toBe(201);
    expect(mocks.taskComment.findFirst).not.toHaveBeenCalled();
    expect(mocks.taskComment.create).toHaveBeenCalledOnce();
  });
});
