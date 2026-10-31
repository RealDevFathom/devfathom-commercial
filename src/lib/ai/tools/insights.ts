/**
 * INSIGHTS / cross-cutting intelligence tools for the DevFathom assistant.
 *
 * These are the "zoom out" tools: a personalized briefing, the recent-activity
 * feed, one-shot global search across every entity, team capacity / workload,
 * skill-based people search for staffing, the headline dashboard KPIs, and (for
 * admins only) a searchable view of the audit trail.
 *
 * Every tool here is a READ — none mutate, so none set `needsApproval`. Each
 * mirrors the authorization + scoping of the equivalent tRPC router so the
 * assistant can never surface more than the acting user is allowed to see:
 *   - getOverview / getDashboardStats → dashboard.getStats (role-scoped)
 *   - getRecentActivity              → dashboard.getRecentActivity (+ project scope)
 *   - globalSearch                   → search.global (per-group visibility)
 *   - getTeamWorkload                → team-stats.getAll (admins/HR) / getForUser (self)
 *   - searchAuditLog                 → audit.list (ADMIN ONLY)
 */
import { tool } from 'ai';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { matchScore, type AssistantHelpers, type ToolSet } from '@/lib/ai/context';

const DAY_MS = 86_400_000;

// Activity types that expose financial data — hidden from non-admins, mirroring
// dashboard.getRecentActivity.
const FINANCE_ACTIVITY_TYPES = [
  'invoice_created',
  'invoice_sent',
  'invoice_paid',
  'transaction_created',
  'contract_created',
  'contract_updated',
  'contract_deleted',
];

/** A coarse capacity read-out for one person, used by getTeamWorkload. */
function workloadSignal(openTasks: number, overdueTasks: number): string {
  if (overdueTasks >= 3 || openTasks >= 8) return 'overloaded';
  if (openTasks <= 1) return 'has bandwidth';
  return 'balanced';
}

export function buildInsightsTools(h: AssistantHelpers): ToolSet {
  const tools: ToolSet = {};

  // ──────────────────────────── PERSONAL BRIEFING ───────────────────────────
  tools.getOverview = tool({
    description:
      'A personalized briefing for the current user — your open/overdue tasks and what is due soon, your upcoming meetings, pending leave, and your active projects (plus company-wide headline numbers if you are an admin). Use for "what should I focus on", "brief me", "my day", "summary", "catch me up".',
    inputSchema: z.object({}),
    execute: async () => {
      const now = h.now();
      const weekAhead = new Date(now.getTime() + 7 * DAY_MS);
      const [myTasks, myMeetings, myLeave, myProjects] = await Promise.all([
        h.db.task.findMany({
          where: {
            assignees: { some: { userId: h.ctx.userId } },
            column: { name: { notIn: h.DONE_COLUMNS } },
          },
          select: { title: true, dueDate: true, priority: true },
        }),
        h.db.meeting.count({
          where: {
            OR: [{ createdById: h.ctx.userId }, { attendees: { some: { userId: h.ctx.userId } } }],
            startTime: { gte: now, lte: weekAhead },
          },
        }),
        h.db.leaveRequest.count({ where: { userId: h.ctx.userId, status: 'PENDING' } }),
        h.db.project.count({
          where: {
            status: { in: ['ACTIVE', 'IN_DEVELOPMENT'] },
            members: { some: { userId: h.ctx.userId } },
          },
        }),
      ]);
      const overdue = myTasks.filter((t) => t.dueDate && t.dueDate < now);
      const dueThisWeek = myTasks.filter(
        (t) => t.dueDate && t.dueDate >= now && t.dueDate <= weekAhead
      );

      const result: Record<string, unknown> = {
        me: {
          openTasks: myTasks.length,
          overdueTasks: overdue.length,
          dueThisWeek: dueThisWeek.length,
          meetingsThisWeek: myMeetings,
          pendingLeaveRequests: myLeave,
          activeProjects: myProjects,
          nextDue: dueThisWeek
            .sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime())
            .slice(0, 3)
            .map((t) => ({ title: t.title, dueDate: t.dueDate, priority: t.priority })),
        },
      };

      if (h.isAdmin) {
        const [overdueTeam, behind, outstanding] = await Promise.all([
          h.db.task.count({
            where: { dueDate: { lt: now }, column: { name: { notIn: h.DONE_COLUMNS } } },
          }),
          h.db.project.count({
            where: {
              status: { notIn: ['COMPLETED', 'CANCELLED'] },
              OR: [
                { endDate: { lt: now } },
                { milestones: { some: { dueDate: { lt: now }, completedAt: null } } },
              ],
            },
          }),
          h.db.invoice.aggregate({
            _sum: { total: true },
            _count: true,
            where: { status: { in: ['SENT', 'OVERDUE'] } },
          }),
        ]);
        result.company = {
          overdueTasksTeamWide: overdueTeam,
          projectsBehindSchedule: behind,
          outstandingInvoices: {
            count: outstanding._count,
            total: Number(outstanding._sum.total || 0),
          },
        };
      }
      return result;
    },
  });

  // ──────────────────────────── ACTIVITY FEED ───────────────────────────────
  tools.getRecentActivity = tool({
    description:
      'Recent activity across the hub — what changed lately (tasks created, projects updated, invoices, etc.). Use for "what is happening", "recent updates", "what is new", "latest activity". Employees see their own activity and activity on their projects; admins see everything.',
    inputSchema: z.object({
      withinDays: z.number().int().nullish().describe('Default 14'),
    }),
    execute: async ({ withinDays }) => {
      const since = new Date(h.now().getTime() - (withinDays ?? 14) * DAY_MS);
      let where: Prisma.ActivityWhereInput = { createdAt: { gte: since } };
      if (!h.isAdmin) {
        const pids = await h.myProjectIds();
        where = {
          createdAt: { gte: since },
          // Hide finance activity from non-admins, mirroring the dashboard router.
          type: { notIn: FINANCE_ACTIVITY_TYPES },
          OR: [{ userId: h.ctx.userId }, { entityType: 'Project', entityId: { in: pids } }],
        };
      }
      const activity = await h.db.activity.findMany({
        where,
        take: 30,
        orderBy: { createdAt: 'desc' },
        select: {
          type: true,
          message: true,
          createdAt: true,
          user: { select: { name: true } },
        },
      });
      return activity.map((a) => ({
        who: a.user.name,
        what: a.message,
        type: a.type,
        when: a.createdAt,
      }));
    },
  });

  // ──────────────────────────── GLOBAL SEARCH ───────────────────────────────
  tools.globalSearch = tool({
    description:
      'One search across EVERYTHING at once — people, projects, clients, tasks and notes — for a single query string. Use for "find anything about X", "look up Y", "search for Z" when you do not yet know which kind of thing it is. Results are grouped by type and scoped to what you are allowed to see (employees only see their own projects/tasks and notes shared with them; the people and client directories are visible to all).',
    inputSchema: z.object({
      query: z.string().describe('What to search for across the hub'),
    }),
    execute: async ({ query }) => {
      const q = query.trim();
      if (q.length === 0) {
        return { projects: [], tasks: [], clients: [], notes: [], team: [] };
      }
      const userId = h.ctx.userId;
      const isAdmin = h.isAdmin;
      const insensitive = { contains: q, mode: 'insensitive' as const };

      const [projects, tasks, clients, notes, team] = await Promise.all([
        // PROJECTS — admin sees all, employees only their projects.
        h.db.project.findMany({
          where: { name: insensitive, ...(isAdmin ? {} : { members: { some: { userId } } }) },
          select: {
            name: true,
            type: true,
            status: true,
            client: { select: { name: true } },
          },
          take: 6,
          orderBy: { updatedAt: 'desc' },
        }),
        // TASKS — admin sees all, employees only tasks in their projects.
        h.db.task.findMany({
          where: {
            title: insensitive,
            ...(isAdmin
              ? {}
              : { column: { board: { project: { members: { some: { userId } } } } } }),
          },
          select: {
            title: true,
            priority: true,
            column: {
              select: {
                name: true,
                board: { select: { project: { select: { name: true } } } },
              },
            },
          },
          take: 6,
          orderBy: { updatedAt: 'desc' },
        }),
        // CLIENTS — everyone can see the client directory (no revenue exposed).
        h.db.client.findMany({
          where: { name: insensitive },
          select: { name: true, industry: true, status: true },
          take: 6,
          orderBy: { name: 'asc' },
        }),
        // NOTES — only those visible to the user.
        h.db.note.findMany({
          where: {
            AND: [
              { OR: [{ title: insensitive }, { contentText: insensitive }] },
              {
                OR: [
                  { authorId: userId },
                  { visibility: 'TEAM' },
                  { visibility: 'SHARED', shares: { some: { userId } } },
                ],
              },
            ],
          },
          select: {
            title: true,
            visibility: true,
            author: { select: { name: true } },
          },
          take: 6,
          orderBy: { updatedAt: 'desc' },
        }),
        // TEAM — everyone can see the directory (active members).
        h.db.user.findMany({
          where: {
            OR: [{ name: insensitive }, { email: insensitive }, { title: insensitive }],
            status: 'ACTIVE',
          },
          select: { name: true, title: true, department: true },
          take: 6,
          orderBy: { name: 'asc' },
        }),
      ]);

      return {
        projects: projects.map((p) => ({
          name: p.name,
          type: p.type,
          status: p.status,
          client: p.client?.name ?? null,
        })),
        tasks: tasks.map((t) => ({
          title: t.title,
          priority: t.priority,
          status: t.column?.name ?? null,
          project: t.column?.board?.project?.name ?? null,
        })),
        clients: clients.map((c) => ({
          name: c.name,
          industry: c.industry ?? null,
          status: c.status,
        })),
        notes: notes.map((n) => ({
          title: n.title,
          author: n.author.name,
          visibility: n.visibility,
        })),
        team: team.map((u) => ({ name: u.name, title: u.title, department: u.department })),
      };
    },
  });

  // ──────────────────────────── TEAM WORKLOAD ───────────────────────────────
  tools.getTeamWorkload = tool({
    description:
      'Team capacity and workload — per-person open / overdue / recently-completed task counts plus a quick signal (overloaded / balanced / has bandwidth). Use for "who is overloaded", "who has bandwidth / capacity for more work", "team workload", "team capacity", "who should I assign this to". Admins see the whole team; everyone else sees only their own workload.',
    inputSchema: z.object({}),
    execute: async () => {
      const now = h.now();
      const weekAgo = new Date(now.getTime() - 7 * DAY_MS);

      // Only admins get the whole-team view — mirrors team-stats.getAll, which is
      // ADMIN-only. HR and employees see just their own workload (getForUser).
      if (!h.isAdmin) {
        const userId = h.ctx.userId;
        const [openTasks, overdueTasks, completedThisWeek] = await Promise.all([
          h.db.task.count({
            where: { assignees: { some: { userId } }, column: { name: { not: 'Done' } } },
          }),
          h.db.task.count({
            where: {
              assignees: { some: { userId } },
              dueDate: { lt: now },
              column: { name: { not: 'Done' } },
            },
          }),
          h.db.task.count({
            where: {
              assignees: { some: { userId } },
              column: { name: 'Done' },
              updatedAt: { gte: weekAgo },
            },
          }),
        ]);
        return {
          scope: 'self',
          me: {
            name: h.ctx.name ?? 'You',
            openTasks,
            overdueTasks,
            completedThisWeek,
            signal: workloadSignal(openTasks, overdueTasks),
          },
          note: 'Showing only your own workload — full team capacity is visible to admins and HR.',
        };
      }

      // Admins / HR — full team view, built from a few batched queries (mirrors
      // team-stats.getAll) rather than one query per person.
      const [users, openRows, overdueRows, doneRows] = await Promise.all([
        h.db.user.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, name: true, title: true },
          orderBy: { name: 'asc' },
        }),
        h.db.task.findMany({
          where: { assignees: { some: {} }, column: { name: { not: 'Done' } } },
          select: { assignees: { select: { userId: true } } },
        }),
        h.db.task.findMany({
          where: {
            dueDate: { lt: now },
            column: { name: { not: 'Done' } },
            assignees: { some: {} },
          },
          select: { assignees: { select: { userId: true } } },
        }),
        h.db.task.findMany({
          where: {
            column: { name: 'Done' },
            updatedAt: { gte: weekAgo },
            assignees: { some: {} },
          },
          select: { assignees: { select: { userId: true } } },
        }),
      ]);

      const byUser = new Map(
        users.map((u) => [
          u.id,
          {
            name: u.name,
            title: u.title,
            openTasks: 0,
            overdueTasks: 0,
            completedThisWeek: 0,
          },
        ])
      );
      const bump = (
        rows: { assignees: { userId: string }[] }[],
        key: 'openTasks' | 'overdueTasks' | 'completedThisWeek'
      ) => {
        for (const t of rows) {
          for (const a of t.assignees) {
            const s = byUser.get(a.userId);
            if (s) s[key]++;
          }
        }
      };
      bump(openRows, 'openTasks');
      bump(overdueRows, 'overdueTasks');
      bump(doneRows, 'completedThisWeek');

      const members = Array.from(byUser.values())
        .map((m) => ({ ...m, signal: workloadSignal(m.openTasks, m.overdueTasks) }))
        // Most loaded first, so "who is overloaded" surfaces at the top.
        .sort((a, b) => b.overdueTasks - a.overdueTasks || b.openTasks - a.openTasks);

      return {
        scope: 'team',
        members,
        totals: {
          teamMembers: members.length,
          teamOpenTasks: members.reduce((s, m) => s + m.openTasks, 0),
          teamOverdue: members.reduce((s, m) => s + m.overdueTasks, 0),
          overloaded: members.filter((m) => m.signal === 'overloaded').length,
          hasBandwidth: members.filter((m) => m.signal === 'has bandwidth').length,
          membersWithNoTasks: members.filter((m) => m.openTasks === 0).length,
        },
      };
    },
  });

  // ──────────────────────────── SKILL SEARCH ────────────────────────────────
  tools.findPeopleBySkill = tool({
    description:
      'Find active team members by SKILL / expertise (their listed skills). Use for "who knows React", "find a designer", "who can do Figma", "who has Python experience", "who could work on a mobile project". Returns each match\'s name, title, department, the skills that matched, and a quick open-task count to help with staffing.',
    inputSchema: z.object({
      skill: z
        .string()
        .describe('The skill, tool, or expertise to look for, e.g. "React", "Figma", "Python"'),
    }),
    execute: async ({ skill }) => {
      const users = await h.db.user.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, name: true, title: true, department: true, skills: true },
        orderBy: { name: 'asc' },
      });

      const matched = users
        .map((u) => ({
          u,
          matchingSkills: u.skills.filter((s) => matchScore(skill, s) >= 60),
        }))
        .filter((m) => m.matchingSkills.length > 0)
        .sort((a, b) => b.matchingSkills.length - a.matchingSkills.length);

      if (matched.length === 0) {
        return { error: `No active team member lists a skill matching "${skill}".` };
      }

      // One query for open-task counts, scoped to what the viewer may see.
      const ids = new Set(matched.map((m) => m.u.id));
      const openTaskRows = await h.db.task.findMany({
        where: {
          AND: [
            { assignees: { some: { userId: { in: [...ids] } } } },
            { column: { name: { notIn: h.DONE_COLUMNS } } },
            h.taskVisibility(),
          ],
        },
        select: { assignees: { select: { userId: true } } },
      });
      const openCount = new Map<string, number>();
      for (const t of openTaskRows) {
        for (const a of t.assignees) {
          if (ids.has(a.userId)) openCount.set(a.userId, (openCount.get(a.userId) ?? 0) + 1);
        }
      }

      return {
        count: matched.length,
        people: matched.map((m) => ({
          name: m.u.name,
          title: m.u.title,
          department: m.u.department,
          matchingSkills: m.matchingSkills,
          openTasks: openCount.get(m.u.id) ?? 0,
        })),
        note: h.isAdmin ? undefined : 'Open-task counts reflect only work you can see.',
      };
    },
  });

  // ──────────────────────────── DASHBOARD KPIs ──────────────────────────────
  tools.getDashboardStats = tool({
    description:
      'Headline dashboard numbers — active projects, total tasks, tasks completed in the last 7 days, and pending leave requests (plus this month\'s revenue, expenses and outstanding-invoice count for admins). Use for "the numbers", "dashboard stats", "how are we doing", "give me the KPIs". Counts are scoped to what you can see (admins get company-wide figures, employees get their own).',
    inputSchema: z.object({}),
    execute: async () => {
      const isAdmin = h.isAdmin;
      const userId = h.ctx.userId;
      const now = h.now();

      const [activeProjects, totalTasks, completedTasksThisWeek, pendingLeaves] = await Promise.all(
        [
          h.db.project.count({
            where: isAdmin
              ? { status: 'ACTIVE' }
              : { members: { some: { userId } }, status: 'ACTIVE' },
          }),
          h.db.task.count({
            where: isAdmin ? {} : { assignees: { some: { userId } } },
          }),
          h.db.task.count({
            where: {
              ...(isAdmin ? {} : { assignees: { some: { userId } } }),
              column: { name: 'Done' },
              updatedAt: { gte: new Date(now.getTime() - 7 * DAY_MS) },
            },
          }),
          // AI-03: mirror DASH-02 — admins see the company-wide pending-leave count,
          // everyone else only their own (no company-wide count over the assistant).
          h.db.leaveRequest.count({
            where: { status: 'PENDING', ...(isAdmin ? {} : { userId }) },
          }),
        ]
      );

      const result: Record<string, unknown> = {
        activeProjects,
        totalTasks,
        completedTasksThisWeek,
        pendingLeaves,
      };

      if (isAdmin) {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const [incomeResult, expenseResult, outstandingResult] = await Promise.all([
          h.db.transaction.aggregate({
            _sum: { amount: true },
            where: { type: 'INCOME', date: { gte: startOfMonth } },
          }),
          h.db.transaction.aggregate({
            _sum: { amount: true },
            where: { type: 'EXPENSE', date: { gte: startOfMonth } },
          }),
          h.db.invoice.count({ where: { status: { in: ['SENT', 'OVERDUE'] } } }),
        ]);
        result.revenueThisMonth = Number(incomeResult._sum.amount || 0);
        result.expensesThisMonth = Number(expenseResult._sum.amount || 0);
        result.outstandingInvoices = outstandingResult;
      }

      return result;
    },
  });

  // ──────────────────────────── AUDIT LOG (ADMIN) ───────────────────────────
  // Only handed to admins (defense in depth: also guarded inside execute).
  if (h.isAdmin) {
    tools.searchAuditLog = tool({
      description:
        'Search the admin AUDIT TRAIL — who did what, when, and whether it succeeded. Filter by free-text query (matches actor name, action, description, target), by the person who performed the action, by category (TEAM, FINANCE, PROJECT, TASK, CLIENT, NOTE, MEETING, AUTH, API_TOKEN, SYSTEM), by operation, by outcome, or by date range. Use for "who changed X", "recent admin actions", "the audit trail for <person>", "who laid off / deactivated <person>", "what failed recently". ADMIN ONLY.',
      inputSchema: z.object({
        query: z
          .string()
          .nullish()
          .describe(
            'Free-text search across actor name/email, action, description, target label/id'
          ),
        actorName: z
          .string()
          .nullish()
          .describe('Name of the person whose actions you want (the audit trail FOR someone)'),
        category: z
          .string()
          .nullish()
          .describe('e.g. TEAM, FINANCE, PROJECT, TASK, CLIENT, NOTE, MEETING, AUTH, SYSTEM'),
        operation: z
          .enum([
            'CREATE',
            'READ',
            'UPDATE',
            'DELETE',
            'LOGIN',
            'LOGOUT',
            'LOGIN_FAILED',
            'EXECUTE',
            'OTHER',
          ])
          .nullish(),
        outcome: z.enum(['SUCCESS', 'FAILURE']).nullish(),
        targetType: z.string().nullish().describe('e.g. User, Project, Task, Invoice, Client'),
        startDate: z.string().nullish().describe('ISO date — only entries on/after this'),
        endDate: z.string().nullish().describe('ISO date — only entries on/before this'),
        limit: z.number().int().nullish().describe('Max rows (default 50, max 200)'),
      }),
      execute: async ({
        query,
        actorName,
        category,
        operation,
        outcome,
        targetType,
        startDate,
        endDate,
        limit,
      }) => {
        // Belt + braces: the same decision point the admin surfaces use.
        if (!(await h.can('admin:access'))) {
          return { error: 'The audit trail is restricted to administrators.' };
        }

        const where: Prisma.AuditLogWhereInput = {};
        if (category) where.category = category;
        if (operation) where.operation = operation;
        if (outcome) where.outcome = outcome;
        if (targetType) where.targetType = targetType;

        // Resolve the actor by name when possible → precise actorId filter.
        // Otherwise fall back to a name-snapshot contains match (handles former
        // employees / system actors that no longer resolve to a live user).
        if (actorName) {
          const r = await h.resolvePerson(actorName, { includeInactive: true });
          if (r.kind === 'ambiguous') {
            return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };
          }
          if (r.kind === 'resolved') where.actorId = r.value.id;
          else where.actorName = { contains: actorName, mode: 'insensitive' };
        }

        if (startDate || endDate) {
          const gte = startDate ? new Date(startDate) : undefined;
          const lte = endDate ? new Date(endDate) : undefined;
          where.createdAt = {
            ...(gte && !Number.isNaN(gte.getTime()) ? { gte } : {}),
            ...(lte && !Number.isNaN(lte.getTime()) ? { lte } : {}),
          };
        }

        if (query && query.trim()) {
          const q = query.trim();
          where.OR = [
            { actorName: { contains: q, mode: 'insensitive' } },
            { actorEmail: { contains: q, mode: 'insensitive' } },
            { action: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
            { targetLabel: { contains: q, mode: 'insensitive' } },
            { targetId: { contains: q, mode: 'insensitive' } },
            { errorMessage: { contains: q, mode: 'insensitive' } },
          ];
        }

        const take = Math.min(Math.max(limit ?? 50, 1), 200);
        const rows = await h.db.auditLog.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: take + 1,
          select: {
            createdAt: true,
            actorName: true,
            actorRole: true,
            actorType: true,
            source: true,
            category: true,
            operation: true,
            action: true,
            description: true,
            targetType: true,
            targetLabel: true,
            outcome: true,
            errorMessage: true,
          },
        });

        const hasMore = rows.length > take;
        const items = (hasMore ? rows.slice(0, take) : rows).map((r) => ({
          when: r.createdAt,
          actor: r.actorName ?? '(unknown)',
          actorRole: r.actorRole,
          actorType: r.actorType,
          action: r.action,
          operation: r.operation,
          category: r.category,
          source: r.source,
          target: r.targetLabel ?? r.targetType ?? null,
          targetType: r.targetType,
          outcome: r.outcome,
          description: r.description,
          error: r.outcome === 'FAILURE' ? r.errorMessage : undefined,
        }));

        return {
          count: items.length,
          items,
          note: hasMore
            ? 'More entries match — narrow with a date range, actor, category, or query.'
            : undefined,
        };
      },
    });
  }

  return tools;
}
