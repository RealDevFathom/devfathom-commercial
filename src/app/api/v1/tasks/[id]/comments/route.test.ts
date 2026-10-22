// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  taskComment: {
    findUnique: vi.fn(),
    create: vi.fn(async () => ({ id: 'reply-1' })),
  },
}));

vi.mock('@/lib/api-auth', () => ({
  withApiAuth:
    (_scope: string, handler: (...args: never[]) => unknown) =>
    (request: Request, context: unknown) =>
      handler(
        {
          db: { taskComment: mocks.taskComment },
          userId: 'actor',
          userRole: 'ADMIN',
        } as never,
        request as never,
        context as never
      ),
}));
vi.mock('@/lib/authz', () => ({
  canAccessProject: vi.fn(async () => true),
  projectIdOfTask: vi.fn(async () => 'project-1'),
}));

import { POST } from './route';

const postReply = (parentId: string) =>
  POST(
    new Request('https://example.test/api/v1/tasks/task-1/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Reply', parentId }),
    }),
    { params: Promise.resolve({ id: 'task-1' }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/tasks/:id/comments reply target', () => {
  it.each([
    ['a comment on another task', { taskId: 'task-2' }],
    ['a missing comment', null],
  ])('rejects %s', async (_case, parent) => {
    mocks.taskComment.findUnique.mockResolvedValueOnce(parent);

    const response = await postReply('parent-1');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Reply target does not belong to this task',
    });
    expect(mocks.taskComment.findUnique).toHaveBeenCalledWith({
      where: { id: 'parent-1' },
      select: { taskId: true },
    });
    expect(mocks.taskComment.create).not.toHaveBeenCalled();
  });

  it('creates a reply when its parent belongs to the URL task', async () => {
    mocks.taskComment.findUnique.mockResolvedValueOnce({ taskId: 'task-1' });

    const response = await postReply('parent-1');

    expect(response.status).toBe(201);
    expect(mocks.taskComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ taskId: 'task-1', parentId: 'parent-1' }),
      })
    );
  });
});
