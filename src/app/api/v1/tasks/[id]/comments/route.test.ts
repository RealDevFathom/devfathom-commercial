// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canAccessProject } from '@/lib/authz';

const mocks = vi.hoisted(() => {
  const taskComment = {
    findFirst: vi.fn(),
    create: vi.fn(async ({ data }) => ({ id: 'comment-1', ...data })),
  };
  return { db: { taskComment }, taskComment };
});

vi.mock('@/lib/api-auth', () => ({
  withApiAuth:
    (_scope: string, handler: (...args: never[]) => unknown) =>
    (request: Request, context: unknown) =>
      handler(
        { db: mocks.db, userId: 'actor', userRole: 'ADMIN' } as never,
        request as never,
        context as never
      ),
}));
vi.mock('@/lib/authz', () => ({
  canAccessProject: vi.fn(async () => true),
  projectIdOfTask: vi.fn(async () => 'project-1'),
}));

import { POST } from './route';

const postComment = (body: Record<string, unknown>) =>
  POST(
    new Request('https://example.test/api/v1/tasks/task-1/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'task-1' }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/tasks/:id/comments', () => {
  it('rejects a parent comment that does not belong to the URL task', async () => {
    mocks.taskComment.findFirst.mockResolvedValue(null);

    const response = await postComment({ content: 'Reply', parentId: 'other-task-comment' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Parent comment not found on this task',
    });
    expect(mocks.taskComment.findFirst).toHaveBeenCalledWith({
      where: { id: 'other-task-comment', taskId: 'task-1' },
      select: { id: true },
    });
    expect(mocks.taskComment.create).not.toHaveBeenCalled();
  });

  it('rejects an empty parent ID instead of writing it without validation', async () => {
    mocks.taskComment.findFirst.mockResolvedValue(null);

    const response = await postComment({ content: 'Reply', parentId: '' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Parent comment not found on this task',
    });
    expect(mocks.taskComment.findFirst).toHaveBeenCalledWith({
      where: { id: '', taskId: 'task-1' },
      select: { id: true },
    });
    expect(mocks.taskComment.create).not.toHaveBeenCalled();
  });

  it('does not look up the parent before authorizing access to the URL task', async () => {
    vi.mocked(canAccessProject).mockResolvedValueOnce(false);

    const response = await postComment({ content: 'Reply', parentId: 'other-task-comment' });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' });
    expect(mocks.taskComment.findFirst).not.toHaveBeenCalled();
    expect(mocks.taskComment.create).not.toHaveBeenCalled();
  });

  it('creates a reply when its parent belongs to the URL task', async () => {
    mocks.taskComment.findFirst.mockResolvedValue({ id: 'task-1-comment' });

    const response = await postComment({ content: 'Reply', parentId: 'task-1-comment' });

    expect(response.status).toBe(201);
    expect(mocks.taskComment.create).toHaveBeenCalledWith({
      data: {
        content: 'Reply',
        taskId: 'task-1',
        userId: 'actor',
        parentId: 'task-1-comment',
      },
      include: {
        user: { select: { id: true, name: true, avatar: true } },
      },
    });
  });

  it('creates a top-level comment without querying for a parent', async () => {
    const response = await postComment({ content: 'Top level' });

    expect(response.status).toBe(201);
    expect(mocks.taskComment.findFirst).not.toHaveBeenCalled();
    expect(mocks.taskComment.create).toHaveBeenCalledOnce();
  });
});
