import { z } from 'zod';
import { hash, compare } from 'bcryptjs';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, adminProcedure } from '../trpc';
import { assertNotificationOwner } from '../authz';
import { appUrl, templates } from '@/lib/email';
import { notify } from '@/lib/notifications';

// "LEADERSHIP" → "Leadership", "ADMIN" → "Admin".
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

// Strong password policy shared by every mutation that sets a password
// (createMember, changePassword, adminResetPassword): at least 12 characters
// with lowercase, uppercase, and a digit.
const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters long')
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[0-9]/, 'Password must include a number');

export const teamRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        title: true,
        avatar: true,
        phone: true,
        bio: true,
        skills: true,
        startDate: true,
        status: true,
        lastActiveAt: true,
        _count: { select: { assignedTasks: true, projectMembers: true } },
      },
      orderBy: { name: 'asc' },
    });
  }),

  createMember: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
        password: passwordSchema,
        role: z.enum(['ADMIN', 'EMPLOYEE']).default('EMPLOYEE'),
        department: z.enum([
          'LEADERSHIP',
          'ENGINEERING',
          'PRODUCT',
          'QUALITY',
          'MARKETING',
          'DESIGN',
        ]),
        title: z.string().min(1),
        phone: z.string().optional(),
        bio: z.string().optional(),
        skills: z.array(z.string()).default([]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.user.findUnique({ where: { email: input.email } });
      if (existing)
        throw new TRPCError({ code: 'CONFLICT', message: 'A user with this email already exists' });

      const hashed = await hash(input.password, 12);
      const created = await ctx.db.user.create({
        data: {
          ...input,
          password: hashed,
        },
      });

      // Welcome the new member with their sign-in details.
      notify(ctx.db, [created.id], {
        type: 'user_welcome',
        title: 'Welcome to DevFathom',
        message: 'Your DevFathom account has been created.',
        entityType: 'User',
        entityId: created.id,
        email: (r) =>
          templates.welcome({
            name: r.name,
            workspace: 'DevFathom',
            role: `${titleCase(input.role)} · ${titleCase(input.department)}`,
            email: r.email,
            tempPassword: input.password,
            loginUrl: `${appUrl()}/login`,
            inviterName: ctx.session.user.name,
          }),
      });

      return created;
    }),

  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const isAdmin = ctx.session.user.role === 'ADMIN';
    const isSelf = ctx.session.user.id === input.id;

    return ctx.db.user.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        title: true,
        avatar: true,
        phone: true,
        bio: true,
        skills: true,
        startDate: true,
        status: true,
        lastActiveAt: true,
        projectMembers: {
          include: { project: { select: { id: true, name: true, status: true, type: true } } },
        },
        assignedTasks: {
          include: {
            task: {
              select: {
                id: true,
                title: true,
                priority: true,
                dueDate: true,
                column: { select: { name: true } },
              },
            },
          },
          take: 10,
        },
        leaveRequests:
          isSelf || isAdmin ? { orderBy: { createdAt: 'desc' as const }, take: 10 } : false,
      },
    });
  }),

  getLeaveRequests: adminProcedure.query(async ({ ctx }) => {
    return ctx.db.leaveRequest.findMany({
      include: {
        user: { select: { id: true, name: true, avatar: true, department: true, title: true } },
        approvedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }),

  createLeaveRequest: protectedProcedure
    .input(
      z.object({
        type: z.enum(['VACATION', 'SICK', 'REMOTE']),
        startDate: z.date(),
        endDate: z.date(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.leaveRequest.create({
        data: { ...input, userId: ctx.session.user.id },
      });
    }),

  updateLeaveStatus: adminProcedure
    .input(
      z.object({
        id: z.string(),
        status: z.enum(['APPROVED', 'REJECTED']),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const leave = await ctx.db.leaveRequest.update({
        where: { id: input.id },
        data: { status: input.status, approvedById: ctx.session.user.id },
      });

      // Let the requester know the decision.
      const displayStatus = input.status === 'REJECTED' ? 'DECLINED' : 'APPROVED';
      const range = `${leave.startDate.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })} – ${leave.endDate.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })}`;
      notify(ctx.db, [leave.userId], {
        type: 'leave_status',
        title: `Time off ${displayStatus.toLowerCase()}`,
        message: `Your ${titleCase(leave.type)} request was ${displayStatus.toLowerCase()}.`,
        entityType: 'LeaveRequest',
        entityId: leave.id,
        email: (r) =>
          templates.leaveRequest({
            recipientName: r.name,
            employeeName: r.name,
            leaveType: titleCase(leave.type),
            rangeLabel: range,
            status: displayStatus,
            url: `${appUrl()}/hr`,
          }),
      });

      return leave;
    }),

  getNotifications: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.notification.findMany({
      where: { userId: ctx.session.user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }),

  markNotificationRead: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertNotificationOwner(ctx, input.id);
      return ctx.db.notification.update({
        where: { id: input.id },
        data: { isRead: true },
      });
    }),

  markAllNotificationsRead: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.notification.updateMany({
      where: { userId: ctx.session.user.id, isRead: false },
      data: { isRead: true },
    });
    return { success: true };
  }),

  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
        phone: z.string().nullable().optional(),
        bio: z.string().nullable().optional(),
        skills: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: input,
      });
    }),

  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: passwordSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
        select: { password: true },
      });
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' });

      const valid = await compare(input.currentPassword, user.password);
      if (!valid)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Current password is incorrect' });

      const hashed = await hash(input.newPassword, 12);
      await ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { password: hashed },
      });
      return { success: true };
    }),

  adminUpdateMember: adminProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        role: z.enum(['ADMIN', 'EMPLOYEE']).optional(),
        department: z
          .enum(['LEADERSHIP', 'ENGINEERING', 'PRODUCT', 'QUALITY', 'MARKETING', 'DESIGN'])
          .optional(),
        title: z.string().min(1).optional(),
        phone: z.string().nullable().optional(),
        bio: z.string().nullable().optional(),
        skills: z.array(z.string()).optional(),
        status: z.enum(['ACTIVE', 'INACTIVE', 'ON_LEAVE']).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      return ctx.db.user.update({ where: { id }, data });
    }),

  adminResetPassword: adminProcedure
    .input(
      z.object({
        id: z.string(),
        newPassword: passwordSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const hashed = await hash(input.newPassword, 12);
      await ctx.db.user.update({
        where: { id: input.id },
        data: { password: hashed },
      });
      return { success: true };
    }),

  deactivateMember: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (input.id === ctx.session.user.id) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot deactivate yourself' });
      }
      return ctx.db.user.update({
        where: { id: input.id },
        data: { status: 'INACTIVE' },
      });
    }),

  // Performance notes — admin-authored feedback on a team member.
  // Readable by admins or by the subject themselves; writable by admins only.
  listPerformanceNotes: protectedProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ ctx, input }) => {
      const isAdmin = ctx.session.user.role === 'ADMIN';
      const isSelf = ctx.session.user.id === input.userId;
      if (!isAdmin && !isSelf) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      return ctx.db.performanceNote.findMany({
        where: { userId: input.userId },
        include: { author: { select: { id: true, name: true, avatar: true } } },
        orderBy: { createdAt: 'desc' },
      });
    }),

  addPerformanceNote: adminProcedure
    .input(
      z.object({
        userId: z.string(),
        content: z.string().min(1).max(4000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.performanceNote.create({
        data: {
          userId: input.userId,
          authorId: ctx.session.user.id,
          content: input.content,
        },
      });
    }),

  deletePerformanceNote: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const note = await ctx.db.performanceNote.findUnique({ where: { id: input.id } });
      if (!note) throw new TRPCError({ code: 'NOT_FOUND' });
      if (note.authorId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You can only delete your own notes' });
      }
      return ctx.db.performanceNote.delete({ where: { id: input.id } });
    }),

  // HR overview — dashboard stats for the HR landing page.
  getHrOverview: adminProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const thirtyDaysAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [outToday, pendingLeave, pendingLeaveTotal, recentHires, allActive] = await Promise.all([
      ctx.db.leaveRequest.findMany({
        where: {
          status: 'APPROVED',
          startDate: { lte: todayEnd },
          endDate: { gte: todayStart },
        },
        include: { user: { select: { id: true, name: true, avatar: true, title: true } } },
        orderBy: { endDate: 'asc' },
      }),
      ctx.db.leaveRequest.findMany({
        where: { status: 'PENDING' },
        include: { user: { select: { id: true, name: true, avatar: true, title: true } } },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      ctx.db.leaveRequest.count({ where: { status: 'PENDING' } }),
      ctx.db.user.findMany({
        where: { startDate: { gte: thirtyDaysAgo }, status: { not: 'INACTIVE' } },
        select: {
          id: true,
          name: true,
          avatar: true,
          title: true,
          department: true,
          startDate: true,
        },
        orderBy: { startDate: 'desc' },
      }),
      ctx.db.user.findMany({
        where: { status: { not: 'INACTIVE' } },
        select: { id: true, name: true, avatar: true, title: true, startDate: true },
      }),
    ]);

    // Upcoming work anniversaries in the next 30 days (any year >= 1 year tenure).
    const upcomingAnniversaries = allActive
      .map((u) => {
        const start = new Date(u.startDate);
        const thisYear = new Date(now.getFullYear(), start.getMonth(), start.getDate());
        const nextOccurrence =
          thisYear >= todayStart
            ? thisYear
            : new Date(now.getFullYear() + 1, start.getMonth(), start.getDate());
        const years = nextOccurrence.getFullYear() - start.getFullYear();
        return { ...u, anniversaryDate: nextOccurrence, years };
      })
      .filter((u) => u.years >= 1 && u.anniversaryDate <= thirtyDaysAhead)
      .sort((a, b) => a.anniversaryDate.getTime() - b.anniversaryDate.getTime())
      .slice(0, 5);

    return {
      outToday,
      pendingLeave,
      pendingLeaveTotal,
      recentHires,
      upcomingAnniversaries,
      activeHeadcount: allActive.length,
    };
  }),
});
