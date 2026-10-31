/**
 * PROJECTS + project STRUCTURE tools for the DevFathom assistant.
 *
 * Covers projects (CRUD), their membership (add / remove / set role), milestones,
 * boards, and columns. Task-level operations (task CRUD, comments, labels,
 * assignees) live in `tools/tasks.ts` and are intentionally NOT implemented here.
 *
 * Every tool mirrors the equivalent mutation in `src/server/routers/projects.ts`
 * exactly — same input validation, the SAME object-level authorization gate
 * (member-level `h.canAccessProject` vs LEAD/ADMIN `h.canManageProject`), the
 * same business rules (last-lead protection, default board/columns, column
 * ordering) and the same Activity-feed side effects. Writes additionally record
 * an admin audit entry via `h.audit()` and set `needsApproval: true` so the SDK
 * pauses for the acting user to approve before the mutation runs.
 *
 * The assistant can never exceed the acting user's real permissions: a project
 * is resolved by name only within the set the user may see, so a non-member
 * cannot even learn that a project exists.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { matchScore, norm } from '@/lib/ai/context';
import type { AssistantHelpers, ToolSet } from '@/lib/ai/context';
import { updateColumnWithCompletion } from '@/lib/tasks/columns';

export function buildProjectsTools(h: AssistantHelpers): ToolSet {
  const { db } = h;
  const tools: ToolSet = {};
  const now = h.now();
  const isAdmin = h.isAdmin;
  const userId = h.ctx.userId;

  // ───────────────────────────── local resolvers ─────────────────────────────
  // Resolve a free-text project name to a record the acting user may see. Non-
  // admins only ever match projects they belong to, so resolution itself never
  // reveals the existence of a project they have no access to.
  type ProjectHit =
    | { ok: true; id: string; name: string; interpreted?: string }
    | { ok: false; result: { error: string } | { needsClarification: string } };

  const resolveProject = async (name: string): Promise<ProjectHit> => {
    const projects = await db.project.findMany({
      where: isAdmin ? {} : { members: { some: { userId } } },
      select: { id: true, name: true },
    });
    const r = h.resolveNamed(name, projects);
    if (r.kind === 'notfound')
      return {
        ok: false,
        result: { error: `No project matches "${name}"${isAdmin ? '' : ' that you can access'}.` },
      };
    if (r.kind === 'ambiguous')
      return {
        ok: false,
        result: { needsClarification: `Which project — ${r.candidates.join(', ')}?` },
      };
    return { ok: true, id: r.value.id, name: r.value.name, interpreted: r.interpreted };
  };

  // Resolve a board within a project. If the project has exactly one board the
  // name is optional; otherwise the caller must disambiguate.
  type BoardHit =
    | { ok: true; id: string; name: string }
    | { ok: false; result: { error: string } | { needsClarification: string } };

  const resolveBoard = async (projectId: string, boardName?: string | null): Promise<BoardHit> => {
    const boards = await db.board.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });
    if (boards.length === 0)
      return { ok: false, result: { error: 'That project has no boards yet.' } };
    if (!boardName) {
      if (boards.length === 1) return { ok: true, id: boards[0].id, name: boards[0].name };
      return {
        ok: false,
        result: { needsClarification: `Which board — ${boards.map((b) => b.name).join(', ')}?` },
      };
    }
    const r = h.resolveNamed(boardName, boards);
    if (r.kind === 'notfound')
      return { ok: false, result: { error: `No board matches "${boardName}".` } };
    if (r.kind === 'ambiguous')
      return {
        ok: false,
        result: { needsClarification: `Which board — ${r.candidates.join(', ')}?` },
      };
    return { ok: true, id: r.value.id, name: r.value.name };
  };

  // ─────────────────────────────────── READS ─────────────────────────────────

  tools.listProjects = tool({
    description:
      'List projects in the hub (name, status, type, client). Use to find a project, get an overview, or before a deeper lookup. Non-admins see only projects they belong to.',
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
          ...(isAdmin ? {} : { members: { some: { userId } } }),
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
  });

  tools.getProject = tool({
    description:
      'A deep dive on ONE project: status, client, description, tech stack, dates, team members, milestones (with overdue flags), and a board summary (tasks open / done / overdue). Use for "tell me about <project>", "status of <project>", "who is on <project>". Give the project name.',
    inputSchema: z.object({
      name: z.string().describe('The project name (fuzzy match), e.g. "Hearthly"'),
    }),
    execute: async ({ name }) => {
      const projects = await db.project.findMany({
        where: isAdmin ? {} : { members: { some: { userId } } },
        select: { id: true, name: true },
      });
      const r = h.resolveNamed(name, projects);
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
                select: { name: true, tasks: { select: { dueDate: true } } },
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
        const isDone = h.DONE_COLUMNS.includes(c.name);
        for (const t of c.tasks) {
          if (isDone) done++;
          else {
            open++;
            if (t.dueDate && t.dueDate < now) overdue++;
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
        pastEndDate: !!p.endDate && p.endDate < now && p.status !== 'COMPLETED',
        // Budget is financial data → admin only.
        budget: isAdmin && p.budget != null ? Number(p.budget) : undefined,
        team: p.members.map((m) => ({ name: m.user.name, title: m.user.title, role: m.role })),
        milestones: p.milestones.map((m) => ({
          name: m.name,
          dueDate: m.dueDate,
          done: !!m.completedAt,
          overdue: !m.completedAt && m.dueDate < now,
        })),
        tasks: { open, done, overdue },
        scopeNote: r.interpreted ? `Interpreted "${name}" as ${r.value.name}.` : undefined,
      };
    },
  });

  tools.findProjectsBehindSchedule = tool({
    description:
      'Find projects BEHIND SCHEDULE — past their end date or with overdue milestones, and not completed/cancelled. Use for "projects behind / at risk / late / slipping".',
    inputSchema: z.object({}),
    execute: async () => {
      const projects = await db.project.findMany({
        where: {
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
          ...(isAdmin ? {} : { members: { some: { userId } } }),
          OR: [
            { endDate: { lt: now } },
            { milestones: { some: { dueDate: { lt: now }, completedAt: null } } },
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
        pastEndDate: p.endDate ? p.endDate < now : false,
        overdueMilestones: p.milestones.map((m) => m.name),
      }));
    },
  });

  // ─────────────────────────────── PROJECT WRITES ────────────────────────────

  tools.createProject = tool({
    description:
      'Create a new project. Any team member can create one (the creator becomes its LEAD). By default a board ("Backlog / To Do / In Progress / Review / Done" + standard labels) is created too. Use for "start a new project", "spin up a project for <client>". Add members afterwards with addProjectMember.',
    inputSchema: z.object({
      name: z.string().min(1).describe('Project name'),
      type: z.enum(['CLIENT', 'INTERNAL']).describe('CLIENT (for a client) or INTERNAL'),
      description: z.string().nullish(),
      status: z.enum(['ACTIVE', 'IN_DEVELOPMENT', 'ON_HOLD']).nullish().describe('Default ACTIVE'),
      clientName: z.string().nullish().describe('Attach to a client by name (fuzzy match)'),
      techStack: z.array(z.string()).nullish().describe('e.g. ["Next.js", "Postgres"]'),
      startDate: z.string().nullish().describe('ISO date'),
      endDate: z.string().nullish().describe('ISO date'),
      budget: z.number().nullish().describe('Project budget (ADMIN ONLY — ignored otherwise)'),
      createDefaultBoard: z.boolean().nullish().describe('Default true — create a starter board'),
    }),
    needsApproval: true,
    execute: async ({
      name,
      type,
      description,
      status,
      clientName,
      techStack,
      startDate,
      endDate,
      budget,
      createDefaultBoard,
    }) => {
      // Resolve an optional client by name.
      let clientId: string | null = null;
      let resolvedClient: string | undefined;
      if (clientName) {
        const clients = await db.client.findMany({ select: { id: true, name: true } });
        const cr = h.resolveNamed(clientName, clients);
        if (cr.kind === 'notfound') return { error: `No client matches "${clientName}".` };
        if (cr.kind === 'ambiguous')
          return { needsClarification: `Which client — ${cr.candidates.join(', ')}?` };
        clientId = cr.value.id;
        resolvedClient = cr.value.name;
      }

      const project = await db.project.create({
        data: {
          name,
          type,
          description: description ?? undefined,
          status: status ?? 'ACTIVE',
          clientId,
          techStack: techStack ?? [],
          startDate: startDate ? new Date(startDate) : undefined,
          endDate: endDate ? new Date(endDate) : undefined,
          // Budget is financial data — only an admin may set it.
          budget: isAdmin && budget != null ? new Prisma.Decimal(budget) : undefined,
          // The creator is always a member, and the first member is the LEAD.
          members: { create: [{ userId, role: 'LEAD' }] },
        },
      });

      const withBoard = createDefaultBoard !== false;
      if (withBoard) {
        await db.board.create({
          data: {
            name: `${project.name} Board`,
            projectId: project.id,
            columns: {
              create: ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'].map((cn, order) => ({
                name: cn,
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

      h.activity({
        type: 'project_created',
        message: `created project ${project.name}`,
        entityType: 'Project',
        entityId: project.id,
      });
      h.audit({
        category: 'PROJECT',
        action: 'createProject',
        operation: 'CREATE',
        targetType: 'Project',
        targetId: project.id,
        targetLabel: project.name,
      });

      return {
        created: project.name,
        type: project.type,
        status: project.status,
        client: resolvedClient ?? null,
        boardCreated: withBoard,
      };
    },
  });

  tools.updateProject = tool({
    description:
      'Update a project: rename it, change its status (ACTIVE / IN_DEVELOPMENT / ON_HOLD / COMPLETED / CANCELLED), edit the description, dates, or tech stack. Use for "mark <project> as completed", "put <project> on hold", "rename <project>". Any project member (or admin) may do this.',
    inputSchema: z.object({
      project: z.string().describe('The project to update, by name'),
      status: z.enum(['ACTIVE', 'IN_DEVELOPMENT', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).nullish(),
      newName: z.string().min(1).nullish().describe('Rename the project'),
      description: z.string().nullish(),
      startDate: z.string().nullish().describe('ISO date'),
      endDate: z.string().nullish().describe('ISO date'),
      techStack: z.array(z.string()).nullish(),
    }),
    needsApproval: true,
    execute: async ({ project, status, newName, description, startDate, endDate, techStack }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;
      // Member-level access — mirrors assertProjectAccess(ctx, id).
      if (!(await h.canAccessProject(pr.id)))
        return { error: 'You do not have access to that project.' };

      const data: Prisma.ProjectUpdateInput = {};
      if (newName != null) data.name = newName;
      if (description !== undefined && description !== null) data.description = description;
      if (status != null) data.status = status;
      if (startDate != null) data.startDate = new Date(startDate);
      if (endDate != null) data.endDate = new Date(endDate);
      if (techStack != null) data.techStack = techStack;
      if (Object.keys(data).length === 0)
        return {
          error:
            'Nothing to update — provide a new status, name, description, dates or tech stack.',
        };

      const updated = await db.project.update({ where: { id: pr.id }, data });

      h.activity({
        type: 'project_updated',
        message:
          status === 'COMPLETED'
            ? `marked project ${updated.name} as completed`
            : `updated project ${updated.name}`,
        entityType: 'Project',
        entityId: updated.id,
      });
      h.audit({
        category: 'PROJECT',
        action: 'updateProject',
        operation: 'UPDATE',
        targetType: 'Project',
        targetId: updated.id,
        targetLabel: updated.name,
      });

      return {
        updated: updated.name,
        status: updated.status,
        scopeNote: pr.interpreted ? `Interpreted "${project}" as ${pr.name}.` : undefined,
      };
    },
  });

  tools.deleteProject = tool({
    description:
      'Permanently delete a project and everything in it (boards, columns, tasks, milestones, files). Destructive and irreversible. Only a project LEAD or an admin may delete. Use for "delete <project>", "remove the <project> project". Call this DIRECTLY with the project name — it resolves the name itself, so do NOT look the project up with getProject first; the user confirms via the approval card.',
    inputSchema: z.object({
      project: z.string().describe('The project to delete, by name'),
    }),
    needsApproval: true,
    execute: async ({ project }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;
      // Manage-level — mirrors assertProjectAccess(ctx, id, { manage: true }).
      if (!(await h.canManageProject(pr.id)))
        return { error: 'You do not have access to that project.' };

      await db.project.delete({ where: { id: pr.id } });

      h.activity({ type: 'project_deleted', message: `deleted project ${pr.name}` });
      h.audit({
        category: 'PROJECT',
        action: 'deleteProject',
        operation: 'DELETE',
        targetType: 'Project',
        targetId: pr.id,
        targetLabel: pr.name,
      });

      return { deleted: pr.name };
    },
  });

  // ─────────────────────────────── MEMBERS ───────────────────────────────────

  tools.addProjectMember = tool({
    description:
      'Add a team member to a project (as MEMBER or LEAD). Only the project LEAD or an admin may add members. If the person is already on the project their role is updated. Use for "add <name> to <project>", "make <name> a lead on <project>".',
    inputSchema: z.object({
      project: z.string().describe('The project, by name'),
      person: z.string().describe("The team member's name"),
      role: z.enum(['MEMBER', 'LEAD']).nullish().describe('Default MEMBER'),
    }),
    needsApproval: true,
    execute: async ({ project, person, role }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;
      // addMember requires LEAD/ADMIN (mirrors the router's caller check).
      if (!(await h.canManageProject(pr.id)))
        return { error: 'Only the project lead or an admin can add members.' };

      const r = await h.resolvePerson(person);
      if (r.kind === 'notfound') return { error: `No team member matches "${person}".` };
      if (r.kind === 'ambiguous')
        return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };

      const targetRole = role ?? 'MEMBER';
      await db.projectMember.upsert({
        where: { projectId_userId: { projectId: pr.id, userId: r.value.id } },
        create: { projectId: pr.id, userId: r.value.id, role: targetRole },
        update: { role: targetRole },
      });

      h.activity({
        type: 'project_member_added',
        message: `added ${r.value.name} to ${pr.name}`,
        entityType: 'Project',
        entityId: pr.id,
      });
      h.audit({
        category: 'PROJECT',
        action: 'addProjectMember',
        operation: 'CREATE',
        targetType: 'Project',
        targetId: pr.id,
        targetLabel: pr.name,
        metadata: { member: r.value.name, role: targetRole },
      });

      return {
        added: r.value.name,
        to: pr.name,
        role: targetRole,
        scopeNote: r.interpreted ? `Interpreted "${person}" as ${r.value.name}.` : undefined,
      };
    },
  });

  tools.removeProjectMember = tool({
    description:
      'Remove a member from a project. A LEAD or admin can remove anyone; a member can remove themselves (pass "me"). The last remaining LEAD cannot be removed. Use for "remove <name> from <project>", "take me off <project>".',
    inputSchema: z.object({
      project: z.string().describe('The project, by name'),
      person: z.string().describe('The member to remove, by name, or "me" for yourself'),
    }),
    needsApproval: true,
    execute: async ({ project, person }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;

      const members = await db.projectMember.findMany({
        where: { projectId: pr.id },
        select: { userId: true, role: true, user: { select: { name: true } } },
      });

      // Identify the target — "me" maps to the current user.
      let targetUserId: string;
      let targetName: string;
      if (['me', 'myself', 'i'].includes(norm(person))) {
        targetUserId = userId;
        targetName = h.ctx.name ?? 'you';
      } else {
        const r = h.resolveNamed(
          person,
          members.map((m) => ({ id: m.userId, name: m.user.name }))
        );
        if (r.kind === 'notfound') return { error: `"${person}" is not a member of that project.` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };
        targetUserId = r.value.id;
        targetName = r.value.name;
      }

      const target = members.find((m) => m.userId === targetUserId);
      if (!target) return { error: `"${person}" is not a member of that project.` };

      const isSelf = targetUserId === userId;
      // LEAD/ADMIN can remove anyone; anyone can remove themselves.
      if (!isSelf && !(await h.canManageProject(pr.id)))
        return { error: 'Only the project lead or an admin can remove other members.' };

      const leadCount = members.filter((m) => m.role === 'LEAD').length;
      if (target.role === 'LEAD' && leadCount <= 1)
        return {
          error: 'Cannot remove the last lead. Promote another member to lead first.',
        };

      await db.projectMember.delete({
        where: { projectId_userId: { projectId: pr.id, userId: targetUserId } },
      });

      h.activity({
        type: 'project_member_removed',
        message: isSelf ? `left project ${pr.name}` : `removed ${targetName} from ${pr.name}`,
        entityType: 'Project',
        entityId: pr.id,
      });
      h.audit({
        category: 'PROJECT',
        action: 'removeProjectMember',
        operation: 'DELETE',
        targetType: 'Project',
        targetId: pr.id,
        targetLabel: pr.name,
        metadata: { member: targetName, self: isSelf },
      });

      return { removed: targetName, from: pr.name };
    },
  });

  tools.setProjectMemberRole = tool({
    description:
      'Promote or demote a project member between LEAD and MEMBER. Only an existing LEAD or an admin may change roles. The last remaining LEAD cannot be demoted. Use for "make <name> the lead of <project>", "demote <name> to member".',
    inputSchema: z.object({
      project: z.string().describe('The project, by name'),
      person: z.string().describe('The member, by name'),
      role: z.enum(['LEAD', 'MEMBER']).describe('The new role'),
    }),
    needsApproval: true,
    execute: async ({ project, person, role }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;
      if (!(await h.canManageProject(pr.id)))
        return { error: 'Only the project lead or an admin can change roles.' };

      const members = await db.projectMember.findMany({
        where: { projectId: pr.id },
        select: { userId: true, role: true, user: { select: { name: true } } },
      });
      const r = h.resolveNamed(
        person,
        members.map((m) => ({ id: m.userId, name: m.user.name }))
      );
      if (r.kind === 'notfound') return { error: `"${person}" is not a member of that project.` };
      if (r.kind === 'ambiguous')
        return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };
      const target = members.find((m) => m.userId === r.value.id);
      if (!target) return { error: `"${person}" is not a member of that project.` };

      // Block demoting the last lead.
      if (role === 'MEMBER' && target.role === 'LEAD') {
        const leadCount = members.filter((m) => m.role === 'LEAD').length;
        if (leadCount <= 1)
          return { error: 'Cannot demote the last lead. Promote another member first.' };
      }

      await db.projectMember.update({
        where: { projectId_userId: { projectId: pr.id, userId: r.value.id } },
        data: { role },
      });

      h.audit({
        category: 'PROJECT',
        action: 'setProjectMemberRole',
        operation: 'UPDATE',
        targetType: 'Project',
        targetId: pr.id,
        targetLabel: pr.name,
        metadata: { member: r.value.name, role },
      });

      return { member: r.value.name, project: pr.name, role };
    },
  });

  // ─────────────────────────────── MILESTONES ────────────────────────────────

  tools.createMilestone = tool({
    description:
      'Add a milestone (a dated checkpoint) to a project. Any project member may add one. Use for "add a milestone to <project>", "set a deadline for <project>: <name> by <date>".',
    inputSchema: z.object({
      project: z.string().describe('The project, by name'),
      name: z.string().min(1).describe('Milestone name'),
      dueDate: z.string().describe('ISO date the milestone is due'),
      description: z.string().nullish(),
    }),
    needsApproval: true,
    execute: async ({ project, name, dueDate, description }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;
      if (!(await h.canAccessProject(pr.id)))
        return { error: 'You do not have access to that project.' };

      const milestone = await db.milestone.create({
        data: {
          projectId: pr.id,
          name,
          dueDate: new Date(dueDate),
          description: description ?? undefined,
        },
      });

      h.audit({
        category: 'PROJECT',
        action: 'createMilestone',
        operation: 'CREATE',
        targetType: 'Milestone',
        targetId: milestone.id,
        targetLabel: milestone.name,
        metadata: { project: pr.name },
      });

      return { created: milestone.name, project: pr.name, dueDate: milestone.dueDate };
    },
  });

  tools.updateMilestone = tool({
    description:
      'Update a milestone on a project: rename it, change its due date or description, or mark it complete/incomplete. Any project member may do this. Use for "mark the <name> milestone done", "push the <name> milestone to <date>".',
    inputSchema: z.object({
      project: z.string().describe('The project, by name'),
      milestone: z.string().describe('The milestone to update, by name'),
      newName: z.string().min(1).nullish().describe('Rename the milestone'),
      dueDate: z.string().nullish().describe('ISO date'),
      description: z.string().nullish(),
      completed: z.boolean().nullish().describe('true = mark done, false = reopen'),
    }),
    needsApproval: true,
    execute: async ({ project, milestone, newName, dueDate, description, completed }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;
      if (!(await h.canAccessProject(pr.id)))
        return { error: 'You do not have access to that project.' };

      const milestones = await db.milestone.findMany({
        where: { projectId: pr.id },
        select: { id: true, name: true },
      });
      const mr = h.resolveNamed(milestone, milestones);
      if (mr.kind === 'notfound')
        return { error: `No milestone matches "${milestone}" on ${pr.name}.` };
      if (mr.kind === 'ambiguous')
        return { needsClarification: `Which milestone — ${mr.candidates.join(', ')}?` };

      const data: Prisma.MilestoneUpdateInput = {};
      if (newName != null) data.name = newName;
      if (description !== undefined && description !== null) data.description = description;
      if (dueDate != null) data.dueDate = new Date(dueDate);
      if (completed != null) data.completedAt = completed ? now : null;
      if (Object.keys(data).length === 0)
        return {
          error:
            'Nothing to update — provide a new name, due date, description, or completion state.',
        };

      const updated = await db.milestone.update({ where: { id: mr.value.id }, data });

      h.audit({
        category: 'PROJECT',
        action: 'updateMilestone',
        operation: 'UPDATE',
        targetType: 'Milestone',
        targetId: updated.id,
        targetLabel: updated.name,
        metadata: { project: pr.name },
      });

      return {
        updated: updated.name,
        project: pr.name,
        dueDate: updated.dueDate,
        done: !!updated.completedAt,
      };
    },
  });

  tools.deleteMilestone = tool({
    description:
      'Delete a milestone from a project. Any project member may do this. Use for "remove the <name> milestone from <project>".',
    inputSchema: z.object({
      project: z.string().describe('The project, by name'),
      milestone: z.string().describe('The milestone to delete, by name'),
    }),
    needsApproval: true,
    execute: async ({ project, milestone }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;
      if (!(await h.canAccessProject(pr.id)))
        return { error: 'You do not have access to that project.' };

      const milestones = await db.milestone.findMany({
        where: { projectId: pr.id },
        select: { id: true, name: true },
      });
      const mr = h.resolveNamed(milestone, milestones);
      if (mr.kind === 'notfound')
        return { error: `No milestone matches "${milestone}" on ${pr.name}.` };
      if (mr.kind === 'ambiguous')
        return { needsClarification: `Which milestone — ${mr.candidates.join(', ')}?` };

      await db.milestone.delete({ where: { id: mr.value.id } });

      h.audit({
        category: 'PROJECT',
        action: 'deleteMilestone',
        operation: 'DELETE',
        targetType: 'Milestone',
        targetId: mr.value.id,
        targetLabel: mr.value.name,
        metadata: { project: pr.name },
      });

      return { deleted: mr.value.name, project: pr.name };
    },
  });

  // ───────────────────────────────── BOARDS ──────────────────────────────────

  tools.createBoard = tool({
    description:
      'Create a new board on a project. By default it gets the standard columns (Backlog / To Do / In Progress / Review / Done) and labels. Any project member may add a board. Use for "add a board to <project>", "create a <name> board".',
    inputSchema: z.object({
      project: z.string().describe('The project, by name'),
      name: z.string().min(1).describe('Board name'),
      description: z.string().nullish(),
      createDefaultColumns: z.boolean().nullish().describe('Default true'),
    }),
    needsApproval: true,
    execute: async ({ project, name, description, createDefaultColumns }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;
      // createBoard is member-level — mirrors assertProjectAccess(ctx, projectId).
      if (!(await h.canAccessProject(pr.id)))
        return { error: 'You do not have access to that project.' };

      const withColumns = createDefaultColumns !== false;
      const board = await db.board.create({
        data: {
          name,
          description: description ?? undefined,
          projectId: pr.id,
          columns: withColumns
            ? {
                create: ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'].map((cn, order) => ({
                  name: cn,
                  order,
                })),
              }
            : undefined,
          labels: withColumns
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

      h.audit({
        category: 'PROJECT',
        action: 'createBoard',
        operation: 'CREATE',
        targetType: 'Board',
        targetId: board.id,
        targetLabel: board.name,
        metadata: { project: pr.name },
      });

      return { created: board.name, project: pr.name, columnsCreated: withColumns };
    },
  });

  tools.deleteBoard = tool({
    description:
      'Delete a board (and all its columns and tasks) from a project. Destructive. Only a project LEAD or an admin may delete a board. Use for "delete the <name> board".',
    inputSchema: z.object({
      project: z.string().describe('The project, by name'),
      board: z
        .string()
        .nullish()
        .describe('The board name (optional if the project has one board)'),
    }),
    needsApproval: true,
    execute: async ({ project, board }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;
      // deleteBoard is manage-level — mirrors assertBoardAccess(ctx, id, { manage: true }).
      if (!(await h.canManageProject(pr.id)))
        return { error: 'You do not have access to that project.' };

      const br = await resolveBoard(pr.id, board);
      if (!br.ok) return br.result;

      await db.board.delete({ where: { id: br.id } });

      h.audit({
        category: 'PROJECT',
        action: 'deleteBoard',
        operation: 'DELETE',
        targetType: 'Board',
        targetId: br.id,
        targetLabel: br.name,
        metadata: { project: pr.name },
      });

      return { deleted: br.name, project: pr.name };
    },
  });

  // ───────────────────────────────── COLUMNS ─────────────────────────────────

  tools.createColumn = tool({
    description:
      'Add a column (a status lane, e.g. "QA") to a board, appended at the end. Any project member may add a column. Use for "add a <name> column to <project>".',
    inputSchema: z.object({
      project: z.string().describe('The project, by name'),
      name: z.string().min(1).describe('Column name'),
      board: z
        .string()
        .nullish()
        .describe('The board name (optional if the project has one board)'),
    }),
    needsApproval: true,
    execute: async ({ project, name, board }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;
      // createColumn is member-level — mirrors assertBoardAccess(ctx, boardId).
      if (!(await h.canAccessProject(pr.id)))
        return { error: 'You do not have access to that project.' };

      const br = await resolveBoard(pr.id, board);
      if (!br.ok) return br.result;

      const maxOrder = await db.column.aggregate({
        _max: { order: true },
        where: { boardId: br.id },
      });
      const column = await db.column.create({
        data: { name, boardId: br.id, order: (maxOrder._max.order ?? -1) + 1 },
      });

      h.audit({
        category: 'PROJECT',
        action: 'createColumn',
        operation: 'CREATE',
        targetType: 'Column',
        targetId: column.id,
        targetLabel: column.name,
        metadata: { project: pr.name, board: br.name },
      });

      return { created: column.name, board: br.name, project: pr.name };
    },
  });

  tools.updateColumn = tool({
    description:
      'Rename a column on a board. Any project member may do this. Use for "rename the <old> column to <new>".',
    inputSchema: z.object({
      project: z.string().describe('The project, by name'),
      column: z.string().describe('The column to rename, by its current name'),
      newName: z.string().min(1).describe('The new column name'),
      board: z
        .string()
        .nullish()
        .describe('The board name (optional if the project has one board)'),
    }),
    needsApproval: true,
    execute: async ({ project, column, newName, board }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;
      // updateColumn is member-level — mirrors assertColumnAccess(ctx, id).
      if (!(await h.canAccessProject(pr.id)))
        return { error: 'You do not have access to that project.' };

      const br = await resolveBoard(pr.id, board);
      if (!br.ok) return br.result;
      const columns = await db.column.findMany({
        where: { boardId: br.id },
        select: { id: true, name: true },
      });
      const cr = h.resolveNamed(column, columns);
      if (cr.kind === 'notfound') return { error: `No column matches "${column}" on ${br.name}.` };
      if (cr.kind === 'ambiguous')
        return { needsClarification: `Which column — ${cr.candidates.join(', ')}?` };

      const updated = await updateColumnWithCompletion(db, cr.value.id, { name: newName }, h.now());

      h.audit({
        category: 'PROJECT',
        action: 'updateColumn',
        operation: 'UPDATE',
        targetType: 'Column',
        targetId: updated.id,
        targetLabel: updated.name,
        metadata: { project: pr.name, board: br.name, from: cr.value.name },
      });

      return { renamed: cr.value.name, to: updated.name, board: br.name, project: pr.name };
    },
  });

  tools.deleteColumn = tool({
    description:
      'Delete a column (and its tasks) from a board. Destructive. Only a project LEAD or an admin may delete a column. Use for "delete the <name> column".',
    inputSchema: z.object({
      project: z.string().describe('The project, by name'),
      column: z.string().describe('The column to delete, by name'),
      board: z
        .string()
        .nullish()
        .describe('The board name (optional if the project has one board)'),
    }),
    needsApproval: true,
    execute: async ({ project, column, board }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;
      // deleteColumn is manage-level — mirrors assertColumnAccess(ctx, id, { manage: true }).
      if (!(await h.canManageProject(pr.id)))
        return { error: 'You do not have access to that project.' };

      const br = await resolveBoard(pr.id, board);
      if (!br.ok) return br.result;
      const columns = await db.column.findMany({
        where: { boardId: br.id },
        select: { id: true, name: true },
      });
      const cr = h.resolveNamed(column, columns);
      if (cr.kind === 'notfound') return { error: `No column matches "${column}" on ${br.name}.` };
      if (cr.kind === 'ambiguous')
        return { needsClarification: `Which column — ${cr.candidates.join(', ')}?` };

      await db.column.delete({ where: { id: cr.value.id } });

      h.audit({
        category: 'PROJECT',
        action: 'deleteColumn',
        operation: 'DELETE',
        targetType: 'Column',
        targetId: cr.value.id,
        targetLabel: cr.value.name,
        metadata: { project: pr.name, board: br.name },
      });

      return { deleted: cr.value.name, board: br.name, project: pr.name };
    },
  });

  tools.reorderColumns = tool({
    description:
      'Move a column to a new position (0-based) on its board, shifting the others to make room. Any project member may reorder. Use for "move the <name> column to the front", "put <name> after <other>".',
    inputSchema: z.object({
      project: z.string().describe('The project, by name'),
      column: z.string().describe('The column to move, by name'),
      newOrder: z.number().int().describe('Target position, 0 = first'),
      board: z
        .string()
        .nullish()
        .describe('The board name (optional if the project has one board)'),
    }),
    needsApproval: true,
    execute: async ({ project, column, newOrder, board }) => {
      const pr = await resolveProject(project);
      if (!pr.ok) return pr.result;
      // reorderColumns is member-level — mirrors assertBoardAccess(ctx, boardId).
      if (!(await h.canAccessProject(pr.id)))
        return { error: 'You do not have access to that project.' };

      const br = await resolveBoard(pr.id, board);
      if (!br.ok) return br.result;
      const columns = await db.column.findMany({
        where: { boardId: br.id },
        select: { id: true, name: true, order: true },
      });
      const cr = h.resolveNamed(column, columns);
      if (cr.kind === 'notfound') return { error: `No column matches "${column}" on ${br.name}.` };
      if (cr.kind === 'ambiguous')
        return { needsClarification: `Which column — ${cr.candidates.join(', ')}?` };

      const oldOrder = cr.value.order;
      if (oldOrder === newOrder)
        return { moved: cr.value.name, board: br.name, position: newOrder };

      // Same order-shifting transaction the router uses.
      await db.$transaction(async (tx) => {
        if (oldOrder < newOrder) {
          await tx.column.updateMany({
            where: { boardId: br.id, order: { gt: oldOrder, lte: newOrder } },
            data: { order: { decrement: 1 } },
          });
        } else {
          await tx.column.updateMany({
            where: { boardId: br.id, order: { gte: newOrder, lt: oldOrder } },
            data: { order: { increment: 1 } },
          });
        }
        await tx.column.update({ where: { id: cr.value.id }, data: { order: newOrder } });
      });

      h.audit({
        category: 'PROJECT',
        action: 'reorderColumns',
        operation: 'UPDATE',
        targetType: 'Column',
        targetId: cr.value.id,
        targetLabel: cr.value.name,
        metadata: { project: pr.name, board: br.name, from: oldOrder, to: newOrder },
      });

      return { moved: cr.value.name, board: br.name, position: newOrder };
    },
  });

  return tools;
}
