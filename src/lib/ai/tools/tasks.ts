/**
 * TASK-level tools for the DevFathom assistant.
 *
 * The assistant is a full agentic operator of the hub, authorized identically
 * to the acting human. This file owns every TASK operation — search, detail,
 * create / update / move / delete, assignees, comments, checklist, and labels.
 * Project / board / column / milestone STRUCTURE lives in `tools/projects.ts`.
 *
 * Each tool mirrors the matching tRPC mutation in `src/server/routers/projects.ts`
 * EXACTLY: same authorization (object-level project access), same write logic
 * (ordering, column-default-assignees, etc.) and the same side effects
 * (Activity feed + in-app/email notifications). Every write authorizes the
 * owning project FIRST, sets `needsApproval: true`, and returns a structured
 * `{ error }` / `{ needsClarification }` instead of throwing.
 *
 * The model rarely has a raw id — task-targeting tools accept a task TITLE
 * (resolved among tasks the user can SEE; ambiguity asks which one) or, when
 * known, a task id. Ids are never surfaced unless the model asked for them.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { AssistantHelpers, ToolSet } from '@/lib/ai/context';
import { matchScore, norm } from '@/lib/ai/context';
import { appUrl, templates } from '@/lib/email';

// Format a task due date for emails, e.g. "Fri, Jun 20 · 5:00 PM". Mirrors the
// helper in the projects router so assistant-sent emails match human-sent ones.
function formatDue(date: Date): string {
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Deep link to a task on its board (matches the projects router).
function taskUrl(projectId: string, boardId: string, taskId: string): string {
  return `${appUrl()}/projects/${projectId}/board/${boardId}?task=${taskId}`;
}

export function buildTasksTools(h: AssistantHelpers): ToolSet {
  const tools: ToolSet = {};

  // ─────────────────────────── shared resolution ────────────────────────────

  // One canonical task projection, reused for every targeting query so the
  // inferred row type (`ResolvedTask`) is precise and carries the owning
  // project for the authorization check + activity/notification messages.
  const loadTasks = (where: Prisma.TaskWhereInput, take: number) =>
    h.db.task.findMany({
      where,
      take,
      select: {
        id: true,
        title: true,
        description: true,
        priority: true,
        dueDate: true,
        order: true,
        columnId: true,
        column: {
          select: {
            id: true,
            name: true,
            board: {
              select: {
                id: true,
                name: true,
                projectId: true,
                project: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });
  type ResolvedTask = Awaited<ReturnType<typeof loadTasks>>[number];

  type Fail = { ok: false; error?: string; needsClarification?: string };
  /** Convert an internal failure into the tool's structured return. */
  const asFail = (f: Fail) =>
    f.needsClarification
      ? { needsClarification: f.needsClarification }
      : { error: f.error ?? 'Could not complete that.' };

  /**
   * Resolve a task by id or (fuzzy) title within the tasks the viewer can SEE.
   * Never reveals a task outside the viewer's visibility.
   */
  async function resolveTask(args: {
    taskId?: string | null;
    title?: string | null;
  }): Promise<{ ok: true; task: ResolvedTask } | Fail> {
    if (args.taskId) {
      const rows = await loadTasks({ AND: [{ id: args.taskId }, h.taskVisibility()] }, 1);
      if (rows.length === 0)
        return { ok: false, error: 'No task with that id that you can access.' };
      return { ok: true, task: rows[0] };
    }
    const title = args.title?.trim();
    if (!title)
      return { ok: false, error: 'Provide a task title (or id) to identify which task you mean.' };

    let candidates = await loadTasks(
      { AND: [h.taskVisibility(), { title: { contains: title, mode: 'insensitive' } }] },
      25
    );
    if (candidates.length === 0) {
      // Fuzzy fallback over a bounded set of visible tasks (typo tolerance).
      const pool = await loadTasks(h.taskVisibility(), 400);
      const scored = pool
        .map((t) => ({ t, score: matchScore(title, t.title) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length === 0)
        return { ok: false, error: `No task matches "${title}" that you can see.` };
      const strong = scored.filter((s) => s.score >= 70);
      if (strong.length === 1) return { ok: true, task: strong[0].t };
      candidates = (strong.length > 0 ? strong : scored).slice(0, 8).map((s) => s.t);
    }

    const exact = candidates.filter((t) => norm(t.title) === norm(title));
    if (exact.length === 1) return { ok: true, task: exact[0] };
    if (candidates.length === 1) return { ok: true, task: candidates[0] };
    const list = candidates
      .slice(0, 8)
      .map((t) => `"${t.title}" in ${t.column.board.project.name}`)
      .join('; ');
    return {
      ok: false,
      needsClarification: `Several tasks match "${title}": ${list}. Which one did you mean?`,
    };
  }

  /** ADMIN or a member of the task's owning project (member-level write gate). */
  const canWriteTask = (task: ResolvedTask): Promise<boolean> =>
    h.canAccessProject(task.column.board.projectId);

  /** Resolve a single assignee name (or "me") to a user id. */
  async function resolveAssignee(
    nameRaw: string
  ): Promise<{ ok: true; id: string; name: string } | Fail> {
    if (['me', 'myself', 'i', 'my'].includes(norm(nameRaw)))
      return { ok: true, id: h.ctx.userId, name: h.ctx.name ?? 'you' };
    const r = await h.resolvePerson(nameRaw);
    if (r.kind === 'notfound') return { ok: false, error: `No team member matches "${nameRaw}".` };
    if (r.kind === 'ambiguous')
      return { ok: false, needsClarification: `Which one — ${r.candidates.join(', ')}?` };
    return { ok: true, id: r.value.id, name: r.value.name };
  }

  /** Resolve a target project for task creation by id or (fuzzy) name. */
  async function resolveProjectTarget(
    projectId?: string | null,
    projectName?: string | null
  ): Promise<{ ok: true; id: string; name: string } | Fail> {
    if (projectId) {
      const p = await h.db.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true },
      });
      if (!p) return { ok: false, error: 'No project found with that id.' };
      return { ok: true, id: p.id, name: p.name };
    }
    if (projectName) {
      const projects = await h.db.project.findMany({
        where: h.isAdmin ? {} : { members: { some: { userId: h.ctx.userId } } },
        select: { id: true, name: true },
      });
      const r = h.resolveNamed(projectName, projects);
      if (r.kind === 'notfound')
        return {
          ok: false,
          error: `No project matches "${projectName}"${h.isAdmin ? '' : ' that you can access'}.`,
        };
      if (r.kind === 'ambiguous')
        return { ok: false, needsClarification: `Which project — ${r.candidates.join(', ')}?` };
      return { ok: true, id: r.value.id, name: r.value.name };
    }
    return { ok: false, error: 'Provide a project name (or id) for the task.' };
  }

  // Shared task-targeting input fragment.
  const taskRef = {
    taskTitle: z
      .string()
      .nullish()
      .describe('The task title — resolved among tasks you can see; ambiguity asks which one.'),
    taskId: z.string().nullish().describe('The task id, if you already have it from another tool.'),
  };

  // ════════════════════════════════ READS ═══════════════════════════════════

  tools.searchTasks = tool({
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
      const filters: Prisma.TaskWhereInput[] = [h.taskVisibility()];
      let interpreted: string | undefined;
      let resolvedAssignee: string | undefined;
      let resolvedProject: string | undefined;

      if (assignee) {
        if (norm(assignee) === 'me' || norm(assignee) === 'myself' || norm(assignee) === 'i') {
          filters.push({ assignees: { some: { userId: h.ctx.userId } } });
        } else {
          const r = await h.resolvePerson(assignee, { includeInactive: true });
          if (r.kind === 'notfound') return { error: `No team member matches "${assignee}".` };
          if (r.kind === 'ambiguous')
            return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };
          filters.push({ assignees: { some: { userId: r.value.id } } });
          resolvedAssignee = r.value.name;
          if (r.interpreted) interpreted = `Interpreted "${assignee}" as ${r.value.name}.`;
        }
      }

      if (projectName) {
        const projects = await h.db.project.findMany({
          where: h.isAdmin ? {} : { members: { some: { userId: h.ctx.userId } } },
          select: { id: true, name: true },
        });
        const r = h.resolveNamed(projectName, projects);
        if (r.kind === 'notfound') return { error: `No project matches "${projectName}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which project — ${r.candidates.join(', ')}?` };
        filters.push({ column: { board: { projectId: r.value.id } } });
        resolvedProject = r.value.name;
      }

      const statusMode = status ?? 'open';
      if (statusMode === 'open') filters.push({ column: { name: { notIn: h.DONE_COLUMNS } } });
      else if (statusMode === 'done') filters.push({ column: { name: { in: h.DONE_COLUMNS } } });

      if (priority) filters.push({ priority });
      if (overdue) filters.push({ dueDate: { lt: h.now() } });
      if (dueWithinDays != null) {
        const until = new Date(h.now().getTime() + dueWithinDays * 86_400_000);
        filters.push({ dueDate: { gte: h.now(), lte: until } });
      }
      if (query) filters.push({ title: { contains: query, mode: 'insensitive' } });

      const tasks = await h.db.task.findMany({
        where: { AND: filters },
        take: 60,
        orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }],
        select: {
          id: true,
          title: true,
          priority: true,
          dueDate: true,
          column: {
            select: { name: true, board: { select: { project: { select: { name: true } } } } },
          },
          assignees: { select: { user: { select: { name: true } } } },
        },
      });

      return {
        count: tasks.length,
        resolvedAssignee,
        resolvedProject,
        note: interpreted,
        tasks: tasks.map(h.compactTask),
      };
    },
  });

  tools.listMyTasks = tool({
    description:
      'List tasks assigned to the CURRENT user (you), with project, status and due date. Use for "my tasks", "my to-dos", "what am I working on".',
    inputSchema: z.object({}),
    execute: async () => {
      const tasks = await h.db.task.findMany({
        where: { assignees: { some: { userId: h.ctx.userId } } },
        take: 60,
        orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        select: {
          id: true,
          title: true,
          priority: true,
          dueDate: true,
          column: {
            select: { name: true, board: { select: { project: { select: { name: true } } } } },
          },
          assignees: { select: { user: { select: { name: true } } } },
        },
      });
      return tasks.map(h.compactTask);
    },
  });

  tools.findOverdueTasks = tool({
    description:
      'Find ALL OVERDUE tasks across the team (past due, not done) and who they are assigned to. Use for "who is behind / falling behind / lagging", "overdue work", "what is late" — when no specific person is named. For one person\'s overdue tasks, use searchTasks instead.',
    inputSchema: z.object({}),
    execute: async () => {
      const tasks = await h.db.task.findMany({
        where: {
          AND: [
            { dueDate: { lt: h.now() } },
            { column: { name: { notIn: h.DONE_COLUMNS } } },
            h.taskVisibility(),
          ],
        },
        take: 100,
        orderBy: { dueDate: 'asc' },
        select: {
          id: true,
          title: true,
          priority: true,
          dueDate: true,
          column: {
            select: { name: true, board: { select: { project: { select: { name: true } } } } },
          },
          assignees: { select: { user: { select: { name: true } } } },
        },
      });
      return tasks.map((t) => ({
        ...h.compactTask(t),
        daysOverdue: t.dueDate
          ? Math.floor((h.now().getTime() - t.dueDate.getTime()) / 86_400_000)
          : null,
      }));
    },
  });

  tools.getTaskDetail = tool({
    description:
      'A deep view of ONE task: description, project/board, status column, priority, due date, assignees, labels, checklist items (with done state), and the comment thread. Use for "tell me about the <title> task", "what is left on <task>", "show the comments on <task>". Give the task title (or id).',
    inputSchema: z.object({ ...taskRef }),
    execute: async ({ taskTitle, taskId }) => {
      const r = await resolveTask({ taskId, title: taskTitle });
      if (!r.ok) return asFail(r);
      const { task } = r;

      const detail = await h.db.task.findUnique({
        where: { id: task.id },
        select: {
          title: true,
          description: true,
          priority: true,
          dueDate: true,
          createdAt: true,
          column: {
            select: {
              name: true,
              board: { select: { name: true, project: { select: { name: true } } } },
            },
          },
          createdBy: { select: { name: true } },
          assignees: { select: { user: { select: { name: true, title: true } } } },
          labels: { select: { label: { select: { name: true, color: true } } } },
          checklists: {
            orderBy: { order: 'asc' },
            select: {
              name: true,
              items: { orderBy: { order: 'asc' }, select: { text: true, completed: true } },
            },
          },
          comments: {
            where: { parentId: null },
            orderBy: { createdAt: 'asc' },
            select: {
              content: true,
              createdAt: true,
              user: { select: { name: true } },
              replies: {
                orderBy: { createdAt: 'asc' },
                select: { content: true, createdAt: true, user: { select: { name: true } } },
              },
            },
          },
        },
      });
      if (!detail) return { error: 'That task was no longer available.' };

      const status = detail.column.name;
      return {
        title: detail.title,
        description: detail.description,
        project: detail.column.board.project.name,
        board: detail.column.board.name,
        status,
        priority: detail.priority,
        dueDate: detail.dueDate,
        overdue: !!detail.dueDate && detail.dueDate < h.now() && !h.DONE_COLUMNS.includes(status),
        createdBy: detail.createdBy.name,
        assignees: detail.assignees.map((a) => a.user.name),
        labels: detail.labels.map((l) => l.label.name),
        checklists: detail.checklists.map((c) => ({
          name: c.name,
          items: c.items.map((i) => ({ text: i.text, done: i.completed })),
          progress: `${c.items.filter((i) => i.completed).length}/${c.items.length}`,
        })),
        comments: detail.comments.map((c) => ({
          author: c.user.name,
          content: c.content,
          when: c.createdAt,
          replies: c.replies.map((rp) => ({
            author: rp.user.name,
            content: rp.content,
            when: rp.createdAt,
          })),
        })),
      };
    },
  });

  // ═══════════════════════════════ WRITES ═══════════════════════════════════

  tools.createTask = tool({
    description:
      'Create a task in a project and (optionally) assign people to it. Identify the project by name (or id). The task lands in the named column (default "To Do" / the first column) and is assigned to YOU unless you name other assignees. Newly-assigned teammates are notified by email. Use for "add a task to <project>", "create a bug for <name> in <project>".',
    inputSchema: z.object({
      projectName: z
        .string()
        .nullish()
        .describe('Project to create the task in (fuzzy name match)'),
      projectId: z.string().nullish().describe('Project id, if already known'),
      title: z.string().min(1),
      description: z.string().nullish(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).nullish().describe('Default MEDIUM'),
      dueDate: z.string().nullish().describe('ISO date, e.g. 2026-07-01'),
      columnName: z.string().nullish().describe('Target column, e.g. "To Do" or "In Progress"'),
      assignees: z
        .array(z.string())
        .nullish()
        .describe('Names to assign (or "me"); defaults to you when omitted'),
    }),
    needsApproval: true,
    execute: async ({
      projectName,
      projectId,
      title,
      description,
      priority,
      dueDate,
      columnName,
      assignees,
    }) => {
      const proj = await resolveProjectTarget(projectId, projectName);
      if (!proj.ok) return asFail(proj);
      // Object-level authz BEFORE touching the board, mirroring the router.
      if (!(await h.canAccessProject(proj.id)))
        return { error: 'You do not have access to that project.' };

      const board = await h.db.board.findFirst({
        where: { projectId: proj.id },
        select: {
          id: true,
          name: true,
          columns: { orderBy: { order: 'asc' }, select: { id: true, name: true } },
        },
      });
      if (!board || board.columns.length === 0)
        return { error: 'That project has no board or columns to add a task to.' };

      const column =
        (columnName
          ? board.columns.find((c) => c.name.toLowerCase() === columnName.toLowerCase())
          : undefined) ??
        board.columns.find((c) => c.name.toLowerCase() === 'to do') ??
        board.columns[0];

      let dueAt: Date | null = null;
      if (dueDate != null) {
        const d = new Date(dueDate);
        if (isNaN(d.getTime())) return { error: `Could not parse due date "${dueDate}".` };
        dueAt = d;
      }

      // Resolve named assignees → ids; default to the current user.
      const assigneeIds: string[] = [];
      if (assignees && assignees.length) {
        for (const nm of assignees) {
          const a = await resolveAssignee(nm);
          if (!a.ok) return asFail(a);
          assigneeIds.push(a.id);
        }
      }
      if (assigneeIds.length === 0) assigneeIds.push(h.ctx.userId);

      // Merge the column's default assignees (additive), mirroring the router.
      const columnDefaults = await h.db.columnDefaultAssignee.findMany({
        where: { columnId: column.id },
        select: { userId: true },
      });
      const merged = [...new Set([...assigneeIds, ...columnDefaults.map((d) => d.userId)])];

      const maxOrder = await h.db.task.aggregate({
        _max: { order: true },
        where: { columnId: column.id },
      });
      const task = await h.db.task.create({
        data: {
          title,
          description: description ?? null,
          columnId: column.id,
          order: (maxOrder._max.order ?? -1) + 1,
          priority: priority ?? 'MEDIUM',
          dueDate: dueAt,
          createdById: h.ctx.userId,
          assignees: { create: merged.map((id) => ({ userId: id })) },
        },
        select: { id: true, title: true, priority: true, dueDate: true, description: true },
      });

      h.activity({
        type: 'task_created',
        message: `created task "${task.title}" in ${proj.name}`,
        entityType: 'Task',
        entityId: task.id,
      });

      // Notify everyone newly assigned except the creator (taskAssigned email).
      const newAssignees = merged.filter((id) => id !== h.ctx.userId);
      if (newAssignees.length > 0) {
        const url = taskUrl(proj.id, board.id, task.id);
        const due = task.dueDate ? formatDue(task.dueDate) : undefined;
        h.notifyUsers(newAssignees, {
          type: 'task_assigned',
          title: 'New task assigned',
          message: `${h.ctx.name ?? 'Someone'} assigned you “${task.title}” in ${proj.name}`,
          entityType: 'Task',
          entityId: task.id,
          email: (rcpt) =>
            templates.taskAssigned({
              assigneeName: rcpt.name,
              taskTitle: task.title,
              projectName: proj.name,
              boardName: board.name,
              priority: task.priority,
              dueDate: due,
              assignedByName: h.ctx.name ?? 'A teammate',
              description: task.description ?? undefined,
              url,
            }),
        });
      }

      const names = await h.db.user.findMany({
        where: { id: { in: merged } },
        select: { name: true },
      });
      h.audit({
        category: 'TASK',
        action: 'task.create',
        operation: 'CREATE',
        targetType: 'Task',
        targetId: task.id,
        targetLabel: task.title,
        metadata: { project: proj.name, column: column.name },
      });

      return {
        id: task.id,
        title: task.title,
        project: proj.name,
        column: column.name,
        assignees: names.map((n) => n.name),
      };
    },
  });

  tools.updateTask = tool({
    description:
      'Edit a task\'s title, description, priority, or due date. Identify the task by title (or id). Set clearDueDate=true to remove an existing due date. Use for "rename the <task> task", "set <task> to high priority", "push <task>\'s due date to Friday".',
    inputSchema: z.object({
      ...taskRef,
      title: z.string().min(1).nullish().describe('New title'),
      description: z.string().nullish().describe('New description'),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).nullish(),
      dueDate: z.string().nullish().describe('New due date, ISO, e.g. 2026-07-01'),
      clearDueDate: z.boolean().nullish().describe('Set true to remove the due date'),
    }),
    needsApproval: true,
    execute: async ({ taskTitle, taskId, title, description, priority, dueDate, clearDueDate }) => {
      const r = await resolveTask({ taskId, title: taskTitle });
      if (!r.ok) return asFail(r);
      const { task } = r;
      if (!(await canWriteTask(task)))
        return { error: 'You do not have access to that task’s project.' };

      const data: Prisma.TaskUpdateInput = {};
      if (title != null) data.title = title;
      if (description != null) data.description = description;
      if (priority != null) data.priority = priority;
      if (clearDueDate) {
        data.dueDate = null;
      } else if (dueDate != null) {
        const d = new Date(dueDate);
        if (isNaN(d.getTime())) return { error: `Could not parse due date "${dueDate}".` };
        data.dueDate = d;
      }
      if (Object.keys(data).length === 0)
        return {
          error: 'Nothing to update — provide a new title, description, priority, or due date.',
        };

      const updated = await h.db.task.update({
        where: { id: task.id },
        data,
        select: { title: true, priority: true, dueDate: true },
      });
      h.audit({
        category: 'TASK',
        action: 'task.update',
        operation: 'UPDATE',
        targetType: 'Task',
        targetId: task.id,
        targetLabel: updated.title,
        changes: Object.fromEntries(
          Object.keys(data).map((k) => [
            k,
            { before: undefined, after: (data as Record<string, unknown>)[k] },
          ])
        ),
      });
      return {
        success: true,
        task: updated.title,
        priority: updated.priority,
        dueDate: updated.dueDate,
      };
    },
  });

  tools.moveTask = tool({
    description:
      'Move a task to a different status column on its board (e.g. "In Progress", "Done"). Identify the task by title (or id) and give the destination column name. Moving into a Done column marks it completed. Column owners are auto-assigned. Use for "move <task> to In Progress", "mark <task> done".',
    inputSchema: z.object({
      ...taskRef,
      columnName: z.string().describe('Destination column name, e.g. "In Progress" or "Done"'),
    }),
    needsApproval: true,
    execute: async ({ taskTitle, taskId, columnName }) => {
      const r = await resolveTask({ taskId, title: taskTitle });
      if (!r.ok) return asFail(r);
      const { task } = r;
      if (!(await canWriteTask(task)))
        return { error: 'You do not have access to that task’s project.' };

      const columns = await h.db.column.findMany({
        where: { boardId: task.column.board.id },
        select: { id: true, name: true },
      });
      const target = columns.find((c) => c.name.toLowerCase() === columnName.toLowerCase());
      if (!target)
        return {
          error: `No column named "${columnName}" on this board. Available: ${columns
            .map((c) => c.name)
            .join(', ')}.`,
        };
      if (target.id === task.columnId)
        return { success: true, note: `Task is already in ${target.name}.` };

      // Append to the bottom of the destination column.
      const maxOrder = await h.db.task.aggregate({
        _max: { order: true },
        where: { columnId: target.id },
      });
      const newOrder = (maxOrder._max.order ?? -1) + 1;

      await h.db.$transaction(async (tx) => {
        // Close the gap left in the source column.
        await tx.task.updateMany({
          where: { columnId: task.columnId, order: { gt: task.order } },
          data: { order: { decrement: 1 } },
        });
        // Make room in the target column (no-op when appending at the end).
        await tx.task.updateMany({
          where: { columnId: target.id, order: { gte: newOrder } },
          data: { order: { increment: 1 } },
        });
        await tx.task.update({
          where: { id: task.id },
          data: { columnId: target.id, order: newOrder },
        });
        // Auto-assign the target column's default assignees (additive).
        const defaults = await tx.columnDefaultAssignee.findMany({
          where: { columnId: target.id },
          select: { userId: true },
        });
        if (defaults.length > 0) {
          await tx.taskAssignee.createMany({
            data: defaults.map((d) => ({ taskId: task.id, userId: d.userId })),
            skipDuplicates: true,
          });
        }
      });

      // Completion: entering a Done column from a non-Done one.
      const enteringDone =
        h.DONE_COLUMNS.includes(target.name) && !h.DONE_COLUMNS.includes(task.column.name);
      if (enteringDone) {
        h.activity({
          type: 'task_completed',
          message: `completed task "${task.title}" in ${task.column.board.project.name}`,
          entityType: 'Task',
          entityId: task.id,
        });
      }
      h.audit({
        category: 'TASK',
        action: 'task.move',
        operation: 'UPDATE',
        targetType: 'Task',
        targetId: task.id,
        targetLabel: task.title,
        changes: { column: { before: task.column.name, after: target.name } },
      });

      return {
        success: true,
        task: task.title,
        from: task.column.name,
        to: target.name,
        completed: enteringDone,
      };
    },
  });

  tools.deleteTask = tool({
    description:
      'Permanently delete a task (and its comments, checklist, labels). Only a project LEAD or an admin may delete. Identify it by title (or id). This cannot be undone. Use for "delete the <title> task".',
    inputSchema: z.object({ ...taskRef }),
    needsApproval: true,
    execute: async ({ taskTitle, taskId }) => {
      const r = await resolveTask({ taskId, title: taskTitle });
      if (!r.ok) return asFail(r);
      const { task } = r;
      if (!(await h.canManageProject(task.column.board.projectId)))
        return { error: 'You do not have access to that task’s project.' };

      await h.db.task.delete({ where: { id: task.id } });
      h.audit({
        category: 'TASK',
        action: 'task.delete',
        operation: 'DELETE',
        targetType: 'Task',
        targetId: task.id,
        targetLabel: task.title,
        metadata: { project: task.column.board.project.name },
      });
      return { success: true, deleted: task.title, project: task.column.board.project.name };
    },
  });

  tools.setTaskAssignees = tool({
    description:
      'Change who a task is assigned to. Identify the task by title (or id) and give people by name (or "me"). mode "replace" (default) sets the exact list, "add" appends, "remove" unassigns. Newly-assigned teammates get a task-assigned email. Use for "assign <task> to <name>", "add <name> to <task>", "unassign <name> from <task>".',
    inputSchema: z.object({
      ...taskRef,
      assignees: z
        .array(z.string())
        .describe('People by name (or "me"); empty list clears in replace mode'),
      mode: z.enum(['replace', 'add', 'remove']).nullish().describe('Default replace'),
    }),
    needsApproval: true,
    execute: async ({ taskTitle, taskId, assignees, mode }) => {
      const r = await resolveTask({ taskId, title: taskTitle });
      if (!r.ok) return asFail(r);
      const { task } = r;
      if (!(await canWriteTask(task)))
        return { error: 'You do not have access to that task’s project.' };

      const resolvedIds: string[] = [];
      for (const nm of assignees) {
        const a = await resolveAssignee(nm);
        if (!a.ok) return asFail(a);
        resolvedIds.push(a.id);
      }
      const resolvedSet = [...new Set(resolvedIds)];

      const existing = await h.db.taskAssignee.findMany({
        where: { taskId: task.id },
        select: { userId: true },
      });
      const existingIds = new Set(existing.map((e) => e.userId));

      const m = mode ?? 'replace';
      let final: string[];
      if (m === 'add') final = [...new Set([...existingIds, ...resolvedSet])];
      else if (m === 'remove') final = [...existingIds].filter((id) => !resolvedSet.includes(id));
      else final = resolvedSet;

      // Mirror updateTaskAssignees: full replace of the assignee set.
      await h.db.taskAssignee.deleteMany({ where: { taskId: task.id } });
      if (final.length > 0) {
        await h.db.taskAssignee.createMany({
          data: final.map((userId) => ({ taskId: task.id, userId })),
        });
      }

      // Notify the newly-added (never the actor, never re-notify).
      const added = final.filter((id) => !existingIds.has(id) && id !== h.ctx.userId);
      if (added.length > 0) {
        const board = task.column.board;
        const url = taskUrl(board.projectId, board.id, task.id);
        const due = task.dueDate ? formatDue(task.dueDate) : undefined;
        h.notifyUsers(added, {
          type: 'task_assigned',
          title: 'New task assigned',
          message: `${h.ctx.name ?? 'Someone'} assigned you “${task.title}” in ${board.project.name}`,
          entityType: 'Task',
          entityId: task.id,
          email: (rcpt) =>
            templates.taskAssigned({
              assigneeName: rcpt.name,
              taskTitle: task.title,
              projectName: board.project.name,
              boardName: board.name,
              priority: task.priority,
              dueDate: due,
              assignedByName: h.ctx.name ?? 'A teammate',
              description: task.description ?? undefined,
              url,
            }),
        });
      }

      const names = await h.db.user.findMany({
        where: { id: { in: final } },
        select: { name: true },
      });
      h.audit({
        category: 'TASK',
        action: 'task.assignees',
        operation: 'UPDATE',
        targetType: 'Task',
        targetId: task.id,
        targetLabel: task.title,
        metadata: { mode: m, assignees: names.map((n) => n.name) },
      });

      return { success: true, task: task.title, assignees: names.map((n) => n.name) };
    },
  });

  tools.addTaskComment = tool({
    description:
      'Add a comment to a task (optionally as a reply to an existing comment). Identify the task by title (or id). Use for "comment on <task> that ...", "leave a note on <task>".',
    inputSchema: z.object({
      ...taskRef,
      content: z.string().min(1).describe('The comment text'),
      replyToCommentId: z.string().nullish().describe('Reply to this comment id (for threads)'),
    }),
    needsApproval: true,
    execute: async ({ taskTitle, taskId, content, replyToCommentId }) => {
      const r = await resolveTask({ taskId, title: taskTitle });
      if (!r.ok) return asFail(r);
      const { task } = r;
      if (!(await canWriteTask(task)))
        return { error: 'You do not have access to that task’s project.' };

      const comment = await h.db.taskComment.create({
        data: {
          content,
          taskId: task.id,
          userId: h.ctx.userId,
          parentId: replyToCommentId ?? null,
        },
        select: { id: true, content: true, createdAt: true },
      });
      h.audit({
        category: 'TASK',
        action: 'task.comment',
        operation: 'CREATE',
        targetType: 'Task',
        targetId: task.id,
        targetLabel: task.title,
      });
      return {
        success: true,
        task: task.title,
        comment: { author: h.ctx.name ?? 'you', content: comment.content, when: comment.createdAt },
      };
    },
  });

  tools.toggleChecklistItem = tool({
    description:
      'Check off or un-check a checklist item on a task. Identify the task by title (or id) and the item by its text. Omit "completed" to flip its current state. Use for "check off <item> on <task>", "mark <item> done".',
    inputSchema: z.object({
      ...taskRef,
      itemText: z.string().describe('The checklist item text (fuzzy match within the task)'),
      completed: z.boolean().nullish().describe('true=done, false=open; omit to toggle'),
    }),
    needsApproval: true,
    execute: async ({ taskTitle, taskId, itemText, completed }) => {
      const r = await resolveTask({ taskId, title: taskTitle });
      if (!r.ok) return asFail(r);
      const { task } = r;
      if (!(await canWriteTask(task)))
        return { error: 'You do not have access to that task’s project.' };

      const checklists = await h.db.taskChecklist.findMany({
        where: { taskId: task.id },
        orderBy: { order: 'asc' },
        select: {
          name: true,
          items: { orderBy: { order: 'asc' }, select: { id: true, text: true, completed: true } },
        },
      });
      const items = checklists.flatMap((cl) =>
        cl.items.map((it) => ({ ...it, checklist: cl.name }))
      );
      if (items.length === 0) return { error: 'That task has no checklist items.' };

      let matches = items.filter((i) => norm(i.text) === norm(itemText));
      if (matches.length === 0)
        matches = items.filter((i) => i.text.toLowerCase().includes(itemText.toLowerCase()));
      if (matches.length === 0)
        matches = items
          .map((i) => ({ i, s: matchScore(itemText, i.text) }))
          .filter((x) => x.s >= 70)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.i);
      if (matches.length === 0)
        return { error: `No checklist item matches "${itemText}" on that task.` };
      if (matches.length > 1)
        return {
          needsClarification: `Which item — ${matches
            .slice(0, 8)
            .map((m) => `"${m.text}"`)
            .join(', ')}?`,
        };

      const item = matches[0];
      const newCompleted = completed ?? !item.completed;
      await h.db.taskChecklistItem.update({
        where: { id: item.id },
        data: { completed: newCompleted },
      });
      h.audit({
        category: 'TASK',
        action: 'task.checklistItem',
        operation: 'UPDATE',
        targetType: 'Task',
        targetId: task.id,
        targetLabel: task.title,
        changes: { [`item:${item.text}`]: { before: item.completed, after: newCompleted } },
      });
      return { success: true, task: task.title, item: item.text, completed: newCompleted };
    },
  });

  tools.createLabel = tool({
    description:
      "Create a new label on a project's board (so it can be applied to tasks). Identify the project by name (or id). Provide a hex color (defaults to grey). Use for \"make a 'Blocked' label in <project>\".",
    inputSchema: z.object({
      projectName: z.string().nullish().describe('Project whose board gets the label (fuzzy name)'),
      projectId: z.string().nullish(),
      name: z.string().min(1).describe('Label name, e.g. "Blocked"'),
      color: z.string().nullish().describe('Hex color, e.g. "#EF4444"; defaults to grey'),
    }),
    needsApproval: true,
    execute: async ({ projectName, projectId, name, color }) => {
      const proj = await resolveProjectTarget(projectId, projectName);
      if (!proj.ok) return asFail(proj);
      if (!(await h.canAccessProject(proj.id)))
        return { error: 'You do not have access to that project.' };

      const board = await h.db.board.findFirst({
        where: { projectId: proj.id },
        select: { id: true, name: true },
      });
      if (!board) return { error: 'That project has no board to add a label to.' };

      const label = await h.db.label.create({
        data: { name, color: color ?? '#6B7280', boardId: board.id },
        select: { id: true, name: true, color: true },
      });
      h.audit({
        category: 'TASK',
        action: 'label.create',
        operation: 'CREATE',
        targetType: 'Label',
        targetId: label.id,
        targetLabel: label.name,
        metadata: { project: proj.name },
      });
      return { success: true, label: label.name, color: label.color, project: proj.name };
    },
  });

  tools.addLabelToTask = tool({
    description:
      'Apply an existing board label to a task. Identify the task by title (or id) and the label by name (must already exist on the task\'s board — create it first with createLabel if needed). Use for "tag <task> as Urgent", "add the Bug label to <task>".',
    inputSchema: z.object({
      ...taskRef,
      labelName: z.string().describe("The label name (must exist on the task's board)"),
    }),
    needsApproval: true,
    execute: async ({ taskTitle, taskId, labelName }) => {
      const r = await resolveTask({ taskId, title: taskTitle });
      if (!r.ok) return asFail(r);
      const { task } = r;
      if (!(await canWriteTask(task)))
        return { error: 'You do not have access to that task’s project.' };

      const labels = await h.db.label.findMany({
        where: { boardId: task.column.board.id },
        select: { id: true, name: true },
      });
      const lr = h.resolveNamed(labelName, labels);
      if (lr.kind === 'notfound')
        return {
          error: `No label named "${labelName}" on this board. Existing: ${
            labels.map((l) => l.name).join(', ') || 'none'
          }. Create it with createLabel first.`,
        };
      if (lr.kind === 'ambiguous')
        return { needsClarification: `Which label — ${lr.candidates.join(', ')}?` };

      const exists = await h.db.taskLabel.findFirst({
        where: { taskId: task.id, labelId: lr.value.id },
      });
      if (exists) return { success: true, note: `Task already has the "${lr.value.name}" label.` };

      await h.db.taskLabel.create({ data: { taskId: task.id, labelId: lr.value.id } });
      h.audit({
        category: 'TASK',
        action: 'task.addLabel',
        operation: 'UPDATE',
        targetType: 'Task',
        targetId: task.id,
        targetLabel: task.title,
        metadata: { label: lr.value.name },
      });
      return { success: true, task: task.title, label: lr.value.name };
    },
  });

  tools.removeLabelFromTask = tool({
    description:
      'Remove a label from a task. Identify the task by title (or id) and the label by name. Use for "remove the Urgent label from <task>", "untag <task>".',
    inputSchema: z.object({
      ...taskRef,
      labelName: z.string().describe('The label name to remove from the task'),
    }),
    needsApproval: true,
    execute: async ({ taskTitle, taskId, labelName }) => {
      const r = await resolveTask({ taskId, title: taskTitle });
      if (!r.ok) return asFail(r);
      const { task } = r;
      if (!(await canWriteTask(task)))
        return { error: 'You do not have access to that task’s project.' };

      const labels = await h.db.label.findMany({
        where: { boardId: task.column.board.id },
        select: { id: true, name: true },
      });
      const lr = h.resolveNamed(labelName, labels);
      if (lr.kind === 'notfound') return { error: `No label named "${labelName}" on this board.` };
      if (lr.kind === 'ambiguous')
        return { needsClarification: `Which label — ${lr.candidates.join(', ')}?` };

      await h.db.taskLabel.deleteMany({ where: { taskId: task.id, labelId: lr.value.id } });
      h.audit({
        category: 'TASK',
        action: 'task.removeLabel',
        operation: 'UPDATE',
        targetType: 'Task',
        targetId: task.id,
        targetLabel: task.title,
        metadata: { label: lr.value.name },
      });
      return { success: true, task: task.title, removed: lr.value.name };
    },
  });

  return tools;
}
