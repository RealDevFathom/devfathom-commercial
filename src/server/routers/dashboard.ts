import { z } from 'zod';
import { router, protectedProcedure, adminProcedure } from '../trpc';
import { fromCurrencyGroups, currenciesPresent, type CurrencyAmount } from '@/lib/finance/currency';

// IMP-DASH-02: stable keys for the dashboard widgets a user may hide. The Next
// Meeting banner, KPI cards, and admin Revenue chart are intentionally NOT
// toggleable — they stay always-on to avoid edge cases.
const TOGGLEABLE_WIDGETS = ['myTasks', 'deadlines', 'activity', 'projects'] as const;

/**
 * Safely coerce a stored `User.preferences` JSON blob into the shape we rely on.
 * Anything malformed (null, non-object, wrong types) falls back to a sane empty
 * default so the dashboard never crashes on bad data.
 */
function parsePreferences(raw: unknown): { hiddenWidgets: string[] } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const hidden = (raw as Record<string, unknown>).hiddenWidgets;
    if (Array.isArray(hidden)) {
      return { hiddenWidgets: hidden.filter((w): w is string => typeof w === 'string') };
    }
  }
  return { hiddenWidgets: [] };
}

export const dashboardRouter = router({
  // IMP-DASH-02: read the caller's dashboard widget preferences.
  getPreferences: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { preferences: true },
    });
    return parsePreferences(user?.preferences);
  }),

  // IMP-DASH-02: persist which widgets the caller has hidden. We merge into the
  // existing preferences object so unrelated keys are preserved, and ignore any
  // unknown widget keys so the stored set stays clean.
  updatePreferences: protectedProcedure
    .input(z.object({ hiddenWidgets: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      const hiddenWidgets = input.hiddenWidgets.filter((w) =>
        (TOGGLEABLE_WIDGETS as readonly string[]).includes(w)
      );

      const existing = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
        select: { preferences: true },
      });
      const base =
        existing?.preferences &&
        typeof existing.preferences === 'object' &&
        !Array.isArray(existing.preferences)
          ? (existing.preferences as Record<string, unknown>)
          : {};

      await ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { preferences: { ...base, hiddenWidgets } },
      });
      return { hiddenWidgets };
    }),

  // "The Sounding" design revamp (spec §6): best-effort persistence of the five
  // configurable surface toggles into the shared User.preferences blob under an
  // `appearance` key, so prefs follow the account. localStorage remains the
  // client-side source of truth (the PreferencesProvider applies them pre-paint);
  // this write is a non-blocking mirror. Stored alongside `hiddenWidgets`; the
  // base-merge here and in updatePreferences keeps the two independent.
  updateAppearance: protectedProcedure
    .input(
      z.object({
        density: z.enum(['default', 'compact']).optional(),
        type: z.enum(['default', 'lg']).optional(),
        accent: z.enum(['quiet', 'bold']).optional(),
        layout: z.enum(['rail', 'top']).optional(),
        icons: z.enum(['numeric', 'architectural']).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
        select: { preferences: true },
      });
      const base =
        existing?.preferences &&
        typeof existing.preferences === 'object' &&
        !Array.isArray(existing.preferences)
          ? (existing.preferences as Record<string, unknown>)
          : {};
      const currentAppearance =
        base.appearance && typeof base.appearance === 'object' && !Array.isArray(base.appearance)
          ? (base.appearance as Record<string, unknown>)
          : {};

      const appearance = { ...currentAppearance, ...input };
      await ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { preferences: { ...base, appearance } },
      });
      return { appearance };
    }),

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
          // #410: entered Done this week — an edit to an old Done task moves updatedAt.
          completedAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
      }),
      // DASH-02: non-admins must not receive the company-wide pending-leave count
      // (it shipped to every client even though only the admin card renders it).
      // Admins get the company total; everyone else gets their OWN pending count.
      ctx.db.leaveRequest.count({
        where: { status: 'PENDING', ...(isAdmin ? {} : { userId }) },
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
          // FIN-04: bound the upper end so a future-dated row can't inflate
          // "this month".
          where: { type: 'INCOME', date: { gte: startOfMonth, lte: now } },
        }),
        ctx.db.transaction.groupBy({
          by: ['currency'],
          _sum: { amount: true },
          where: { type: 'EXPENSE', date: { gte: startOfMonth, lte: now } },
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
    const userId = ctx.session.user.id;
    const userSelect = { id: true, name: true, avatar: true, title: true } as const;

    if (isAdmin) {
      return ctx.db.activity.findMany({
        take: 20,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: userSelect } },
      });
    }

    // DASH-01: the feed must be scoped to what the viewer can actually see —
    // previously it filtered ONLY finance event types, so SHARED-note titles and
    // cross-team project/task names were broadcast to every employee.
    //
    // Drop finance/CRM types outright, then keep an item only if: the viewer
    // performed it, OR it is a Note they can access, OR a Project/Task in a
    // project they belong to. Everything else (others' meetings, DMs, HR, User)
    // is dropped.
    const financeTypes = [
      'invoice_created',
      'invoice_sent',
      'invoice_paid',
      'transaction_created',
      'contract_created',
      'contract_updated',
      'contract_deleted',
      'client_created',
      'client_deleted',
    ];

    const recent = await ctx.db.activity.findMany({
      where: { type: { notIn: financeTypes } },
      take: 80,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: userSelect } },
    });

    const [memberProjects, accessibleNotes] = await Promise.all([
      ctx.db.projectMember.findMany({ where: { userId }, select: { projectId: true } }),
      ctx.db.note.findMany({
        where: {
          OR: [{ authorId: userId }, { visibility: 'TEAM' }, { shares: { some: { userId } } }],
        },
        select: { id: true },
      }),
    ]);
    const projectIds = new Set(memberProjects.map((m) => m.projectId));
    const noteIds = new Set(accessibleNotes.map((n) => n.id));

    // Resolve each Task activity to its parent project so we can membership-check.
    const taskIds = recent
      .filter((a) => a.entityType === 'Task' && a.entityId)
      .map((a) => a.entityId as string);
    const taskProject = new Map<string, string>();
    if (taskIds.length) {
      const tasks = await ctx.db.task.findMany({
        where: { id: { in: taskIds } },
        select: { id: true, column: { select: { board: { select: { projectId: true } } } } },
      });
      for (const t of tasks) taskProject.set(t.id, t.column.board.projectId);
    }

    return recent
      .filter((a) => {
        if (a.userId === userId) return true; // the viewer's own action
        switch (a.entityType) {
          case 'Note':
            return a.entityId ? noteIds.has(a.entityId) : false;
          case 'Project':
            return a.entityId ? projectIds.has(a.entityId) : false;
          case 'Task':
            return a.entityId ? projectIds.has(taskProject.get(a.entityId) ?? '') : false;
          default:
            return false;
        }
      })
      .slice(0, 20);
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
    const isAdmin = ctx.session.user.role === 'ADMIN';
    const userId = ctx.session.user.id;

    return ctx.db.task.findMany({
      where: {
        assignees: { some: { userId } },
        column: {
          name: { not: 'Done' },
          // Assignee rows can outlive a cross-project move performed by an old
          // client or integration. Do not let that stale relationship disclose
          // the destination project through the dashboard. Organization admins
          // retain their existing all-project capability.
          ...(isAdmin ? {} : { board: { project: { members: { some: { userId } } } } }),
        },
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

    // FIN-03: anchor each month at day 1 — `new Date(); setMonth(m - i)` on the
    // 29th–31st overflows into the wrong month. And extend endOfMonth to the
    // final millisecond, otherwise `lte: endOfMonth` (at 00:00 on the last day)
    // drops every transaction on the month's final day.
    const now = new Date();
    const monthRanges = [];
    for (let i = months - 1; i >= 0; i--) {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59, 999);
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
