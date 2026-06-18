import { router, protectedProcedure, adminProcedure } from '../trpc';

export const dashboardRouter = router({
  getStats: protectedProcedure.query(async ({ ctx }) => {
    const isAdmin = ctx.session.user.role === 'ADMIN';
    const userId = ctx.session.user.id;

    const [activeProjects, totalTasks, completedTasksThisWeek, pendingLeaves] = await Promise.all([
      ctx.db.project.count({
        where: isAdmin
          ? { status: 'ACTIVE' }
          : {
              members: { some: { userId } },
              status: 'ACTIVE',
            },
      }),
      ctx.db.task.count({
        where: isAdmin
          ? {}
          : {
              assignees: { some: { userId } },
            },
      }),
      ctx.db.task.count({
        where: {
          ...(isAdmin ? {} : { assignees: { some: { userId } } }),
          column: { name: 'Done' },
          updatedAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
      }),
      ctx.db.leaveRequest.count({
        where: { status: 'PENDING' },
      }),
    ]);

    // Admin-only financial stats
    let revenue = 0;
    let expenses = 0;
    let outstandingInvoices = 0;

    if (isAdmin) {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const [incomeResult, expenseResult, outstandingResult] = await Promise.all([
        ctx.db.transaction.aggregate({
          _sum: { amount: true },
          where: { type: 'INCOME', date: { gte: startOfMonth } },
        }),
        ctx.db.transaction.aggregate({
          _sum: { amount: true },
          where: { type: 'EXPENSE', date: { gte: startOfMonth } },
        }),
        ctx.db.invoice.count({
          where: { status: { in: ['SENT', 'OVERDUE'] } },
        }),
      ]);

      revenue = Number(incomeResult._sum.amount || 0);
      expenses = Number(expenseResult._sum.amount || 0);
      outstandingInvoices = outstandingResult;
    }

    return {
      activeProjects,
      totalTasks,
      completedTasksThisWeek,
      pendingLeaves,
      revenue,
      expenses,
      outstandingInvoices,
      isAdmin,
    };
  }),

  getRecentActivity: protectedProcedure.query(async ({ ctx }) => {
    const isAdmin = ctx.session.user.role === 'ADMIN';

    // Hide finance-related activity from non-admins.
    const financeTypes = ['invoice_created', 'invoice_sent', 'invoice_paid', 'transaction_created'];

    return ctx.db.activity.findMany({
      where: isAdmin ? {} : { type: { notIn: financeTypes } },
      take: 20,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, name: true, avatar: true, title: true },
        },
      },
    });
  }),

  getUpcomingDeadlines: protectedProcedure.query(async ({ ctx }) => {
    const isAdmin = ctx.session.user.role === 'ADMIN';
    const userId = ctx.session.user.id;

    return ctx.db.milestone.findMany({
      where: {
        completedAt: null,
        dueDate: { gte: new Date() },
        ...(isAdmin
          ? {}
          : {
              project: { members: { some: { userId } } },
            }),
      },
      take: 10,
      orderBy: { dueDate: 'asc' },
      include: {
        project: {
          select: { id: true, name: true, status: true },
        },
      },
    });
  }),

  getProjectCards: protectedProcedure.query(async ({ ctx }) => {
    const isAdmin = ctx.session.user.role === 'ADMIN';
    const userId = ctx.session.user.id;

    const projects = await ctx.db.project.findMany({
      where: {
        status: { in: ['ACTIVE', 'IN_DEVELOPMENT'] },
        ...(isAdmin ? {} : { members: { some: { userId } } }),
      },
      include: {
        client: { select: { id: true, name: true } },
        members: {
          include: {
            user: { select: { id: true, name: true, avatar: true } },
          },
        },
        _count: {
          select: {
            boards: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // Prisma Decimal is not serializable across the RSC boundary (SSR prefetch →
    // HydrationBoundary). Convert budget to a plain number, like getStats does.
    return projects.map((p) => ({ ...p, budget: p.budget == null ? null : Number(p.budget) }));
  }),

  getMyTasks: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;

    return ctx.db.task.findMany({
      where: {
        assignees: { some: { userId } },
        column: { name: { not: 'Done' } },
      },
      include: {
        column: {
          select: {
            name: true,
            board: { select: { id: true, projectId: true } },
          },
        },
        labels: { include: { label: true } },
        assignees: {
          include: {
            user: { select: { id: true, name: true, avatar: true } },
          },
        },
        _count: { select: { comments: true, checklists: true } },
      },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
      take: 8,
    });
  }),

  getRevenueChart: adminProcedure.query(async ({ ctx }) => {
    const months = 6;

    const monthRanges = [];
    for (let i = months - 1; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      monthRanges.push({ startOfMonth, endOfMonth });
    }

    const results = await Promise.all(
      monthRanges.flatMap(({ startOfMonth, endOfMonth }) => [
        ctx.db.transaction.aggregate({
          _sum: { amount: true },
          where: {
            type: 'INCOME',
            date: { gte: startOfMonth, lte: endOfMonth },
          },
        }),
        ctx.db.transaction.aggregate({
          _sum: { amount: true },
          where: {
            type: 'EXPENSE',
            date: { gte: startOfMonth, lte: endOfMonth },
          },
        }),
      ])
    );

    const data = monthRanges.map(({ startOfMonth }, idx) => {
      const income = results[idx * 2];
      const expense = results[idx * 2 + 1];
      return {
        month: startOfMonth.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        income: Number(income._sum.amount || 0),
        expense: Number(expense._sum.amount || 0),
        profit: Number(income._sum.amount || 0) - Number(expense._sum.amount || 0),
      };
    });

    return data;
  }),
});
