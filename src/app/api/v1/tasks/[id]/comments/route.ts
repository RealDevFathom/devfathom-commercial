import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';

export const GET = withApiAuth(
  'tasks:read',
  async (_authCtx, _request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const task = await db.task.findUnique({ where: { id }, select: { id: true } });
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

    const comments = await db.taskComment.findMany({
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
  },
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
    const body = await request.json();
    const parsed = createCommentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.issues },
        { status: 400 },
      );
    }

    // Ensure the task exists before inserting so we return a clear 404
    const task = await db.task.findUnique({ where: { id }, select: { id: true } });
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

    const comment = await db.taskComment.create({
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
  },
);
