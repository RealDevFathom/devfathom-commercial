import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { TRPCError } from '@trpc/server';
import { logActivity } from '../activity';
import { appUrl, templates } from '@/lib/email';
import { notify } from '@/lib/notifications';
import {
  assertProjectAccess,
  assertBoardAccess,
  assertColumnAccess,
  assertTaskAccess,
} from '../authz';

// Format a task due date for emails, e.g. "Fri, Jun 20 · 5:00 PM".
function formatDue(date: Date): string {
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Build the deep link to a task on its board.
function taskUrl(projectId: string, boardId: string, taskId: string): string {
  return `${appUrl()}/projects/${projectId}/board/${boardId}?task=${taskId}`;
}

export const projectsRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const isAdmin = ctx.session.user.role === 'ADMIN';
    const userId = ctx.session.user.id;

    return ctx.db.project.findMany({
      where: isAdmin ? {} : { members: { some: { userId } } },
      include: {
        client: { select: { id: true, name: true, logo: true } },
        members: {
          include: {
            user: { select: { id: true, name: true, avatar: true, title: true } },
          },
        },
        _count: { select: { boards: true, milestones: true, files: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1, 'Project name is required'),
        description: z.string().optional(),
        type: z.enum(['CLIENT', 'INTERNAL']),
        status: z.enum(['ACTIVE', 'IN_DEVELOPMENT', 'ON_HOLD']).default('ACTIVE'),
        clientId: z.string().optional(),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
        techStack: z.array(z.string()).default([]),
        memberIds: z.array(z.string()).default([]),
        createDefaultBoard: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { memberIds, createDefaultBoard, ...projectData } = input;

      // Always include creator as a member
      const allMemberIds = [...new Set([ctx.session.user.id, ...memberIds])];

      const project = await ctx.db.project.create({
        data: {
          ...projectData,
          clientId: projectData.clientId || null,
          members: {
            create: allMemberIds.map((userId, i) => ({
              userId,
              role: i === 0 ? 'LEAD' : 'MEMBER',
            })),
          },
        },
      });

      // Create a default board with standard columns
      if (createDefaultBoard) {
        await ctx.db.board.create({
          data: {
            name: `${project.name} Board`,
            projectId: project.id,
            columns: {
              create: ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'].map((name, order) => ({
                name,
                order,
              })),
            },
            labels: {
              create: [
                { name: 'Bug', color: '#EF4444' },
                { name: 'Feature', color: '#2563EB' },
                { name: 'Enhancement', color: '#0EA5E9' },
                { name: 'Design', color: '#F59E0B' },
                { name: 'Urgent', color: '#DC2626' },
              ],
            },
          },
        });
      }

      logActivity(ctx.db, ctx.session.user.id, {
        type: 'project_created',
        message: `created project ${project.name}`,
        entityType: 'Project',
        entityId: project.id,
      });

      return project;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        status: z
          .enum(['ACTIVE', 'IN_DEVELOPMENT', 'ON_HOLD', 'COMPLETED', 'CANCELLED'])
          .optional(),
        startDate: z.date().nullable().optional(),
        endDate: z.date().nullable().optional(),
        techStack: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      await assertProjectAccess(ctx, id);
      const project = await ctx.db.project.update({ where: { id }, data });
      logActivity(ctx.db, ctx.session.user.id, {
        type: 'project_updated',
        message:
          input.status === 'COMPLETED'
            ? `marked project ${project.name} as completed`
            : `updated project ${project.name}`,
        entityType: 'Project',
        entityId: project.id,
      });
      return project;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertProjectAccess(ctx, input.id, { manage: true });
      const project = await ctx.db.project.findUnique({
        where: { id: input.id },
        select: { name: true },
      });
      const deleted = await ctx.db.project.delete({ where: { id: input.id } });
      if (project) {
        logActivity(ctx.db, ctx.session.user.id, {
          type: 'project_deleted',
          message: `deleted project ${project.name}`,
        });
      }
      return deleted;
    }),

  // ============ PROJECT MEMBERS ============

  /**
   * Add a team member to an existing project.
   * Only the project LEAD or an ADMIN may add members.
   */
  addMember: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        userId: z.string(),
        role: z.enum(['LEAD', 'MEMBER']).default('MEMBER'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const isAdmin = ctx.session.user.role === 'ADMIN';
      const callerMembership = await ctx.db.projectMember.findUnique({
        where: { projectId_userId: { projectId: input.projectId, userId: ctx.session.user.id } },
      });
      if (!isAdmin && callerMembership?.role !== 'LEAD') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the project lead or an admin can add members.',
        });
      }

      // Idempotent — if already a member, just update the role
      const membership = await ctx.db.projectMember.upsert({
        where: { projectId_userId: { projectId: input.projectId, userId: input.userId } },
        create: { projectId: input.projectId, userId: input.userId, role: input.role },
        update: { role: input.role },
      });
      const [project, targetUser] = await Promise.all([
        ctx.db.project.findUnique({ where: { id: input.projectId }, select: { name: true } }),
        ctx.db.user.findUnique({ where: { id: input.userId }, select: { name: true } }),
      ]);
      if (project && targetUser) {
        logActivity(ctx.db, ctx.session.user.id, {
          type: 'project_member_added',
          message: `added ${targetUser.name} to ${project.name}`,
          entityType: 'Project',
          entityId: input.projectId,
        });
      }
      return membership;
    }),

  /**
   * Remove a member from a project.
   * Rules:
   * - Project LEAD or ADMIN can remove anyone
   * - A member can remove themselves
   * - Cannot remove the last remaining LEAD
   */
  removeMember: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        userId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const isAdmin = ctx.session.user.role === 'ADMIN';
      const isSelf = input.userId === ctx.session.user.id;

      const [target, callerMembership, leadCount] = await Promise.all([
        ctx.db.projectMember.findUnique({
          where: { projectId_userId: { projectId: input.projectId, userId: input.userId } },
        }),
        ctx.db.projectMember.findUnique({
          where: { projectId_userId: { projectId: input.projectId, userId: ctx.session.user.id } },
        }),
        ctx.db.projectMember.count({
          where: { projectId: input.projectId, role: 'LEAD' },
        }),
      ]);

      if (!target)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not on this project.' });

      const callerIsLead = callerMembership?.role === 'LEAD';
      if (!isAdmin && !callerIsLead && !isSelf) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the project lead or an admin can remove other members.',
        });
      }

      if (target.role === 'LEAD' && leadCount <= 1) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot remove the last lead. Promote another member to lead first.',
        });
      }

      await ctx.db.projectMember.delete({
        where: { projectId_userId: { projectId: input.projectId, userId: input.userId } },
      });
      const [project, targetUser] = await Promise.all([
        ctx.db.project.findUnique({ where: { id: input.projectId }, select: { name: true } }),
        ctx.db.user.findUnique({ where: { id: input.userId }, select: { name: true } }),
      ]);
      if (project && targetUser) {
        logActivity(ctx.db, ctx.session.user.id, {
          type: 'project_member_removed',
          message: isSelf
            ? `left project ${project.name}`
            : `removed ${targetUser.name} from ${project.name}`,
          entityType: 'Project',
          entityId: input.projectId,
        });
      }
      return { success: true };
    }),

  /**
   * Promote / demote a member between LEAD and MEMBER.
   * Only an existing LEAD or ADMIN can change roles.
   */
  setMemberRole: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        userId: z.string(),
        role: z.enum(['LEAD', 'MEMBER']),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const isAdmin = ctx.session.user.role === 'ADMIN';
      const callerMembership = await ctx.db.projectMember.findUnique({
        where: { projectId_userId: { projectId: input.projectId, userId: ctx.session.user.id } },
      });
      if (!isAdmin && callerMembership?.role !== 'LEAD') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the project lead or an admin can change roles.',
        });
      }

      // Block demoting the last lead
      if (input.role === 'MEMBER') {
        const leadCount = await ctx.db.projectMember.count({
          where: { projectId: input.projectId, role: 'LEAD' },
        });
        const target = await ctx.db.projectMember.findUnique({
          where: { projectId_userId: { projectId: input.projectId, userId: input.userId } },
        });
        if (target?.role === 'LEAD' && leadCount <= 1) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot demote the last lead. Promote another member first.',
          });
        }
      }

      return ctx.db.projectMember.update({
        where: { projectId_userId: { projectId: input.projectId, userId: input.userId } },
        data: { role: input.role },
      });
    }),

  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    await assertProjectAccess(ctx, input.id);
    return ctx.db.project.findUnique({
      where: { id: input.id },
      include: {
        client: { select: { name: true, website: true } },
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                avatar: true,
                title: true,
                department: true,
              },
            },
          },
        },
        boards: {
          include: {
            columns: {
              orderBy: { order: 'asc' },
              include: { _count: { select: { tasks: true } } },
            },
          },
        },
        milestones: { orderBy: { dueDate: 'asc' } },
        files: {
          include: { uploadedBy: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }),

  getBoardWithTasks: protectedProcedure
    .input(z.object({ boardId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertBoardAccess(ctx, input.boardId);
      return ctx.db.board.findUnique({
        where: { id: input.boardId },
        include: {
          project: {
            select: {
              id: true,
              name: true,
              members: {
                include: {
                  user: { select: { id: true, name: true, avatar: true, title: true } },
                },
              },
            },
          },
          labels: true,
          columns: {
            orderBy: { order: 'asc' },
            include: {
              // Owners of the column — auto-assigned to any task entering it
              defaultAssignees: {
                include: {
                  user: { select: { id: true, name: true, avatar: true, title: true } },
                },
              },
              tasks: {
                orderBy: { order: 'asc' },
                include: {
                  assignees: {
                    include: { user: { select: { id: true, name: true, avatar: true } } },
                  },
                  labels: { include: { label: true } },
                  checklists: {
                    include: { items: { select: { completed: true } } },
                  },
                  _count: { select: { comments: true, attachments: true, checklists: true } },
                },
              },
            },
          },
        },
      });
    }),

  /**
   * Replace the set of default assignees ("owners") for a column.
   * When a task enters this column, each of these users is automatically
   * added to the task's assignees (additively, via skipDuplicates).
   * LEAD or ADMIN only.
   */
  setColumnDefaultAssignees: protectedProcedure
    .input(
      z.object({
        columnId: z.string(),
        userIds: z.array(z.string()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const isAdmin = ctx.session.user.role === 'ADMIN';

      // Look up the project via column → board → project for the permission check
      const column = await ctx.db.column.findUnique({
        where: { id: input.columnId },
        select: { board: { select: { projectId: true } } },
      });
      if (!column) throw new TRPCError({ code: 'NOT_FOUND' });

      if (!isAdmin) {
        const membership = await ctx.db.projectMember.findUnique({
          where: {
            projectId_userId: {
              projectId: column.board.projectId,
              userId: ctx.session.user.id,
            },
          },
        });
        if (membership?.role !== 'LEAD') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only the project lead or an admin can set column owners.',
          });
        }
      }

      // Also verify all userIds are actual project members — can't assign
      // someone to a column if they aren't on the project.
      if (input.userIds.length > 0) {
        const memberCount = await ctx.db.projectMember.count({
          where: {
            projectId: column.board.projectId,
            userId: { in: input.userIds },
          },
        });
        if (memberCount !== input.userIds.length) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'All column owners must be members of the project.',
          });
        }
      }

      await ctx.db.$transaction([
        ctx.db.columnDefaultAssignee.deleteMany({
          where: { columnId: input.columnId },
        }),
        ...(input.userIds.length > 0
          ? [
              ctx.db.columnDefaultAssignee.createMany({
                data: input.userIds.map((userId) => ({ columnId: input.columnId, userId })),
                skipDuplicates: true,
              }),
            ]
          : []),
      ]);

      return { success: true };
    }),

  // ============ TASK MUTATIONS ============

  createTask: protectedProcedure
    .input(
      z.object({
        title: z.string().min(1),
        columnId: z.string(),
        description: z.string().optional(),
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
        dueDate: z.date().optional(),
        assigneeIds: z.array(z.string()).default([]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertColumnAccess(ctx, input.columnId);
      // Verify user exists (handles stale sessions after DB reset)
      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
        select: { id: true, name: true },
      });
      if (!user)
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Session expired. Please log out and log back in.',
        });

      const maxOrder = await ctx.db.task.aggregate({
        _max: { order: true },
        where: { columnId: input.columnId },
      });

      // Fetch column's default assignees so we can auto-add them to the new task.
      const columnDefaults = await ctx.db.columnDefaultAssignee.findMany({
        where: { columnId: input.columnId },
        select: { userId: true },
      });
      const mergedAssignees = [
        ...new Set([...input.assigneeIds, ...columnDefaults.map((d) => d.userId)]),
      ];

      const task = await ctx.db.task.create({
        data: {
          title: input.title,
          description: input.description,
          columnId: input.columnId,
          order: (maxOrder._max.order ?? -1) + 1,
          priority: input.priority,
          dueDate: input.dueDate,
          createdById: user.id,
          assignees:
            mergedAssignees.length > 0
              ? { create: mergedAssignees.map((id) => ({ userId: id })) }
              : undefined,
        },
        include: {
          column: {
            select: {
              board: {
                select: { id: true, name: true, project: { select: { id: true, name: true } } },
              },
            },
          },
          assignees: { include: { user: { select: { id: true, name: true, avatar: true } } } },
          labels: { include: { label: true } },
          _count: { select: { comments: true, attachments: true, checklists: true } },
        },
      });
      const board = task.column.board;
      const projectName = board.project.name;
      logActivity(ctx.db, ctx.session.user.id, {
        type: 'task_created',
        message: `created task "${task.title}" in ${projectName}`,
        entityType: 'Task',
        entityId: task.id,
      });

      // Notify assignees added at creation (everyone except the creator).
      const newAssignees = mergedAssignees.filter((id) => id !== user.id);
      if (newAssignees.length > 0) {
        const url = taskUrl(board.project.id, board.id, task.id);
        const dueDate = task.dueDate ? formatDue(task.dueDate) : undefined;
        notify(ctx.db, newAssignees, {
          type: 'task_assigned',
          title: 'New task assigned',
          message: `${user.name} assigned you “${task.title}” in ${projectName}`,
          entityType: 'Task',
          entityId: task.id,
          email: (r) =>
            templates.taskAssigned({
              assigneeName: r.name,
              taskTitle: task.title,
              projectName,
              boardName: board.name,
              priority: task.priority,
              dueDate,
              assignedByName: user.name,
              description: task.description ?? undefined,
              url,
            }),
        });
      }
      return task;
    }),

  updateTask: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
        dueDate: z.date().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      await assertTaskAccess(ctx, id);
      return ctx.db.task.update({
        where: { id },
        data,
      });
    }),

  deleteTask: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertTaskAccess(ctx, input.id);
      return ctx.db.task.delete({ where: { id: input.id } });
    }),

  moveTask: protectedProcedure
    .input(
      z.object({
        taskId: z.string(),
        targetColumnId: z.string(),
        newOrder: z.number(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertTaskAccess(ctx, input.taskId);
      // Also verify access to the destination column's project (cross-board moves).
      await assertColumnAccess(ctx, input.targetColumnId);
      const task = await ctx.db.task.findUnique({
        where: { id: input.taskId },
        include: { column: { select: { name: true } } },
      });
      if (!task) throw new TRPCError({ code: 'NOT_FOUND' });

      const sourceColumnId = task.columnId;
      const isSameColumn = sourceColumnId === input.targetColumnId;

      await ctx.db.$transaction(async (tx) => {
        if (isSameColumn) {
          // Reorder within same column
          const oldOrder = task.order;
          const newOrder = input.newOrder;

          if (oldOrder < newOrder) {
            await tx.task.updateMany({
              where: { columnId: sourceColumnId, order: { gt: oldOrder, lte: newOrder } },
              data: { order: { decrement: 1 } },
            });
          } else {
            await tx.task.updateMany({
              where: { columnId: sourceColumnId, order: { gte: newOrder, lt: oldOrder } },
              data: { order: { increment: 1 } },
            });
          }
        } else {
          // Moving to different column
          // Close gap in source column
          await tx.task.updateMany({
            where: { columnId: sourceColumnId, order: { gt: task.order } },
            data: { order: { decrement: 1 } },
          });
          // Make room in target column
          await tx.task.updateMany({
            where: { columnId: input.targetColumnId, order: { gte: input.newOrder } },
            data: { order: { increment: 1 } },
          });
        }

        // Move the task
        await tx.task.update({
          where: { id: input.taskId },
          data: { columnId: input.targetColumnId, order: input.newOrder },
        });

        // Auto-assign default assignees of the target column (additive).
        // Only runs when actually crossing columns, not when reordering within the same column.
        if (!isSameColumn) {
          const defaults = await tx.columnDefaultAssignee.findMany({
            where: { columnId: input.targetColumnId },
            select: { userId: true },
          });
          if (defaults.length > 0) {
            await tx.taskAssignee.createMany({
              data: defaults.map((d) => ({ taskId: input.taskId, userId: d.userId })),
              skipDuplicates: true, // already-assigned users become a no-op
            });
          }
        }
      });

      // Log completion when a task enters the Done column (and wasn't already there)
      const targetColumn = await ctx.db.column.findUnique({
        where: { id: input.targetColumnId },
        select: {
          name: true,
          board: { select: { project: { select: { id: true, name: true } } } },
        },
      });
      if (targetColumn?.name === 'Done' && task.column.name !== 'Done') {
        logActivity(ctx.db, ctx.session.user.id, {
          type: 'task_completed',
          message: `completed task "${task.title}" in ${targetColumn.board.project.name}`,
          entityType: 'Task',
          entityId: input.taskId,
        });
      }

      return { success: true };
    }),

  // ============ BOARD MUTATIONS ============

  createBoard: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1, 'Board name is required'),
        description: z.string().optional(),
        createDefaultColumns: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertProjectAccess(ctx, input.projectId);
      return ctx.db.board.create({
        data: {
          name: input.name,
          description: input.description,
          projectId: input.projectId,
          columns: input.createDefaultColumns
            ? {
                create: ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'].map(
                  (name, order) => ({ name, order })
                ),
              }
            : undefined,
          labels: input.createDefaultColumns
            ? {
                create: [
                  { name: 'Bug', color: '#EF4444' },
                  { name: 'Feature', color: '#2563EB' },
                  { name: 'Enhancement', color: '#0EA5E9' },
                  { name: 'Design', color: '#F59E0B' },
                  { name: 'Urgent', color: '#DC2626' },
                ],
              }
            : undefined,
        },
      });
    }),

  deleteBoard: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertBoardAccess(ctx, input.id, { manage: true });
      return ctx.db.board.delete({ where: { id: input.id } });
    }),

  // ============ COLUMN MUTATIONS ============

  reorderColumns: protectedProcedure
    .input(
      z.object({
        boardId: z.string(),
        columnId: z.string(),
        newOrder: z.number(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertBoardAccess(ctx, input.boardId);
      const column = await ctx.db.column.findUnique({ where: { id: input.columnId } });
      // Ensure the column actually belongs to the board the caller is authorized
      // for — otherwise a member of board A could reorder a column in board B.
      if (!column || column.boardId !== input.boardId) throw new TRPCError({ code: 'NOT_FOUND' });

      const oldOrder = column.order;
      const newOrder = input.newOrder;

      if (oldOrder === newOrder) return { success: true };

      await ctx.db.$transaction(async (tx) => {
        if (oldOrder < newOrder) {
          await tx.column.updateMany({
            where: { boardId: input.boardId, order: { gt: oldOrder, lte: newOrder } },
            data: { order: { decrement: 1 } },
          });
        } else {
          await tx.column.updateMany({
            where: { boardId: input.boardId, order: { gte: newOrder, lt: oldOrder } },
            data: { order: { increment: 1 } },
          });
        }

        await tx.column.update({
          where: { id: input.columnId },
          data: { order: newOrder },
        });
      });

      return { success: true };
    }),

  createColumn: protectedProcedure
    .input(
      z.object({
        boardId: z.string(),
        name: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertBoardAccess(ctx, input.boardId);
      const maxOrder = await ctx.db.column.aggregate({
        _max: { order: true },
        where: { boardId: input.boardId },
      });

      return ctx.db.column.create({
        data: {
          name: input.name,
          boardId: input.boardId,
          order: (maxOrder._max.order ?? -1) + 1,
        },
      });
    }),

  updateColumn: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertColumnAccess(ctx, input.id);
      return ctx.db.column.update({
        where: { id: input.id },
        data: { name: input.name },
      });
    }),

  deleteColumn: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertColumnAccess(ctx, input.id, { manage: true });
      return ctx.db.column.delete({ where: { id: input.id } });
    }),

  // ============ TASK DETAIL ============

  getTaskDetail: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertTaskAccess(ctx, input.id);
      return ctx.db.task.findUnique({
        where: { id: input.id },
        include: {
          column: {
            select: {
              id: true,
              name: true,
              board: { select: { id: true, name: true, projectId: true } },
            },
          },
          createdBy: { select: { id: true, name: true, avatar: true } },
          assignees: {
            include: { user: { select: { id: true, name: true, avatar: true, title: true } } },
          },
          labels: { include: { label: true } },
          checklists: {
            orderBy: { order: 'asc' },
            include: { items: { orderBy: { order: 'asc' } } },
          },
          comments: {
            where: { parentId: null },
            orderBy: { createdAt: 'asc' },
            include: {
              user: { select: { id: true, name: true, avatar: true } },
              replies: {
                orderBy: { createdAt: 'asc' },
                include: { user: { select: { id: true, name: true, avatar: true } } },
              },
            },
          },
          attachments: { orderBy: { createdAt: 'desc' } },
        },
      });
    }),

  addComment: protectedProcedure
    .input(
      z.object({
        taskId: z.string(),
        content: z.string().min(1),
        parentId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertTaskAccess(ctx, input.taskId);
      return ctx.db.taskComment.create({
        data: {
          content: input.content,
          taskId: input.taskId,
          userId: ctx.session.user.id,
          parentId: input.parentId,
        },
        include: {
          user: { select: { id: true, name: true, avatar: true } },
        },
      });
    }),

  toggleChecklistItem: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        completed: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Resolve the owning task (checklist item → checklist → task) for the access check.
      const item = await ctx.db.taskChecklistItem.findUnique({
        where: { id: input.id },
        select: { checklist: { select: { taskId: true } } },
      });
      if (!item) throw new TRPCError({ code: 'NOT_FOUND' });
      await assertTaskAccess(ctx, item.checklist.taskId);
      return ctx.db.taskChecklistItem.update({
        where: { id: input.id },
        data: { completed: input.completed },
      });
    }),

  updateTaskAssignees: protectedProcedure
    .input(
      z.object({
        taskId: z.string(),
        assigneeIds: z.array(z.string()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertTaskAccess(ctx, input.taskId);
      // Capture who was already assigned so we only email the *newly* added.
      const existing = await ctx.db.taskAssignee.findMany({
        where: { taskId: input.taskId },
        select: { userId: true },
      });
      const existingIds = new Set(existing.map((e) => e.userId));

      await ctx.db.taskAssignee.deleteMany({ where: { taskId: input.taskId } });
      if (input.assigneeIds.length > 0) {
        await ctx.db.taskAssignee.createMany({
          data: input.assigneeIds.map((userId) => ({ taskId: input.taskId, userId })),
        });
      }

      // Email teammates newly assigned — never the actor, never re-notify.
      const added = input.assigneeIds.filter(
        (id) => !existingIds.has(id) && id !== ctx.session.user.id
      );
      if (added.length > 0) {
        const task = await ctx.db.task.findUnique({
          where: { id: input.taskId },
          include: {
            column: {
              select: {
                board: {
                  select: { id: true, name: true, project: { select: { id: true, name: true } } },
                },
              },
            },
          },
        });
        if (task) {
          const board = task.column.board;
          const url = taskUrl(board.project.id, board.id, task.id);
          const dueDate = task.dueDate ? formatDue(task.dueDate) : undefined;
          notify(ctx.db, added, {
            type: 'task_assigned',
            title: 'New task assigned',
            message: `${ctx.session.user.name} assigned you “${task.title}” in ${board.project.name}`,
            entityType: 'Task',
            entityId: task.id,
            email: (r) =>
              templates.taskAssigned({
                assigneeName: r.name,
                taskTitle: task.title,
                projectName: board.project.name,
                boardName: board.name,
                priority: task.priority,
                dueDate,
                assignedByName: ctx.session.user.name,
                description: task.description ?? undefined,
                url,
              }),
          });
        }
      }

      return { success: true };
    }),

  // ============ MILESTONES ============

  createMilestone: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1),
        description: z.string().optional(),
        dueDate: z.date(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertProjectAccess(ctx, input.projectId);
      return ctx.db.milestone.create({ data: input });
    }),

  updateMilestone: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        dueDate: z.date().optional(),
        completedAt: z.date().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const milestone = await ctx.db.milestone.findUnique({
        where: { id },
        select: { projectId: true },
      });
      if (!milestone) throw new TRPCError({ code: 'NOT_FOUND' });
      await assertProjectAccess(ctx, milestone.projectId);
      return ctx.db.milestone.update({ where: { id }, data });
    }),

  deleteMilestone: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const milestone = await ctx.db.milestone.findUnique({
        where: { id: input.id },
        select: { projectId: true },
      });
      if (!milestone) throw new TRPCError({ code: 'NOT_FOUND' });
      await assertProjectAccess(ctx, milestone.projectId);
      return ctx.db.milestone.delete({ where: { id: input.id } });
    }),

  // ============ LABELS ============

  getBoardLabels: protectedProcedure
    .input(z.object({ boardId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertBoardAccess(ctx, input.boardId);
      return ctx.db.label.findMany({
        where: { boardId: input.boardId },
        orderBy: { name: 'asc' },
      });
    }),

  createLabel: protectedProcedure
    .input(
      z.object({
        boardId: z.string(),
        name: z.string().min(1),
        color: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertBoardAccess(ctx, input.boardId);
      return ctx.db.label.create({
        data: { name: input.name, color: input.color, boardId: input.boardId },
      });
    }),

  addLabelToTask: protectedProcedure
    .input(z.object({ taskId: z.string(), labelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertTaskAccess(ctx, input.taskId);
      return ctx.db.taskLabel.create({
        data: { taskId: input.taskId, labelId: input.labelId },
      });
    }),

  removeLabelFromTask: protectedProcedure
    .input(z.object({ taskId: z.string(), labelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertTaskAccess(ctx, input.taskId);
      await ctx.db.taskLabel.deleteMany({
        where: { taskId: input.taskId, labelId: input.labelId },
      });
      return { success: true };
    }),
});
