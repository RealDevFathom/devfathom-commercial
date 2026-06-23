import { router, protectedProcedure, adminProcedure } from '../trpc';
import {
  fromCurrencyGroups,
  currenciesPresent,
  type CurrencyAmount,
} from '@/lib/finance/currency';

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

    // Admin-only financial stats. FIN-02: revenue/expenses are per-currency
    // breakdowns (never a single cross-currency "$" sum).
    let revenue: CurrencyAmount[] = [];
    let expenses: CurrencyAmount[] = [];
    let outstandingInvoices = 0;

    if (isAdmin) {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const [incomeResult, expenseResult, outstandingResult] = await Promise.all([
        ctx.db.transaction.groupBy({
          by: ['currency'],
          _sum: { amount: true },
          where: { type: 'INCOME', date: { gte: startOfMonth } },
        }),
        ctx.db.transaction.groupBy({
          by: ['currency'],
          _sum: { amount: true },
          where: { type: 'EXPENSE', date: { gte: startOfMonth } },
        }),
        ctx.db.invoice.count({
          where: { status: { in: ['SENT', 'OVERDUE'] } },
        }),
      ]);

      revenue = fromCurrencyGroups(incomeResult, 'amount');
      expenses = fromCurrencyGroups(expenseResult, 'amount');
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

    // Hide finance-related activity from non-admins. Contracts are admin-only too.
    const financeTypes = [
      'invoice_created',
      'invoice_sent',
      'invoice_paid',
      'transaction_created',
      'contract_created',
      'contract_updated',
      'contract_deleted',
    ];

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

    // FIN-02: group each month by currency so the chart never blends USD + PKR.
    // The client renders one currency series at a time (USD-first by default).
    const results = await Promise.all(
      monthRanges.flatMap(({ startOfMonth, endOfMonth }) => [
        ctx.db.transaction.groupBy({
          by: ['currency'],
          _sum: { amount: true },
          where: { type: 'INCOME', date: { gte: startOfMonth, lte: endOfMonth } },
        }),
        ctx.db.transaction.groupBy({
          by: ['currency'],
          _sum: { amount: true },
          where: { type: 'EXPENSE', date: { gte: startOfMonth, lte: endOfMonth } },
        }),
      ])
    );

    const monthIncome = monthRanges.map((_, idx) => fromCurrencyGroups(results[idx * 2], 'amount'));
    const monthExpense = monthRanges.map((_, idx) =>
      fromCurrencyGroups(results[idx * 2 + 1], 'amount')
    );
    const currencies = currenciesPresent(...monthIncome, ...monthExpense);

    const amountFor = (
      groups: Array<{ currency: string; _sum: { amount: unknown } }>,
      currency: string
    ) => Number(groups.find((g) => g.currency === currency)?._sum.amount ?? 0);

    const byCurrency: Record<
      string,
      Array<{ month: string; income: number; expense: number; profit: number }>
    > = {};
    for (const currency of currencies) {
      byCurrency[currency] = monthRanges.map(({ startOfMonth }, idx) => {
        const income = amountFor(results[idx * 2], currency);
        const expense = amountFor(results[idx * 2 + 1], currency);
        return {
          month: startOfMonth.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
          income,
          expense,
          profit: income - expense,
        };
      });
    }

    return { currencies, byCurrency };
  }),
});
