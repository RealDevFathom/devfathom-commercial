import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@/lib/db';
import * as authz from '@/lib/authz';
import { logActivity } from '@/server/activity';

export type AssistantContext = {
  userId: string;
  role: 'ADMIN' | 'EMPLOYEE' | string;
  name?: string | null;
};

/**
 * Tools the DevFathom assistant can call. Read tools `execute` immediately and
 * are role-scoped; write tools set `needsApproval` so the SDK pauses for the
 * user to approve before `execute` (the actual mutation) runs.
 */
export function buildAssistantTools(ctx: AssistantContext) {
  // Derive every authorization decision from the same keystone predicates the
  // rest of the app uses (`@/lib/authz`), so the assistant can never exceed the
  // acting user's own permissions even if the model is prompt-injected.
  const isAdmin = authz.isAdmin(ctx.role);

  const tools = {
    listProjects: tool({
      description:
        'List projects in the hub (name, status, type, client). Use this to find a project or its id before creating tasks.',
      inputSchema: z.object({
        status: z
          .enum(['ACTIVE', 'IN_DEVELOPMENT', 'ON_HOLD', 'COMPLETED'])
          .nullish()
          .describe('Optional status filter'),
      }),
      execute: async ({ status }) => {
        const projects = await db.project.findMany({
          where: {
            ...(status ? { status } : {}),
            ...(isAdmin ? {} : { members: { some: { userId: ctx.userId } } }),
          },
          take: 50,
          orderBy: { updatedAt: 'desc' },
          include: {
            client: { select: { name: true } },
            _count: { select: { boards: true, milestones: true } },
          },
        });
        return projects.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          type: p.type,
          client: p.client?.name ?? null,
        }));
      },
    }),

    listMyTasks: tool({
      description:
        'List tasks assigned to the current user, with their project and status (column).',
      inputSchema: z.object({}),
      execute: async () => {
        const tasks = await db.task.findMany({
          where: { assignees: { some: { userId: ctx.userId } } },
          take: 50,
          orderBy: { createdAt: 'desc' },
          include: {
            column: {
              select: {
                name: true,
                board: { select: { project: { select: { name: true } } } },
              },
            },
          },
        });
        return tasks.map((t) => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          status: t.column?.name ?? null,
          project: t.column?.board?.project?.name ?? null,
          dueDate: t.dueDate,
        }));
      },
    }),

    listClients: tool({
      description: 'List clients (name, industry, location, project count).',
      inputSchema: z.object({}),
      execute: async () => {
        const clients = await db.client.findMany({
          where: isAdmin
            ? undefined
            : { projects: { some: { members: { some: { userId: ctx.userId } } } } },
          orderBy: { name: 'asc' },
          include: { _count: { select: { projects: true, invoices: true } } },
        });
        return clients.map((c) => ({
          id: c.id,
          name: c.name,
          industry: c.industry ?? null,
          location: c.location ?? null,
          projects: c._count.projects,
        }));
      },
    }),

    listTeam: tool({
      description:
        'List employees / staff / people / team members (name, title, department, email).',
      inputSchema: z.object({}),
      execute: async () => {
        return db.user.findMany({
          where: { status: 'ACTIVE' },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, title: true, department: true, email: true },
        });
      },
    }),

    findOverdueTasks: tool({
      description:
        'Find OVERDUE tasks (past their due date, not yet done) across the team, and who they are assigned to. Use for "who is behind / falling behind / lagging", "overdue work", or "what is late".',
      inputSchema: z.object({}),
      execute: async () => {
        const now = new Date();
        const tasks = await db.task.findMany({
          where: {
            dueDate: { lt: now },
            column: {
              name: { notIn: ['Done', 'Completed', 'Complete'] },
              ...(isAdmin
                ? {}
                : { board: { project: { members: { some: { userId: ctx.userId } } } } }),
            },
          },
          take: 100,
          orderBy: { dueDate: 'asc' },
          include: {
            assignees: { include: { user: { select: { name: true } } } },
            column: {
              select: { name: true, board: { select: { project: { select: { name: true } } } } },
            },
          },
        });
        return tasks.map((t) => ({
          title: t.title,
          project: t.column?.board?.project?.name ?? null,
          assignees: t.assignees.map((a) => a.user.name),
          dueDate: t.dueDate,
          daysOverdue: t.dueDate
            ? Math.floor((now.getTime() - new Date(t.dueDate).getTime()) / 86_400_000)
            : null,
        }));
      },
    }),

    findProjectsBehindSchedule: tool({
      description:
        'Find projects BEHIND SCHEDULE — past their end date or with overdue milestones, and not completed/cancelled. Use for "projects behind / at risk / late / slipping".',
      inputSchema: z.object({}),
      execute: async () => {
        const now = new Date();
        const projects = await db.project.findMany({
          where: {
            status: { notIn: ['COMPLETED', 'CANCELLED'] },
            ...(isAdmin ? {} : { members: { some: { userId: ctx.userId } } }),
            OR: [
              { endDate: { lt: now } },
              { milestones: { some: { dueDate: { lt: now }, completedAt: null } } },
            ],
          },
          take: 50,
          orderBy: { endDate: 'asc' },
          include: {
            client: { select: { name: true } },
            milestones: {
              where: { dueDate: { lt: now }, completedAt: null },
              select: { name: true, dueDate: true },
            },
          },
        });
        return projects.map((p) => ({
          name: p.name,
          status: p.status,
          client: p.client?.name ?? null,
          endDate: p.endDate,
          pastEndDate: p.endDate ? new Date(p.endDate) < now : false,
          overdueMilestones: p.milestones.map((m) => m.name),
        }));
      },
    }),

    getFinanceSummary: tool({
      description:
        'Get a finance summary (income, expenses, profit, margin, invoices) for a period. ADMIN ONLY.',
      inputSchema: z.object({
        startDate: z.string().nullish().describe('ISO date; defaults to start of this month'),
        endDate: z.string().nullish().describe('ISO date; defaults to today'),
      }),
      execute: async ({ startDate, endDate }) => {
        if (!isAdmin) {
          return { error: 'Finance data is restricted to administrators.' };
        }
        const now = new Date();
        const start = startDate
          ? new Date(startDate)
          : new Date(now.getFullYear(), now.getMonth(), 1);
        const end = endDate ? new Date(endDate) : now;

        const [income, expense, paidInvoices, outstandingInvoices] = await Promise.all([
          db.transaction.aggregate({
            _sum: { amount: true },
            _count: true,
            where: { type: 'INCOME', date: { gte: start, lte: end } },
          }),
          db.transaction.aggregate({
            _sum: { amount: true },
            _count: true,
            where: { type: 'EXPENSE', date: { gte: start, lte: end } },
          }),
          db.invoice.aggregate({ _sum: { total: true }, _count: true, where: { status: 'PAID' } }),
          db.invoice.aggregate({
            _sum: { total: true },
            _count: true,
            where: { status: { in: ['SENT', 'OVERDUE'] } },
          }),
        ]);

        const totalIncome = Number(income._sum.amount || 0);
        const totalExpense = Number(expense._sum.amount || 0);
        return {
          period: { start, end },
          income: { total: totalIncome, count: income._count },
          expense: { total: totalExpense, count: expense._count },
          profit: totalIncome - totalExpense,
          margin: totalIncome > 0 ? ((totalIncome - totalExpense) / totalIncome) * 100 : 0,
          invoices: {
            paid: { total: Number(paidInvoices._sum.total || 0), count: paidInvoices._count },
            outstanding: {
              total: Number(outstandingInvoices._sum.total || 0),
              count: outstandingInvoices._count,
            },
          },
        };
      },
    }),

    createTask: tool({
      description:
        'Create a task in a project. First use listProjects to get the projectId. The task is placed in the named column (default "To Do") and assigned to the current user.',
      inputSchema: z.object({
        projectId: z.string().describe('Project id from listProjects'),
        title: z.string().min(1),
        description: z.string().nullish(),
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).nullish(),
        dueDate: z.string().nullish().describe('ISO date'),
        columnName: z.string().nullish().describe('Target column, e.g. "To Do"'),
      }),
      needsApproval: true,
      execute: async ({ projectId, title, description, priority, dueDate, columnName }) => {
        // Object-level authz first — the same check a normal user faces (ADMIN or
        // a member of this project). Done BEFORE any lookup so a non-member can't
        // even probe whether the project/board exists.
        if (!(await authz.canAccessProject(db, ctx.userId, ctx.role, projectId))) {
          return { error: 'You do not have access to that project.' };
        }
        const board = await db.board.findFirst({
          where: { projectId },
          include: { columns: { orderBy: { order: 'asc' } }, project: { select: { name: true } } },
        });
        if (!board || board.columns.length === 0) {
          return { error: 'No board or columns found for that project.' };
        }
        const column =
          (columnName
            ? board.columns.find((c) => c.name.toLowerCase() === columnName.toLowerCase())
            : undefined) ??
          board.columns.find((c) => c.name.toLowerCase() === 'to do') ??
          board.columns[0];
        if (!column) {
          return { error: 'No column available in that project board.' };
        }

        const maxOrder = await db.task.aggregate({
          _max: { order: true },
          where: { columnId: column.id },
        });

        const task = await db.task.create({
          data: {
            title,
            description,
            columnId: column.id,
            order: (maxOrder._max.order ?? -1) + 1,
            priority: priority ?? 'MEDIUM',
            dueDate: dueDate ? new Date(dueDate) : null,
            createdById: ctx.userId,
            assignees: { create: [{ userId: ctx.userId }] },
          },
        });

        logActivity(db, ctx.userId, {
          type: 'task_created',
          message: `created task "${task.title}" in ${board.project.name}`,
          entityType: 'Task',
          entityId: task.id,
        });

        return { id: task.id, title: task.title, project: board.project.name, column: column.name };
      },
    }),

    createClient: tool({
      description: 'Add a new client to the hub.',
      inputSchema: z.object({
        name: z.string().min(1),
        website: z.string().nullish(),
        industry: z.string().nullish(),
        location: z.string().nullish(),
        notes: z.string().nullish(),
      }),
      needsApproval: true,
      execute: async ({ name, website, industry, location, notes }) => {
        if (!isAdmin) {
          return { error: 'Only admins can add clients.' };
        }
        const client = await db.client.create({
          data: { name, website, industry, location, notes },
        });
        logActivity(db, ctx.userId, {
          type: 'client_created',
          message: `added client ${client.name}`,
          entityType: 'Client',
          entityId: client.id,
        });
        return { id: client.id, name: client.name };
      },
    }),
  };

  // Role-based access: non-admins don't even receive the admin-only tools, so
  // the model can't call them. (Each is also guarded inside execute — belt +
  // braces, in case the toolset is ever exposed.)
  if (!isAdmin) {
    delete (tools as Record<string, unknown>).getFinanceSummary;
    delete (tools as Record<string, unknown>).createClient;
  }

  // Defense in depth: a thrown tool becomes a clean { error } result the model
  // can recover from, instead of the SDK's masked "An error occurred."
  for (const t of Object.values(tools) as Array<{
    execute?: (...args: unknown[]) => Promise<unknown>;
  }>) {
    const orig = t.execute;
    if (!orig) continue;
    t.execute = async (...args: unknown[]) => {
      try {
        return await orig(...args);
      } catch (e) {
        console.error('[assistant tool] failed:', e);
        return { error: e instanceof Error ? e.message : 'Tool failed.' };
      }
    };
  }

  return tools;
}
