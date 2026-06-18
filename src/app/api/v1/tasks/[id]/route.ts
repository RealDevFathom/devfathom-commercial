import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';
import { canAccessProject, canManageProject, projectIdOfTask } from '@/lib/authz';
import { logActivity } from '@/server/activity';

export const GET = withApiAuth(
  'tasks:read',
  async (authCtx, _request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const task = await db.task.findUnique({
      where: { id },
      include: {
        column: {
          select: { id: true, name: true, board: { select: { id: true, projectId: true } } },
        },
        assignees: { include: { user: { select: { id: true, name: true, email: true } } } },
        labels: { include: { label: true } },
        checklists: {
          include: { items: { orderBy: { order: 'asc' } } },
          orderBy: { order: 'asc' },
        },
        comments: {
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { id: true, name: true } } },
        },
      },
    });
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    // Object-level authz: the task's owning project must be accessible.
    if (
      !(await canAccessProject(db, authCtx.userId, authCtx.userRole, task.column.board.projectId))
    ) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.json({ data: task });
  }
);

const updateTaskSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
    dueDate: z.string().datetime().nullable().optional(),
    columnId: z.string().optional(),
    // Assignee ops — three flavors:
    //   assigneeIds:       replace the entire assignee list
    //   addAssigneeIds:    add these (skipDuplicates; existing assignees kept)
    //   removeAssigneeIds: remove just these
    // assigneeIds cannot be combined with the add/remove variants.
    assigneeIds: z.array(z.string()).optional(),
    addAssigneeIds: z.array(z.string()).optional(),
    removeAssigneeIds: z.array(z.string()).optional(),
  })
  .refine((d) => !(d.assigneeIds !== undefined && (d.addAssigneeIds || d.removeAssigneeIds)), {
    message: 'assigneeIds (full replace) cannot be combined with addAssigneeIds/removeAssigneeIds',
  });

export const PATCH = withApiAuth(
  'tasks:write',
  async (authCtx, request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = await request.json();
    const parsed = updateTaskSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.issues },
        { status: 400 }
      );
    }

    // Object-level authz: the acting user must be able to write to the task's project.
    const projectId = await projectIdOfTask(db, id);
    if (!projectId) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    if (!(await canAccessProject(db, authCtx.userId, authCtx.userRole, projectId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { assigneeIds, addAssigneeIds, removeAssigneeIds, dueDate, columnId, ...data } =
      parsed.data;

    // Load the existing task so we can detect a column move and reorder properly.
    const existing = await db.task.findUnique({
      where: { id },
      include: { column: { select: { id: true, name: true } } },
    });
    if (!existing) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

    const isColumnMove = columnId !== undefined && columnId !== existing.columnId;

    // Look up target column metadata — needed for defaults + activity logging
    const targetColumn = isColumnMove
      ? await db.column.findUnique({
          where: { id: columnId },
          include: {
            board: { select: { project: { select: { id: true, name: true } } } },
            defaultAssignees: { select: { userId: true } },
          },
        })
      : null;
    if (isColumnMove && !targetColumn) {
      return NextResponse.json({ error: 'Target column not found' }, { status: 404 });
    }

    // Prevent moving a task into a project the acting user cannot access.
    if (
      isColumnMove &&
      targetColumn &&
      !(await canAccessProject(db, authCtx.userId, authCtx.userRole, targetColumn.board.project.id))
    ) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Do the mutation in a transaction so reorder + update + defaults are atomic.
    const updated = await db.$transaction(async (tx) => {
      // Assignee operations — process in order: full replace, then partial add, then partial remove.
      // Mutual exclusivity between full-replace and partials is enforced at schema level.
      if (assigneeIds) {
        await tx.taskAssignee.deleteMany({ where: { taskId: id } });
        if (assigneeIds.length > 0) {
          await tx.taskAssignee.createMany({
            data: assigneeIds.map((userId) => ({ taskId: id, userId })),
          });
        }
      }
      if (addAssigneeIds && addAssigneeIds.length > 0) {
        await tx.taskAssignee.createMany({
          data: addAssigneeIds.map((userId) => ({ taskId: id, userId })),
          skipDuplicates: true, // no-op if already assigned
        });
      }
      if (removeAssigneeIds && removeAssigneeIds.length > 0) {
        await tx.taskAssignee.deleteMany({
          where: { taskId: id, userId: { in: removeAssigneeIds } },
        });
      }

      // Column move: reorder source + target, then move the task to end of target
      let newOrder = existing.order;
      if (isColumnMove && targetColumn) {
        // Close gap in source column
        await tx.task.updateMany({
          where: { columnId: existing.columnId, order: { gt: existing.order } },
          data: { order: { decrement: 1 } },
        });
        // Put task at end of target column
        const maxOrder = await tx.task.aggregate({
          _max: { order: true },
          where: { columnId: targetColumn.id },
        });
        newOrder = (maxOrder._max.order ?? -1) + 1;
      }

      // Apply the primary update
      const task = await tx.task.update({
        where: { id },
        data: {
          ...data,
          ...(dueDate !== undefined && { dueDate: dueDate ? new Date(dueDate) : null }),
          ...(isColumnMove && columnId && { columnId, order: newOrder }),
        },
      });

      // Additive column default assignees on move (skipDuplicates keeps existing intact)
      if (isColumnMove && targetColumn && targetColumn.defaultAssignees.length > 0) {
        await tx.taskAssignee.createMany({
          data: targetColumn.defaultAssignees.map((d) => ({ taskId: id, userId: d.userId })),
          skipDuplicates: true,
        });
      }

      return task;
    });

    // Activity log: task_completed fires only when entering Done from a different column
    if (
      isColumnMove &&
      targetColumn &&
      targetColumn.name === 'Done' &&
      existing.column.name !== 'Done'
    ) {
      logActivity(db, authCtx.userId, {
        type: 'task_completed',
        message: `completed task "${updated.title}" in ${targetColumn.board.project.name}`,
        entityType: 'Task',
        entityId: id,
      });
    }

    return NextResponse.json({ data: updated });
  }
);

export const DELETE = withApiAuth(
  'tasks:write',
  async (authCtx, _request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    // Destructive op: require admin or project LEAD on the task's project.
    const projectId = await projectIdOfTask(db, id);
    if (!projectId) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    if (!(await canManageProject(db, authCtx.userId, authCtx.userRole, projectId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    await db.task.delete({ where: { id } });
    return NextResponse.json({ success: true });
  }
);
