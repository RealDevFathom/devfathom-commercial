import { tool } from 'ai';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import * as authz from '@/lib/authz';
import { logActivity } from '@/server/activity';
import { sendEmail, templates } from '@/lib/email';

export type AssistantContext = {
  userId: string;
  role: 'ADMIN' | 'EMPLOYEE' | string;
  name?: string | null;
};

// Column names that mean "this task is finished". Used everywhere we split
// open vs. done work so the model never counts completed tasks as outstanding.
const DONE_COLUMNS = ['Done', 'Completed', 'Complete', 'Shipped', 'Closed'];

// ---------------------------------------------------------------------------
// Fuzzy resolution — the keystone fix for "Ayesha vs Aisha". The model passes a
// human name (possibly misspelled); we map it to a real person/project/client
// and either (a) resolve confidently, (b) hand back candidates to disambiguate,
// or (c) report not-found. The model NEVER has to guess an id from thin air.
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Classic Levenshtein edit distance (small strings, fine to compute inline). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Score how well `name` answers the search `query`. 100 = exact, 0 = no match.
 * Tolerates typos and partial names (first name only, etc.).
 */
function matchScore(query: string, name: string): number {
  const q = norm(query);
  const n = norm(name);
  if (!q) return 0;
  if (q === n) return 100;
  if (n.includes(q) || q.includes(n)) return 88;

  const qTokens = q.split(/\s+/).filter(Boolean);
  const nTokens = n.split(/\s+/).filter(Boolean);

  // Any whole query token contained in any name token → strong partial match.
  if (qTokens.some((qt) => nTokens.some((nt) => nt.includes(qt) || qt.includes(nt)))) {
    return 72;
  }

  // Typo tolerance: closest token edit distance ≤ 2 (e.g. "ayesha" → "aisha").
  let best = Infinity;
  for (const qt of qTokens) {
    for (const nt of nTokens) {
      if (Math.max(qt.length, nt.length) < 4) continue;
      best = Math.min(best, editDistance(qt, nt));
    }
  }
  if (best <= 2) return 50 - best * 8; // 50 (dist 0, unreachable) … 34 (dist 2)
  return 0;
}

type PersonLite = {
  id: string;
  name: string;
  title: string;
  department: string;
  role: string;
  status: string;
};

type Resolution<T> =
  | { kind: 'resolved'; value: T; interpreted?: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'notfound' };

/** Resolve a free-text person name to a single user, or candidates to ask about. */
async function resolvePerson(
  query: string,
  opts: { includeInactive?: boolean } = {}
): Promise<Resolution<PersonLite>> {
  const users = await db.user.findMany({
    where: opts.includeInactive ? {} : { status: { not: 'INACTIVE' } },
    select: { id: true, name: true, title: true, department: true, role: true, status: true },
  });
  const scored = users
    .map((u) => ({ u, score: matchScore(query, u.name) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: 'notfound' };

  const strong = scored.filter((s) => s.score >= 70);
  if (strong.length === 1) return { kind: 'resolved', value: strong[0].u };
  if (strong.length > 1) {
    return { kind: 'ambiguous', candidates: strong.slice(0, 6).map((s) => `${s.u.name} (${s.u.title})`) };
  }
  // Only fuzzy matches remain.
  if (scored.length === 1) {
    return {
      kind: 'resolved',
      value: scored[0].u,
      interpreted: scored[0].u.name,
    };
  }
  return { kind: 'ambiguous', candidates: scored.slice(0, 6).map((s) => `${s.u.name} (${s.u.title})`) };
}

type NamedRow = { id: string; name: string };

function resolveNamed<T extends NamedRow>(query: string, rows: T[]): Resolution<T> {
  const scored = rows
    .map((r) => ({ r, score: matchScore(query, r.name) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { kind: 'notfound' };
  const strong = scored.filter((s) => s.score >= 70);
  if (strong.length === 1) return { kind: 'resolved', value: strong[0].r };
  if (strong.length === 0 && scored.length === 1) {
    return { kind: 'resolved', value: scored[0].r, interpreted: scored[0].r.name };
  }
  const pool = strong.length > 0 ? strong : scored;
  return { kind: 'ambiguous', candidates: pool.slice(0, 6).map((s) => s.r.name) };
}

// ---------------------------------------------------------------------------

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
  const now = () => new Date();

  // For non-admins: the project ids they may see. Cached per request.
  let myProjectIdsCache: string[] | null = null;
  const myProjectIds = async (): Promise<string[]> => {
    if (myProjectIdsCache) return myProjectIdsCache;
    const rows = await db.projectMember.findMany({
      where: { userId: ctx.userId },
      select: { projectId: true },
    });
    myProjectIdsCache = rows.map((r) => r.projectId);
    return myProjectIdsCache;
  };

  // Visibility predicate for tasks a non-admin may see: assigned to them OR on a
  // project they belong to. Admins see everything (empty predicate).
  const taskVisibility = (): Prisma.TaskWhereInput =>
    isAdmin
      ? {}
      : {
          OR: [
            { assignees: { some: { userId: ctx.userId } } },
            { column: { board: { project: { members: { some: { userId: ctx.userId } } } } } },
          ],
        };

  const compactTask = (t: {
    id: string;
    title: string;
    priority: string;
    dueDate: Date | null;
    column: { name: string; board: { project: { name: string } } } | null;
    assignees: { user: { name: string } }[];
  }) => ({
    id: t.id,
    title: t.title,
    priority: t.priority,
    status: t.column?.name ?? null,
    project: t.column?.board?.project?.name ?? null,
    assignees: t.assignees.map((a) => a.user.name),
    dueDate: t.dueDate,
    overdue: !!t.dueDate && t.dueDate < now() && !DONE_COLUMNS.includes(t.column?.name ?? ''),
  });

  const tools = {
    // ───────────────────────────── PEOPLE / TEAM ────────────────────────────
    listTeam: tool({
      description:
        'List employees / staff / people / team members (name, title, department, status, skills). Use for "who works here", "the team", headcount, or to find a person before a deeper lookup.',
      inputSchema: z.object({
        department: z
          .enum(['LEADERSHIP', 'ENGINEERING', 'PRODUCT', 'QUALITY', 'MARKETING', 'DESIGN'])
          .nullish()
          .describe('Optional department filter'),
        query: z.string().nullish().describe('Optional name/role search'),
      }),
      execute: async ({ department, query }) => {
        const people = await db.user.findMany({
          where: { status: { not: 'INACTIVE' }, ...(department ? { department } : {}) },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            title: true,
            department: true,
            status: true,
            skills: true,
          },
        });
        const filtered = query ? people.filter((p) => matchScore(query, p.name) > 0) : people;
        return filtered.map((p) => ({
          id: p.id,
          name: p.name,
          title: p.title,
          department: p.department,
          status: p.status,
          skills: p.skills.slice(0, 6),
        }));
      },
    }),

    getTeamMember: tool({
      description:
        "A deep profile of ONE person: title, department, skills, bio, the projects they're on, a breakdown of their tasks (open / overdue / done), and any current or pending leave. Use for \"tell me about <name>\", \"what is <name> working on\", \"<name>'s workload\". Give the person's name.",
      inputSchema: z.object({
        name: z.string().describe("The team member's name, e.g. \"Aisha\" or \"Aisha Khan\""),
      }),
      execute: async ({ name }) => {
        const r = await resolvePerson(name, { includeInactive: true });
        if (r.kind === 'notfound') return { error: `No team member matches "${name}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };
        const u = r.value;

        const full = await db.user.findUnique({
          where: { id: u.id },
          select: {
            name: true,
            title: true,
            department: true,
            role: true,
            status: true,
            email: true,
            phone: true,
            bio: true,
            skills: true,
            startDate: true,
            projectMembers: {
              select: { role: true, project: { select: { name: true, status: true } } },
            },
          },
        });
        if (!full) return { error: 'That team member was not found.' };

        // Tasks the VIEWER is allowed to see that are assigned to this person.
        const tasks = await db.task.findMany({
          where: { AND: [{ assignees: { some: { userId: u.id } } }, taskVisibility()] },
          select: {
            title: true,
            priority: true,
            dueDate: true,
            column: { select: { name: true } },
          },
          take: 200,
        });
        const open = tasks.filter((t) => !DONE_COLUMNS.includes(t.column?.name ?? ''));
        const overdue = open.filter((t) => t.dueDate && t.dueDate < now());

        // Leave (admins, or the person viewing themselves).
        let leave: { type: string; startDate: Date; endDate: Date; status: string }[] | null = null;
        if (isAdmin || u.id === ctx.userId) {
          leave = await db.leaveRequest.findMany({
            where: { userId: u.id, endDate: { gte: now() } },
            orderBy: { startDate: 'asc' },
            select: { type: true, startDate: true, endDate: true, status: true },
            take: 5,
          });
        }

        return {
          name: full.name,
          title: full.title,
          department: full.department,
          role: full.role,
          status: full.status,
          email: isAdmin || u.id === ctx.userId ? full.email : undefined,
          phone: isAdmin || u.id === ctx.userId ? full.phone : undefined,
          bio: full.bio,
          skills: full.skills,
          startDate: full.startDate,
          projects: full.projectMembers.map((m) => ({
            name: m.project.name,
            status: m.project.status,
            role: m.role,
          })),
          tasks: {
            open: open.length,
            overdue: overdue.length,
            done: tasks.length - open.length,
            // A few representative open tasks, soonest due first.
            sample: open
              .sort((a, b) => (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity))
              .slice(0, 8)
              .map((t) => ({
                title: t.title,
                priority: t.priority,
                dueDate: t.dueDate,
                status: t.column?.name ?? null,
              })),
          },
          leave: leave === null ? 'restricted' : leave,
          scopeNote: r.interpreted
            ? `Interpreted "${name}" as ${r.interpreted}.`
            : isAdmin
              ? undefined
              : 'Task figures reflect only work you can see.',
        };
      },
    }),

    // ───────────────────────────────── TASKS ────────────────────────────────
    searchTasks: tool({
      description:
        'Search tasks with flexible filters — the main task tool. Filter by who they are assigned to (a person\'s name, or "me"), by project, status (open/done/all), priority, whether they are overdue, due within N days, or a text search on the title. Use for "<name>\'s tasks", "what is <name> working on", "high-priority tasks", "what is due this week", "open tasks in <project>".',
      inputSchema: z.object({
        assignee: z
          .string()
          .nullish()
          .describe('Person name (e.g. "Aisha") or "me" for the current user'),
        projectName: z.string().nullish().describe('Limit to a project (fuzzy name match)'),
        status: z.enum(['open', 'done', 'all']).nullish().describe('Default: open'),
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).nullish(),
        overdue: z.boolean().nullish().describe('Only tasks past their due date'),
        dueWithinDays: z.number().int().nullish().describe('Only tasks due within this many days'),
        query: z.string().nullish().describe('Text search on the task title'),
      }),
      execute: async ({ assignee, projectName, status, priority, overdue, dueWithinDays, query }) => {
        const filters: Prisma.TaskWhereInput[] = [taskVisibility()];
        let interpreted: string | undefined;
        let resolvedAssignee: string | undefined;
        let resolvedProject: string | undefined;

        // Assignee resolution (the screenshot bug — "Ayesha" → "Aisha Khan").
        if (assignee) {
          if (norm(assignee) === 'me' || norm(assignee) === 'myself' || norm(assignee) === 'i') {
            filters.push({ assignees: { some: { userId: ctx.userId } } });
          } else {
            const r = await resolvePerson(assignee, { includeInactive: true });
            if (r.kind === 'notfound') return { error: `No team member matches "${assignee}".` };
            if (r.kind === 'ambiguous')
              return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };
            filters.push({ assignees: { some: { userId: r.value.id } } });
            resolvedAssignee = r.value.name;
            if (r.interpreted) interpreted = `Interpreted "${assignee}" as ${r.value.name}.`;
          }
        }

        // Project resolution.
        if (projectName) {
          const projects = await db.project.findMany({
            where: isAdmin ? {} : { members: { some: { userId: ctx.userId } } },
            select: { id: true, name: true },
          });
          const r = resolveNamed(projectName, projects);
          if (r.kind === 'notfound') return { error: `No project matches "${projectName}".` };
          if (r.kind === 'ambiguous')
            return { needsClarification: `Which project — ${r.candidates.join(', ')}?` };
          filters.push({ column: { board: { projectId: r.value.id } } });
          resolvedProject = r.value.name;
        }

        // Status (open vs done).
        const statusMode = status ?? (overdue ? 'open' : 'open');
        if (statusMode === 'open') filters.push({ column: { name: { notIn: DONE_COLUMNS } } });
        else if (statusMode === 'done') filters.push({ column: { name: { in: DONE_COLUMNS } } });

        if (priority) filters.push({ priority });
        if (overdue) filters.push({ dueDate: { lt: now() } });
        if (dueWithinDays != null) {
          const until = new Date(now().getTime() + dueWithinDays * 86_400_000);
          filters.push({ dueDate: { gte: now(), lte: until } });
        }
        if (query) filters.push({ title: { contains: query, mode: 'insensitive' } });

        const tasks = await db.task.findMany({
          where: { AND: filters },
          take: 60,
          orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }],
          select: {
            id: true,
            title: true,
            priority: true,
            dueDate: true,
            column: { select: { name: true, board: { select: { project: { select: { name: true } } } } } },
            assignees: { select: { user: { select: { name: true } } } },
          },
        });

        return {
          count: tasks.length,
          resolvedAssignee,
          resolvedProject,
          note: interpreted,
          tasks: tasks.map(compactTask),
        };
      },
    }),

    listMyTasks: tool({
      description:
        'List tasks assigned to the CURRENT user (you), with project, status and due date. Use for "my tasks", "my to-dos", "what am I working on".',
      inputSchema: z.object({}),
      execute: async () => {
        const tasks = await db.task.findMany({
          where: { assignees: { some: { userId: ctx.userId } } },
          take: 60,
          orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
          select: {
            id: true,
            title: true,
            priority: true,
            dueDate: true,
            column: { select: { name: true, board: { select: { project: { select: { name: true } } } } } },
            assignees: { select: { user: { select: { name: true } } } },
          },
        });
        return tasks.map(compactTask);
      },
    }),

    findOverdueTasks: tool({
      description:
        'Find ALL OVERDUE tasks across the team (past due, not done) and who they are assigned to. Use for "who is behind / falling behind / lagging", "overdue work", "what is late" — when no specific person is named. For one person\'s overdue tasks, use searchTasks instead.',
      inputSchema: z.object({}),
      execute: async () => {
        const tasks = await db.task.findMany({
          where: {
            AND: [
              { dueDate: { lt: now() } },
              { column: { name: { notIn: DONE_COLUMNS } } },
              taskVisibility(),
            ],
          },
          take: 100,
          orderBy: { dueDate: 'asc' },
          select: {
            id: true,
            title: true,
            priority: true,
            dueDate: true,
            column: { select: { name: true, board: { select: { project: { select: { name: true } } } } } },
            assignees: { select: { user: { select: { name: true } } } },
          },
        });
        return tasks.map((t) => ({
          ...compactTask(t),
          daysOverdue: t.dueDate
            ? Math.floor((now().getTime() - t.dueDate.getTime()) / 86_400_000)
            : null,
        }));
      },
    }),

    // ──────────────────────────────── PROJECTS ──────────────────────────────
    listProjects: tool({
      description:
        'List projects in the hub (name, status, type, client). Use to find a project, get an overview, or before a deeper lookup.',
      inputSchema: z.object({
        status: z
          .enum(['ACTIVE', 'IN_DEVELOPMENT', 'ON_HOLD', 'COMPLETED', 'CANCELLED'])
          .nullish()
          .describe('Optional status filter'),
        query: z.string().nullish().describe('Optional name search'),
      }),
      execute: async ({ status, query }) => {
        const projects = await db.project.findMany({
          where: {
            ...(status ? { status } : {}),
            ...(isAdmin ? {} : { members: { some: { userId: ctx.userId } } }),
          },
          take: 60,
          orderBy: { updatedAt: 'desc' },
          select: {
            id: true,
            name: true,
            status: true,
            type: true,
            endDate: true,
            client: { select: { name: true } },
          },
        });
        const filtered = query ? projects.filter((p) => matchScore(query, p.name) > 0) : projects;
        return filtered.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          type: p.type,
          client: p.client?.name ?? null,
          endDate: p.endDate,
        }));
      },
    }),

    getProject: tool({
      description:
        'A deep dive on ONE project: status, client, description, tech stack, dates, team members, milestones (with overdue flags), and a board summary (tasks open / done / overdue per column). Use for "tell me about <project>", "status of <project>", "who is on <project>". Give the project name.',
      inputSchema: z.object({
        name: z.string().describe('The project name (fuzzy match), e.g. "Hearthly"'),
      }),
      execute: async ({ name }) => {
        const projects = await db.project.findMany({
          where: isAdmin ? {} : { members: { some: { userId: ctx.userId } } },
          select: { id: true, name: true },
        });
        const r = resolveNamed(name, projects);
        if (r.kind === 'notfound')
          return { error: `No project matches "${name}"${isAdmin ? '' : ' that you can access'}.` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which project — ${r.candidates.join(', ')}?` };

        const p = await db.project.findUnique({
          where: { id: r.value.id },
          select: {
            name: true,
            description: true,
            status: true,
            type: true,
            techStack: true,
            startDate: true,
            endDate: true,
            budget: true,
            client: { select: { name: true } },
            members: { select: { role: true, user: { select: { name: true, title: true } } } },
            milestones: {
              orderBy: { dueDate: 'asc' },
              select: { name: true, dueDate: true, completedAt: true },
            },
            boards: {
              select: {
                columns: {
                  orderBy: { order: 'asc' },
                  select: {
                    name: true,
                    tasks: { select: { dueDate: true } },
                  },
                },
              },
            },
          },
        });
        if (!p) return { error: 'That project was not found.' };

        const columns = p.boards.flatMap((b) => b.columns);
        let open = 0;
        let done = 0;
        let overdue = 0;
        for (const c of columns) {
          const isDone = DONE_COLUMNS.includes(c.name);
          for (const t of c.tasks) {
            if (isDone) done++;
            else {
              open++;
              if (t.dueDate && t.dueDate < now()) overdue++;
            }
          }
        }

        return {
          name: p.name,
          description: p.description,
          status: p.status,
          type: p.type,
          client: p.client?.name ?? null,
          techStack: p.techStack,
          startDate: p.startDate,
          endDate: p.endDate,
          pastEndDate: !!p.endDate && p.endDate < now() && p.status !== 'COMPLETED',
          budget: isAdmin && p.budget != null ? Number(p.budget) : undefined,
          team: p.members.map((m) => ({ name: m.user.name, title: m.user.title, role: m.role })),
          milestones: p.milestones.map((m) => ({
            name: m.name,
            dueDate: m.dueDate,
            done: !!m.completedAt,
            overdue: !m.completedAt && m.dueDate < now(),
          })),
          tasks: { open, done, overdue },
          scopeNote: r.interpreted ? `Interpreted "${name}" as ${r.value.name}.` : undefined,
        };
      },
    }),

    findProjectsBehindSchedule: tool({
      description:
        'Find projects BEHIND SCHEDULE — past their end date or with overdue milestones, and not completed/cancelled. Use for "projects behind / at risk / late / slipping".',
      inputSchema: z.object({}),
      execute: async () => {
        const projects = await db.project.findMany({
          where: {
            status: { notIn: ['COMPLETED', 'CANCELLED'] },
            ...(isAdmin ? {} : { members: { some: { userId: ctx.userId } } }),
            OR: [
              { endDate: { lt: now() } },
              { milestones: { some: { dueDate: { lt: now() }, completedAt: null } } },
            ],
          },
          take: 50,
          orderBy: { endDate: 'asc' },
          select: {
            name: true,
            status: true,
            endDate: true,
            client: { select: { name: true } },
            milestones: {
              where: { dueDate: { lt: now() }, completedAt: null },
              select: { name: true, dueDate: true },
            },
          },
        });
        return projects.map((p) => ({
          name: p.name,
          status: p.status,
          client: p.client?.name ?? null,
          endDate: p.endDate,
          pastEndDate: p.endDate ? p.endDate < now() : false,
          overdueMilestones: p.milestones.map((m) => m.name),
        }));
      },
    }),

    // ──────────────────────────────── CLIENTS ───────────────────────────────
    listClients: tool({
      description: 'List clients / customers (name, industry, location, status, project count).',
      inputSchema: z.object({
        query: z.string().nullish().describe('Optional name search'),
      }),
      execute: async ({ query }) => {
        const clients = await db.client.findMany({
          where: isAdmin
            ? undefined
            : { projects: { some: { members: { some: { userId: ctx.userId } } } } },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            industry: true,
            location: true,
            status: true,
            _count: { select: { projects: true } },
          },
        });
        const filtered = query ? clients.filter((c) => matchScore(query, c.name) > 0) : clients;
        return filtered.map((c) => ({
          id: c.id,
          name: c.name,
          industry: c.industry ?? null,
          location: c.location ?? null,
          status: c.status,
          projects: c._count.projects,
        }));
      },
    }),

    getClient: tool({
      description:
        'A deep dive on ONE client: industry, location, status, contacts, their projects, and an invoice summary (counts; amounts are admin-only). Use for "tell me about <client>", "<client> contacts", "what do we do for <client>". Give the client name.',
      inputSchema: z.object({
        name: z.string().describe('The client name (fuzzy match)'),
      }),
      execute: async ({ name }) => {
        const clients = await db.client.findMany({
          where: isAdmin
            ? undefined
            : { projects: { some: { members: { some: { userId: ctx.userId } } } } },
          select: { id: true, name: true },
        });
        const r = resolveNamed(name, clients);
        if (r.kind === 'notfound')
          return { error: `No client matches "${name}"${isAdmin ? '' : ' that you can access'}.` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which client — ${r.candidates.join(', ')}?` };

        const c = await db.client.findUnique({
          where: { id: r.value.id },
          select: {
            name: true,
            industry: true,
            location: true,
            website: true,
            status: true,
            notes: true,
            contacts: {
              select: { name: true, role: true, email: true, phone: true, isPrimary: true },
            },
            projects: { select: { name: true, status: true } },
            invoices: { select: { status: true, total: true } },
          },
        });
        if (!c) return { error: 'That client was not found.' };

        const outstanding = c.invoices.filter((i) => i.status === 'SENT' || i.status === 'OVERDUE');
        return {
          name: c.name,
          industry: c.industry,
          location: c.location,
          website: c.website,
          status: c.status,
          notes: c.notes,
          contacts: c.contacts.map((ct) => ({
            name: ct.name,
            role: ct.role,
            email: ct.email,
            phone: ct.phone,
            primary: ct.isPrimary,
          })),
          projects: c.projects,
          invoices: {
            total: c.invoices.length,
            outstanding: outstanding.length,
            // Amounts are financial data → admin only.
            outstandingAmount: isAdmin
              ? outstanding.reduce((s, i) => s + Number(i.total), 0)
              : undefined,
          },
          scopeNote: r.interpreted ? `Interpreted "${name}" as ${c.name}.` : undefined,
        };
      },
    }),

    // ──────────────────────────── SCHEDULE / TIME ───────────────────────────
    listMeetings: tool({
      description:
        'List upcoming meetings (title, time, location, recurrence, attendees). Use for "my meetings", "what meetings do I have", "the schedule", "any meetings this week". Employees see meetings they created or are invited to; admins see all.',
      inputSchema: z.object({
        withinDays: z.number().int().nullish().describe('Only meetings starting within N days'),
      }),
      execute: async ({ withinDays }) => {
        const upperBound =
          withinDays != null ? new Date(now().getTime() + withinDays * 86_400_000) : undefined;
        const meetings = await db.meeting.findMany({
          where: {
            ...(isAdmin
              ? {}
              : {
                  OR: [
                    { createdById: ctx.userId },
                    { attendees: { some: { userId: ctx.userId } } },
                  ],
                }),
            OR: [{ endTime: { gte: now() } }, { recurrence: { not: null } }],
            ...(upperBound ? { startTime: { lte: upperBound } } : {}),
          },
          take: 30,
          orderBy: { startTime: 'asc' },
          select: {
            title: true,
            startTime: true,
            endTime: true,
            location: true,
            recurrence: true,
            attendees: { select: { user: { select: { name: true } } } },
          },
        });
        return meetings.map((m) => ({
          title: m.title,
          startTime: m.startTime,
          endTime: m.endTime,
          location: m.location,
          recurrence: m.recurrence,
          attendees: m.attendees.map((a) => a.user.name),
        }));
      },
    }),

    getLeaveOverview: tool({
      description:
        'Who is on leave or has time off requested (vacation / sick / remote), with dates and status. Use for "who is off", "is <name> on leave", "pending leave requests", "my time off". Employees see only their own requests; admins see everyone.',
      inputSchema: z.object({
        status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).nullish(),
        upcomingOnly: z.boolean().nullish().describe('Default true — hide past leave'),
      }),
      execute: async ({ status, upcomingOnly }) => {
        const leave = await db.leaveRequest.findMany({
          where: {
            ...(isAdmin ? {} : { userId: ctx.userId }),
            ...(status ? { status } : {}),
            ...(upcomingOnly === false ? {} : { endDate: { gte: now() } }),
          },
          take: 50,
          orderBy: { startDate: 'asc' },
          select: {
            type: true,
            startDate: true,
            endDate: true,
            status: true,
            reason: true,
            user: { select: { name: true } },
          },
        });
        return leave.map((l) => ({
          person: l.user.name,
          type: l.type,
          startDate: l.startDate,
          endDate: l.endDate,
          status: l.status,
          reason: l.reason,
        }));
      },
    }),

    // ──────────────────────────── KNOWLEDGE / NOTES ──────────────────────────
    searchNotes: tool({
      description:
        'Search the knowledge base of written notes / docs (titles + content) that you are allowed to see — your own notes, team-wide notes, and notes shared with you. Optionally scope to a project or client. Use for "do we have notes on <topic>", "find the doc about <X>", "<project> notes".',
      inputSchema: z.object({
        query: z.string().nullish().describe('Text to search in note title/content'),
        projectName: z.string().nullish(),
        clientName: z.string().nullish(),
      }),
      execute: async ({ query, projectName, clientName }) => {
        const visibility: Prisma.NoteWhereInput = {
          OR: [
            { authorId: ctx.userId },
            { visibility: 'TEAM' },
            { visibility: 'SHARED', shares: { some: { userId: ctx.userId } } },
          ],
        };
        const filters: Prisma.NoteWhereInput[] = [visibility];
        if (query) {
          filters.push({
            OR: [
              { title: { contains: query, mode: 'insensitive' } },
              { contentText: { contains: query, mode: 'insensitive' } },
            ],
          });
        }
        if (projectName) {
          const projects = await db.project.findMany({ select: { id: true, name: true } });
          const r = resolveNamed(projectName, projects);
          if (r.kind === 'resolved') filters.push({ projectId: r.value.id });
        }
        if (clientName) {
          const clients = await db.client.findMany({ select: { id: true, name: true } });
          const r = resolveNamed(clientName, clients);
          if (r.kind === 'resolved') filters.push({ clientId: r.value.id });
        }

        const notes = await db.note.findMany({
          where: { AND: filters },
          take: 20,
          orderBy: { updatedAt: 'desc' },
          select: {
            title: true,
            contentText: true,
            updatedAt: true,
            visibility: true,
            author: { select: { name: true } },
            project: { select: { name: true } },
            client: { select: { name: true } },
          },
        });
        return notes.map((n) => ({
          title: n.title,
          author: n.author.name,
          project: n.project?.name ?? null,
          client: n.client?.name ?? null,
          updatedAt: n.updatedAt,
          snippet: n.contentText.slice(0, 200),
        }));
      },
    }),

    getRecentActivity: tool({
      description:
        'Recent activity across the hub — what changed lately (tasks created, projects updated, invoices, etc.). Use for "what is happening", "recent updates", "what is new", "latest activity". Employees see their own activity and activity on their projects; admins see everything.',
      inputSchema: z.object({
        withinDays: z.number().int().nullish().describe('Default 14'),
      }),
      execute: async ({ withinDays }) => {
        const since = new Date(now().getTime() - (withinDays ?? 14) * 86_400_000);
        let where: Prisma.ActivityWhereInput = { createdAt: { gte: since } };
        if (!isAdmin) {
          const pids = await myProjectIds();
          where = {
            createdAt: { gte: since },
            OR: [
              { userId: ctx.userId },
              { entityType: 'Project', entityId: { in: pids } },
            ],
          };
        }
        const activity = await db.activity.findMany({
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
    }),

    getOverview: tool({
      description:
        'A personalized briefing for the current user — your open/overdue tasks and what is due soon, your upcoming meetings, pending leave, and your active projects (plus company-wide headline numbers if you are an admin). Use for "what should I focus on", "brief me", "my day", "summary", "catch me up".',
      inputSchema: z.object({}),
      execute: async () => {
        const weekAhead = new Date(now().getTime() + 7 * 86_400_000);
        const [myTasks, myMeetings, myLeave, myProjects] = await Promise.all([
          db.task.findMany({
            where: {
              assignees: { some: { userId: ctx.userId } },
              column: { name: { notIn: DONE_COLUMNS } },
            },
            select: { title: true, dueDate: true, priority: true },
          }),
          db.meeting.count({
            where: {
              OR: [{ createdById: ctx.userId }, { attendees: { some: { userId: ctx.userId } } }],
              startTime: { gte: now(), lte: weekAhead },
            },
          }),
          db.leaveRequest.count({ where: { userId: ctx.userId, status: 'PENDING' } }),
          db.project.count({
            where: { status: { in: ['ACTIVE', 'IN_DEVELOPMENT'] }, members: { some: { userId: ctx.userId } } },
          }),
        ]);
        const overdue = myTasks.filter((t) => t.dueDate && t.dueDate < now());
        const dueThisWeek = myTasks.filter(
          (t) => t.dueDate && t.dueDate >= now() && t.dueDate <= weekAhead
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
              .sort((a, b) => (a.dueDate!.getTime() - b.dueDate!.getTime()))
              .slice(0, 3)
              .map((t) => ({ title: t.title, dueDate: t.dueDate, priority: t.priority })),
          },
        };

        if (isAdmin) {
          const [overdueTeam, behind, outstanding] = await Promise.all([
            db.task.count({
              where: { dueDate: { lt: now() }, column: { name: { notIn: DONE_COLUMNS } } },
            }),
            db.project.count({
              where: {
                status: { notIn: ['COMPLETED', 'CANCELLED'] },
                OR: [
                  { endDate: { lt: now() } },
                  { milestones: { some: { dueDate: { lt: now() }, completedAt: null } } },
                ],
              },
            }),
            db.invoice.aggregate({
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
    }),

    // ──────────────────────────────── FINANCE ───────────────────────────────
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
        const today = now();
        const start = startDate
          ? new Date(startDate)
          : new Date(today.getFullYear(), today.getMonth(), 1);
        const end = endDate ? new Date(endDate) : today;

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

    listInvoices: tool({
      description:
        'List invoices with their client, total, status, due date and overdue flag. Use for "outstanding invoices", "unpaid invoices", "who owes us", "<client> invoices". ADMIN ONLY.',
      inputSchema: z.object({
        status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']).nullish(),
        clientName: z.string().nullish(),
        outstandingOnly: z.boolean().nullish().describe('Only SENT/OVERDUE (unpaid) invoices'),
      }),
      execute: async ({ status, clientName, outstandingOnly }) => {
        if (!isAdmin) return { error: 'Invoice data is restricted to administrators.' };
        const where: Prisma.InvoiceWhereInput = {};
        if (status) where.status = status;
        else if (outstandingOnly) where.status = { in: ['SENT', 'OVERDUE'] };
        if (clientName) {
          const clients = await db.client.findMany({ select: { id: true, name: true } });
          const r = resolveNamed(clientName, clients);
          if (r.kind === 'notfound') return { error: `No client matches "${clientName}".` };
          if (r.kind === 'ambiguous')
            return { needsClarification: `Which client — ${r.candidates.join(', ')}?` };
          where.clientId = r.value.id;
        }
        const invoices = await db.invoice.findMany({
          where,
          take: 50,
          orderBy: { dueDate: 'asc' },
          select: {
            invoiceNumber: true,
            total: true,
            currency: true,
            status: true,
            dueDate: true,
            paidAt: true,
            client: { select: { name: true } },
          },
        });
        return invoices.map((i) => ({
          invoiceNumber: i.invoiceNumber,
          client: i.client.name,
          total: Number(i.total),
          currency: i.currency,
          status: i.status,
          dueDate: i.dueDate,
          overdue: i.status !== 'PAID' && i.status !== 'CANCELLED' && i.dueDate < now(),
        }));
      },
    }),

    // ───────────────────────────────── WRITES ───────────────────────────────
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

    setTeamMemberStatus: tool({
      description:
        "Change a team member's status: deactivate / terminate / offboard (INACTIVE), reactivate (ACTIVE), or mark on leave (ON_LEAVE). ADMIN ONLY. Provide the member's name (or a userId from listTeam). Deactivating also emails the member a termination notice.",
      inputSchema: z.object({
        name: z.string().nullish().describe('Team member name, e.g. "Aisha Khan"'),
        userId: z.string().nullish().describe('User id from listTeam (preferred if known)'),
        status: z
          .enum(['ACTIVE', 'INACTIVE', 'ON_LEAVE'])
          .describe('INACTIVE = terminate / deactivate'),
      }),
      needsApproval: true,
      execute: async ({ name, userId, status }) => {
        if (!isAdmin) {
          return { error: "Only admins can change a team member's status." };
        }
        let target: { id: string; name: string; role: string; status: string } | null = null;
        if (userId) {
          target = await db.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, role: true, status: true },
          });
        } else if (name) {
          const matches = await db.user.findMany({
            where: { name: { contains: name, mode: 'insensitive' } },
            select: { id: true, name: true, role: true, status: true },
            take: 5,
          });
          if (matches.length === 0) return { error: `No team member found matching "${name}".` };
          if (matches.length > 1) {
            return {
              error: `Several members match "${name}": ${matches.map((m) => m.name).join(', ')}. Be more specific.`,
            };
          }
          target = matches[0];
        } else {
          return { error: "Provide the member's name or userId." };
        }
        if (!target) return { error: 'That team member was not found.' };
        if (target.id === ctx.userId) return { error: "You can't change your own status." };
        if (status === 'INACTIVE' && target.role === 'ADMIN') {
          const otherActiveAdmins = await db.user.count({
            where: { role: 'ADMIN', status: 'ACTIVE', id: { not: target.id } },
          });
          if (otherActiveAdmins === 0) {
            return { error: "Can't deactivate the last active admin." };
          }
        }
        const updated = await db.user.update({
          where: { id: target.id },
          data: { status },
          select: { id: true, name: true, email: true, status: true },
        });
        logActivity(db, ctx.userId, {
          type: 'member_status_changed',
          message: `set ${updated.name}'s status to ${status}`,
          entityType: 'User',
          entityId: updated.id,
        });
        // On deactivation, fire a termination email (fire-and-forget — never
        // blocks or fails the status change if email/env is unavailable).
        const justDeactivated = status === 'INACTIVE' && target.status !== 'INACTIVE';
        if (justDeactivated && updated.email) {
          const mail = templates.accountDeactivated({
            name: updated.name,
            byName: ctx.name ?? undefined,
          });
          sendEmail({
            to: { email: updated.email, name: updated.name },
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
          }).catch((err) => console.error('[assistant] termination email failed:', err));
        }
        return {
          id: updated.id,
          name: updated.name,
          status: updated.status,
          emailed: justDeactivated,
        };
      },
    }),
  };

  // Role-based access: non-admins don't even receive the admin-only tools, so
  // the model can't call them. (Each is also guarded inside execute — belt +
  // braces, in case the toolset is ever exposed.)
  if (!isAdmin) {
    delete (tools as Record<string, unknown>).getFinanceSummary;
    delete (tools as Record<string, unknown>).listInvoices;
    delete (tools as Record<string, unknown>).createClient;
    delete (tools as Record<string, unknown>).setTeamMemberStatus;
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
