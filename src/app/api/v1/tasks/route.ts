import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiAuth } from '@/lib/api-auth';
import { canAccessProject } from '@/lib/authz';
import { logActivity } from '@/server/activity';
import { readJson } from '@/lib/api-json';
import { isDoneColumn } from '@/lib/tasks/completion';

// GET /api/v1/tasks?columnId=&assigneeId=&priority=
export const GET = withApiAuth('tasks:read', async (ctx, request) => {
  const url = new URL(request.url);
  const columnId = url.searchParams.get('columnId');
  const assigneeId = url.searchParams.get('assigneeId');
  const priority = url.searchParams.get('priority');
  // REST-06: NaN-safe — `?limit=abc` must not reach Prisma as take:NaN (→ 500).
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1),
    100
  );
  const cursor = url.searchParams.get('cursor'); // REST-02: cursor pagination

  const where: Record<string, unknown> = {};
  if (columnId) where.columnId = columnId;
  if (assigneeId) where.assignees = { some: { userId: assigneeId } };
  if (priority) where.priority = priority;
  // Object-level scoping: non-admins only see tasks in projects they belong to.
  if (ctx.userRole !== 'ADMIN') {
    where.column = { board: { project: { members: { some: { userId: ctx.userId } } } } };
  }

  // REST-02: fetch one extra row to know whether there's a next page, then return
  // a consistent { data, nextCursor } envelope.
  const rows = await ctx.db.task.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: 'desc' },
    include: {
      column: {
        select: { id: true, name: true, board: { select: { id: true, projectId: true } } },
      },
      assignees: { include: { user: { select: { id: true, name: true, email: true } } } },
      labels: { include: { label: true } },
    },
  });

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? data[data.length - 1].id : null;
  return NextResponse.json({ data, nextCursor });
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
  // REST-05: malformed JSON → clean 400, not a generic 500.
  const json = await readJson(request);
  if (!json.ok) return json.response;
  const parsed = createTaskSchema.safeParse(json.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.issues },
      { status: 400 }
    );
  }

  const input = parsed.data;

  // Verify column exists and grab its project for activity logging
  const column = await ctx.db.column.findUnique({
    where: { id: input.columnId },
    include: {
      board: { select: { project: { select: { id: true, name: true } } } },
      defaultAssignees: { select: { userId: true } },
    },
  });
  if (!column) return NextResponse.json({ error: 'Column not found' }, { status: 404 });

  // Object-level authz: the acting user must be able to access the column's project.
  if (!(await canAccessProject(ctx.db, ctx.userId, ctx.userRole, column.board.project.id))) {
    return NextResponse.json({ error: 'You do not have access to that project.' }, { status: 403 });
  }

  // REST-07: validate referenced FKs exist BEFORE the create, so a bad assignee/
  // label id is a clean 400 instead of a raw Prisma FK violation (500).
  if (input.assigneeIds.length > 0) {
    const found = await ctx.db.user.count({ where: { id: { in: input.assigneeIds } } });
    if (found !== new Set(input.assigneeIds).size) {
      return NextResponse.json({ error: 'One or more assigneeIds do not exist.' }, { status: 400 });
    }
  }
  if (input.labelIds.length > 0) {
    const found = await ctx.db.label.count({ where: { id: { in: input.labelIds } } });
    if (found !== new Set(input.labelIds).size) {
      return NextResponse.json({ error: 'One or more labelIds do not exist.' }, { status: 400 });
    }
  }

  const maxOrder = await ctx.db.task.aggregate({
    _max: { order: true },
    where: { columnId: input.columnId },
  });

  // Merge explicit assignees with the column's default owners (deduped)
  const mergedAssignees = [
    ...new Set([...input.assigneeIds, ...column.defaultAssignees.map((d) => d.userId)]),
  ];

  const task = await ctx.db.task.create({
    data: {
      title: input.title,
      description: input.description,
      columnId: input.columnId,
      order: (maxOrder._max.order ?? -1) + 1,
      priority: input.priority,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      createdById: ctx.userId,
      completedAt: isDoneColumn(column.name) ? new Date() : null,
      assignees:
        mergedAssignees.length > 0
          ? { create: mergedAssignees.map((id) => ({ userId: id })) }
          : undefined,
      labels:
        input.labelIds.length > 0
          ? { create: input.labelIds.map((id) => ({ labelId: id })) }
          : undefined,
    },
    include: {
      assignees: { include: { user: { select: { id: true, name: true, email: true } } } },
      labels: { include: { label: true } },
    },
  });

  logActivity(ctx.db, ctx.userId, {
    type: 'task_created',
    message: `created task "${task.title}" in ${column.board.project.name}`,
    entityType: 'Task',
    entityId: task.id,
  });

  return NextResponse.json({ data: task }, { status: 201 });
});
