import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';
import { logActivity } from '@/server/activity';

// GET /api/v1/tasks?columnId=&assigneeId=&priority=
export const GET = withApiAuth('tasks:read', async (_ctx, request) => {
  const url = new URL(request.url);
  const columnId = url.searchParams.get('columnId');
  const assigneeId = url.searchParams.get('assigneeId');
  const priority = url.searchParams.get('priority');
  const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);

  const where: Record<string, unknown> = {};
  if (columnId) where.columnId = columnId;
  if (assigneeId) where.assignees = { some: { userId: assigneeId } };
  if (priority) where.priority = priority;

  const tasks = await db.task.findMany({
    where,
    take: Math.min(limit, 100),
    orderBy: { createdAt: 'desc' },
    include: {
      column: { select: { id: true, name: true, board: { select: { id: true, projectId: true } } } },
      assignees: { include: { user: { select: { id: true, name: true, email: true } } } },
      labels: { include: { label: true } },
    },
  });

  return NextResponse.json({ data: tasks });
});

// POST /api/v1/tasks
const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  columnId: z.string(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  dueDate: z.string().datetime().optional(),
  assigneeIds: z.array(z.string()).default([]),
  labelIds: z.array(z.string()).default([]),
});

export const POST = withApiAuth('tasks:write', async (ctx, request) => {
  const body = await request.json();
  const parsed = createTaskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.issues }, { status: 400 });
  }

  const input = parsed.data;

  // Verify column exists and grab its project for activity logging
  const column = await db.column.findUnique({
    where: { id: input.columnId },
    include: {
      board: { select: { project: { select: { id: true, name: true } } } },
      defaultAssignees: { select: { userId: true } },
    },
  });
  if (!column) return NextResponse.json({ error: 'Column not found' }, { status: 404 });

  const maxOrder = await db.task.aggregate({ _max: { order: true }, where: { columnId: input.columnId } });

  // Merge explicit assignees with the column's default owners (deduped)
  const mergedAssignees = [
    ...new Set([
      ...input.assigneeIds,
      ...column.defaultAssignees.map((d) => d.userId),
    ]),
  ];

  const task = await db.task.create({
    data: {
      title: input.title,
      description: input.description,
      columnId: input.columnId,
      order: (maxOrder._max.order ?? -1) + 1,
      priority: input.priority,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      createdById: ctx.userId,
      assignees: mergedAssignees.length > 0
        ? { create: mergedAssignees.map((id) => ({ userId: id })) }
        : undefined,
      labels: input.labelIds.length > 0
        ? { create: input.labelIds.map((id) => ({ labelId: id })) }
        : undefined,
    },
    include: {
      assignees: { include: { user: { select: { id: true, name: true, email: true } } } },
      labels: { include: { label: true } },
    },
  });

  logActivity(db, ctx.userId, {
    type: 'task_created',
    message: `created task "${task.title}" in ${column.board.project.name}`,
    entityType: 'Task',
    entityId: task.id,
  });

  return NextResponse.json({ data: task }, { status: 201 });
});
