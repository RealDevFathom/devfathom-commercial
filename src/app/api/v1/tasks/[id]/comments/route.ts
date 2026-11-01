import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiAuth } from '@/lib/api-auth';
import { readJson } from '@/lib/api-json';
import { canAccessProject, projectIdOfTask } from '@/lib/authz';

export const GET = withApiAuth(
  'tasks:read',
  async (authCtx, _request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    // Object-level authz: resolve the task's project and require access.
    const projectId = await projectIdOfTask(authCtx.db, id);
    if (!projectId) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    if (!(await canAccessProject(authCtx.db, authCtx.userId, authCtx.userRole, projectId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const comments = await authCtx.db.taskComment.findMany({
      where: { taskId: id, parentId: null },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, name: true, avatar: true } },
        replies: {
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { id: true, name: true, avatar: true } } },
        },
      },
    });

    return NextResponse.json({ data: comments });
  }
);

const createCommentSchema = z.object({
  content: z.string().min(1).max(10_000),
  parentId: z.string().optional(),
});

// POST /api/v1/tasks/:id/comments
export const POST = withApiAuth(
  'tasks:write',
  async (authCtx, request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const __j = await readJson(request); // REST-05
    if (!__j.ok) return __j.response;
    const body = __j.data;
    const parsed = createCommentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.issues },
        { status: 400 }
      );
    }

    // Object-level authz: resolve the task's project and require access.
    const projectId = await projectIdOfTask(authCtx.db, id);
    if (!projectId) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    if (!(await canAccessProject(authCtx.db, authCtx.userId, authCtx.userRole, projectId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (parsed.data.parentId !== undefined) {
      const parent = await authCtx.db.taskComment.findFirst({
        where: { id: parsed.data.parentId, taskId: id },
        select: { id: true },
      });
      if (!parent) {
        return NextResponse.json(
          { error: 'Parent comment not found on this task' },
          { status: 400 }
        );
      }
    }

    const comment = await authCtx.db.taskComment.create({
      data: {
        content: parsed.data.content,
        taskId: id,
        userId: authCtx.userId,
        parentId: parsed.data.parentId,
      },
      include: {
        user: { select: { id: true, name: true, avatar: true } },
      },
    });

    return NextResponse.json({ data: comment }, { status: 201 });
  }
);
