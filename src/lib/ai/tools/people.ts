/**
 * PEOPLE / HR / team-management tools for the DevFathom assistant.
 *
 * These are a second front-end onto the SAME mutations the tRPC `team` router
 * exposes (`src/server/routers/team.ts`) — every write here mirrors that
 * router's input validation, authorization gate, business logic and side
 * effects (Activity feed, in-app + email notifications, audit trail) so the
 * assistant can never do more than the acting user could do by hand, and every
 * AI-driven action is attributed and audited identically.
 *
 * Resignations are owned by a separate domain file — nothing here touches them.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { hash } from 'bcryptjs';
import { Prisma } from '@/generated/prisma/client';
import { matchScore, type AssistantHelpers, type ToolSet } from '@/lib/ai/context';
import { appUrl, templates, sendEmail } from '@/lib/email';
import { normalizeEmail } from '@/lib/email-address';
import { generateInviteToken } from '@/lib/invite-token';
import { passwordMeetsPolicy } from '@/lib/password-policy';

// "LEADERSHIP" → "Leadership", "ADMIN" → "Admin"; the acronym role stays as-is.
const titleCase = (s: string) => (s === 'HR' ? 'HR' : s.charAt(0) + s.slice(1).toLowerCase());

// How long an invitation link stays valid (mirrors team.inviteMember).
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Display-ready short date, e.g. "Jun 30".
const shortDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// WHA-278: departments are tenant-configured rows, not a fixed enum — a
// restaurant tenant has KITCHEN/FRONT_OF_HOUSE and no LEADERSHIP at all. The
// tool schema therefore takes a free-form key and every write validates it
// against the caller's own active catalog, exactly as team.inviteMember does.
const departmentKey = z
  .string()
  .describe('Department key from this workspace, e.g. "ENGINEERING" or "KITCHEN"');

export function buildPeopleTools(h: AssistantHelpers): ToolSet {
  const { ctx } = h;
  const tools: ToolSet = {};

  // ─────────────────────────────── READS ────────────────────────────────────

  tools.listTeam = tool({
    description:
      'List CURRENTLY ACTIVE employees / staff / people / team members (name, title, department, status, skills). Use for "who works here", "the team", headcount. NOTE: this excludes deactivated / laid-off (former) people — to look up or act on a SPECIFIC person who might be inactive, use getTeamMember or the action tool directly (they include former members), not this.',
    inputSchema: z.object({
      department: z.string().nullish().describe('Optional department filter'),
      query: z.string().nullish().describe('Optional name/role search (fuzzy, typo-tolerant)'),
    }),
    execute: async ({ department, query }) => {
      const people = await h.db.user.findMany({
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
  });

  tools.getTeamMember = tool({
    description:
      'A deep profile of ONE person: title, department, skills, bio, the projects they\'re on, a breakdown of their tasks (open / overdue / done), and any current or pending leave. Use for "tell me about <name>", "what is <name> working on", "<name>\'s workload". Give the person\'s name.',
    inputSchema: z.object({
      name: z.string().describe('The team member\'s name, e.g. "Aisha" or "Aisha Khan"'),
    }),
    execute: async ({ name }) => {
      const r = await h.resolvePerson(name, { includeInactive: true });
      if (r.kind === 'notfound') return { error: `No team member matches "${name}".` };
      if (r.kind === 'ambiguous')
        return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };
      const u = r.value;

      // Admins/HR (people-ops) and the person themselves may see contact + leave.
      const privileged = h.isAdminOrHr || u.id === ctx.userId;

      const full = await h.db.user.findUnique({
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
      const tasks = await h.db.task.findMany({
        where: { AND: [{ assignees: { some: { userId: u.id } } }, h.taskVisibility()] },
        select: {
          title: true,
          priority: true,
          dueDate: true,
          column: { select: { name: true } },
        },
        take: 200,
      });
      const open = tasks.filter((t) => !h.DONE_COLUMNS.includes(t.column?.name ?? ''));
      const overdue = open.filter((t) => t.dueDate && t.dueDate < h.now());

      let leave: { type: string; startDate: Date; endDate: Date; status: string }[] | null = null;
      if (privileged) {
        leave = await h.db.leaveRequest.findMany({
          where: { userId: u.id, endDate: { gte: h.now() } },
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
        email: privileged ? full.email : undefined,
        phone: privileged ? full.phone : undefined,
        bio: full.bio,
        skills: full.skills,
        startDate: full.startDate,
        // AI-03: a colleague's full project-membership roster is over-share for a
        // non-privileged viewer — gate it to admin/HR/self (like email/phone).
        projects: privileged
          ? full.projectMembers.map((m) => ({
              name: m.project.name,
              status: m.project.status,
              role: m.role,
            }))
          : undefined,
        tasks: {
          open: open.length,
          overdue: overdue.length,
          done: tasks.length - open.length,
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
          : h.isAdminOrHr
            ? undefined
            : 'Task figures reflect only work you can see.',
      };
    },
  });

  tools.getLeaveOverview = tool({
    description:
      'Who is on leave or has time off requested (vacation / sick / remote), with dates and status. Use for "who is off", "is <name> on leave", "pending leave requests", "my time off". Employees see only their own requests; admins and HR see everyone.',
    inputSchema: z.object({
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).nullish(),
      upcomingOnly: z.boolean().nullish().describe('Default true — hide past leave'),
    }),
    execute: async ({ status, upcomingOnly }) => {
      const leave = await h.db.leaveRequest.findMany({
        where: {
          ...(h.isAdminOrHr ? {} : { userId: ctx.userId }),
          ...(status ? { status } : {}),
          ...(upcomingOnly === false ? {} : { endDate: { gte: h.now() } }),
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
  });

  if (h.isAdminOrHr) {
    tools.getHrOverview = tool({
      description:
        'People-ops dashboard: active headcount, who is out today, pending leave requests, recent hires (last 30 days), and upcoming work anniversaries (next 30 days). Use for "HR overview", "how many people work here", "who is out today", "any new hires". ADMIN / HR only.',
      inputSchema: z.object({}),
      execute: async () => {
        if (!h.isAdminOrHr) return { error: 'The HR overview is restricted to admins and HR.' };
        const now = h.now();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const todayEnd = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          23,
          59,
          59,
          999
        );
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const thirtyDaysAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        const [outToday, pendingLeave, pendingLeaveTotal, recentHires, allActive] =
          await Promise.all([
            h.db.leaveRequest.findMany({
              where: {
                status: 'APPROVED',
                startDate: { lte: todayEnd },
                endDate: { gte: todayStart },
              },
              include: { user: { select: { name: true, title: true } } },
              orderBy: { endDate: 'asc' },
            }),
            h.db.leaveRequest.findMany({
              where: { status: 'PENDING' },
              include: { user: { select: { name: true, title: true } } },
              orderBy: { createdAt: 'desc' },
              take: 5,
            }),
            h.db.leaveRequest.count({ where: { status: 'PENDING' } }),
            h.db.user.findMany({
              where: { startDate: { gte: thirtyDaysAgo }, status: { not: 'INACTIVE' } },
              select: { name: true, title: true, department: true, startDate: true },
              orderBy: { startDate: 'desc' },
            }),
            h.db.user.findMany({
              where: { status: { not: 'INACTIVE' } },
              select: { name: true, title: true, startDate: true },
            }),
          ]);

        const upcomingAnniversaries = allActive
          .map((u) => {
            const start = new Date(u.startDate);
            const thisYear = new Date(now.getFullYear(), start.getMonth(), start.getDate());
            const nextOccurrence =
              thisYear >= todayStart
                ? thisYear
                : new Date(now.getFullYear() + 1, start.getMonth(), start.getDate());
            const years = nextOccurrence.getFullYear() - start.getFullYear();
            return { name: u.name, title: u.title, anniversaryDate: nextOccurrence, years };
          })
          .filter((u) => u.years >= 1 && u.anniversaryDate <= thirtyDaysAhead)
          .sort((a, b) => a.anniversaryDate.getTime() - b.anniversaryDate.getTime())
          .slice(0, 5);

        return {
          activeHeadcount: allActive.length,
          pendingLeaveTotal,
          outToday: outToday.map((l) => ({
            person: l.user.name,
            title: l.user.title,
            type: l.type,
            until: l.endDate,
          })),
          pendingLeave: pendingLeave.map((l) => ({
            person: l.user.name,
            type: l.type,
            startDate: l.startDate,
            endDate: l.endDate,
          })),
          recentHires: recentHires.map((u) => ({
            name: u.name,
            title: u.title,
            department: u.department,
            startDate: u.startDate,
          })),
          upcomingAnniversaries: upcomingAnniversaries.map((u) => ({
            name: u.name,
            title: u.title,
            years: u.years,
            date: u.anniversaryDate,
          })),
        };
      },
    });
  }

  tools.listPerformanceNotes = tool({
    description:
      'List performance notes / feedback recorded about a team member, newest first. Visible only to admins or to that person about themselves. Use for "performance notes for <name>", "what feedback do I have". Give the person\'s name (or "me").',
    inputSchema: z.object({
      name: z.string().describe('The person\'s name, or "me" for yourself'),
    }),
    execute: async ({ name }) => {
      let targetId: string;
      let targetName: string;
      let interpreted: string | undefined;
      const lower = name.trim().toLowerCase();
      if (lower === 'me' || lower === 'myself' || lower === 'i') {
        targetId = ctx.userId;
        targetName = ctx.name ?? 'you';
      } else {
        const r = await h.resolvePerson(name, { includeInactive: true });
        if (r.kind === 'notfound') return { error: `No team member matches "${name}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };
        targetId = r.value.id;
        targetName = r.value.name;
        interpreted = r.interpreted;
      }

      const isSelf = targetId === ctx.userId;
      if (!h.isAdmin && !isSelf) {
        return {
          error: 'Performance notes are visible only to admins or to the person themselves.',
        };
      }

      const notes = await h.db.performanceNote.findMany({
        where: { userId: targetId },
        include: { author: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return {
        person: targetName,
        count: notes.length,
        notes: notes.map((n) => ({
          author: n.author.name,
          content: n.content,
          createdAt: n.createdAt,
        })),
        scopeNote: interpreted ? `Interpreted "${name}" as ${interpreted}.` : undefined,
      };
    },
  });

  // ─────────────────────────────── WRITES ───────────────────────────────────
  // Each sets needsApproval:true (the SDK pauses for the user to confirm before
  // execute runs the real mutation), authorizes again inside execute, and
  // mirrors the side effects of its tRPC counterpart.

  // Submit your OWN leave request (mirrors team.createLeaveRequest). Available
  // to every member.
  tools.requestLeave = tool({
    description:
      'Submit a time-off / leave request for YOURSELF (vacation, sick, or remote) for a date range. Use for "request leave", "book vacation", "I\'ll be out", "work from home next week". The request is created as PENDING for HR/admin to approve.',
    inputSchema: z.object({
      type: z.enum(['VACATION', 'SICK', 'REMOTE']),
      startDate: z.string().describe('ISO date the leave starts, e.g. "2026-07-01"'),
      endDate: z.string().describe('ISO date the leave ends (inclusive)'),
      reason: z.string().nullish().describe('Optional note for the approver'),
    }),
    needsApproval: true,
    execute: async ({ type, startDate, endDate, reason }) => {
      const start = new Date(startDate);
      const end = new Date(endDate);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return { error: 'Provide valid start and end dates (ISO format, e.g. 2026-07-01).' };
      }
      if (end < start) return { error: 'The end date cannot be before the start date.' };

      const created = await h.db.leaveRequest.create({
        data: { type, startDate: start, endDate: end, reason: reason ?? null, userId: ctx.userId },
      });

      h.audit({
        category: 'TEAM',
        operation: 'CREATE',
        action: 'requestLeave',
        description: `Requested ${titleCase(type)} leave`,
        targetType: 'LeaveRequest',
        targetId: created.id,
        targetLabel: ctx.name ?? undefined,
        metadata: { type, startDate: start, endDate: end },
      });

      return {
        type: titleCase(type),
        startDate: created.startDate,
        endDate: created.endDate,
        status: created.status,
      };
    },
  });

  // Update your OWN profile (mirrors team.updateProfile: name/phone/bio/skills).
  tools.updateMyProfile = tool({
    description:
      'Update YOUR OWN profile — display name, phone, bio, and skills. Use for "update my bio", "change my phone number", "add a skill to my profile". Only fields you provide are changed.',
    inputSchema: z.object({
      name: z.string().min(1).nullish().describe('Your display name'),
      phone: z.string().nullish(),
      bio: z.string().nullish(),
      skills: z.array(z.string()).nullish().describe('Replaces your full skills list'),
    }),
    needsApproval: true,
    execute: async ({ name, phone, bio, skills }) => {
      const before = await h.db.user.findUnique({
        where: { id: ctx.userId },
        select: { name: true, phone: true, bio: true, skills: true },
      });
      if (!before) return { error: 'Your account was not found.' };

      const data: Prisma.UserUpdateInput = {};
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      if (name != null && name !== before.name) {
        data.name = name;
        changes.name = { before: before.name, after: name };
      }
      if (phone != null && phone !== before.phone) {
        data.phone = phone;
        changes.phone = { before: before.phone, after: phone };
      }
      if (bio != null && bio !== before.bio) {
        data.bio = bio;
        changes.bio = { before: before.bio, after: bio };
      }
      if (skills != null) {
        data.skills = skills;
        changes.skills = { before: before.skills, after: skills };
      }
      if (Object.keys(data).length === 0) {
        return { message: 'No changes provided — nothing was updated.' };
      }

      const updated = await h.db.user.update({
        where: { id: ctx.userId },
        data,
        select: { name: true, phone: true, bio: true, skills: true },
      });
      h.audit({
        category: 'TEAM',
        operation: 'UPDATE',
        action: 'updateMyProfile',
        description: 'Updated own profile',
        targetType: 'User',
        targetId: ctx.userId,
        targetLabel: updated.name,
        changes,
      });
      return { updated: Object.keys(changes), profile: updated };
    },
  });

  // ── HR / ADMIN capable: leave approval + lay-off ──────────────────────────
  if (h.isAdminOrHr) {
    // Approve or decline a person's PENDING leave request (mirrors
    // team.updateLeaveStatus + its requester notification).
    tools.setLeaveStatus = tool({
      description:
        "Approve or decline a team member's PENDING time-off request. Use for \"approve <name>'s vacation\", \"decline <name>'s leave\". Give the person's name; if they have more than one pending request you'll be asked which dates. The requester is notified of the decision. ADMIN / HR only.",
      inputSchema: z.object({
        name: z.string().describe('The requester\'s name, e.g. "Aisha Khan"'),
        status: z.enum(['APPROVED', 'REJECTED']).describe('REJECTED = declined'),
        note: z.string().nullish().describe('Optional note (recorded in the audit trail)'),
      }),
      needsApproval: true,
      execute: async ({ name, status, note }) => {
        if (!(await h.can('leave:approve'))) {
          return { error: 'You do not have permission to approve leave requests.' };
        }
        const r = await h.resolvePerson(name, { includeInactive: true });
        if (r.kind === 'notfound') return { error: `No team member matches "${name}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };

        // HR-01: separation of duties — never decide your own leave request.
        if (r.value.id === ctx.userId) {
          return { error: 'You cannot approve or reject your own leave request.' };
        }

        const pending = await h.db.leaveRequest.findMany({
          where: { userId: r.value.id, status: 'PENDING' },
          orderBy: { startDate: 'asc' },
          select: { id: true, type: true, startDate: true, endDate: true },
        });
        if (pending.length === 0) {
          return { error: `${r.value.name} has no pending leave request to act on.` };
        }
        if (pending.length > 1) {
          const options = pending
            .map((p) => `${titleCase(p.type)} ${shortDate(p.startDate)}–${shortDate(p.endDate)}`)
            .join(', ');
          return {
            needsClarification: `${r.value.name} has several pending requests — which one? ${options}`,
          };
        }

        const leave = await h.db.leaveRequest.update({
          where: { id: pending[0].id },
          data: { status, approvedById: ctx.userId },
          select: {
            id: true,
            type: true,
            startDate: true,
            endDate: true,
            status: true,
            userId: true,
          },
        });

        const displayStatus = status === 'REJECTED' ? 'DECLINED' : 'APPROVED';
        const range = `${leave.startDate.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        })} – ${leave.endDate.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })}`;

        // Notify the requester (in-app + email) — mirrors the router exactly.
        h.notifyUsers([leave.userId], {
          type: 'leave_status',
          title: `Time off ${displayStatus.toLowerCase()}`,
          message: `Your ${titleCase(leave.type)} request was ${displayStatus.toLowerCase()}.${
            note ? ` Note: ${note}` : ''
          }`,
          entityType: 'LeaveRequest',
          entityId: leave.id,
          email: (rcpt) =>
            templates.leaveRequest({
              recipientName: rcpt.name,
              employeeName: rcpt.name,
              leaveType: titleCase(leave.type),
              rangeLabel: range,
              status: displayStatus,
              url: `${appUrl()}/hr`,
            }),
        });

        h.audit({
          category: 'TEAM',
          operation: 'UPDATE',
          action: 'setLeaveStatus',
          description: `${displayStatus} ${r.value.name}'s ${titleCase(leave.type)} leave`,
          targetType: 'LeaveRequest',
          targetId: leave.id,
          targetLabel: r.value.name,
          changes: { status: { before: 'PENDING', after: status } },
          metadata: note ? { note } : undefined,
        });

        return {
          person: r.value.name,
          type: titleCase(leave.type),
          range,
          status: displayStatus,
          notified: true,
          scopeNote: r.interpreted ? `Interpreted "${name}" as ${r.value.name}.` : undefined,
        };
      },
    });

    // THE headline action: lay off / terminate a member (mirrors team.layOffMember).
    tools.layOffMember = tool({
      description:
        'Lay off / terminate / fire / offboard a team member — sets them INACTIVE (they lose access) and emails them a deactivation notice with the reason. A soft-delete: their records are kept. Use for "fire <name>", "lay off <name>", "terminate <name>", "let <name> go". Call this DIRECTLY with the person\'s name — it resolves the name itself, including former/inactive members, so do NOT look them up with listTeam first. Requires a reason; if none was given, ask for one. Admins may lay off anyone; HR may lay off non-admins only. You cannot lay off yourself or the last active admin.',
      inputSchema: z.object({
        name: z.string().describe('The team member to lay off, e.g. "Aisha Khan"'),
        reason: z
          .string()
          .min(3)
          .max(2000)
          .describe('Why they are being laid off (recorded + included in their notice email)'),
      }),
      needsApproval: true,
      execute: async ({ name, reason }) => {
        const r = await h.resolvePerson(name, { includeInactive: true });
        if (r.kind === 'notfound') return { error: `No team member matches "${name}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };

        const before = await h.db.user.findUnique({
          where: { id: r.value.id },
          select: { id: true, name: true, email: true, role: true, status: true },
        });
        if (!before) return { error: 'That team member was not found.' };
        if (before.id === ctx.userId) return { error: 'You cannot lay off yourself.' };
        // Already gone — don't silently "re-lay-off"; report it plainly so the
        // model never tells the user the person doesn't exist.
        if (before.status === 'INACTIVE') {
          return {
            error: `${before.name} is already inactive — they were laid off / deactivated previously. No action needed.`,
          };
        }

        // ABAC: admins may lay off anyone; HR may lay off non-admins only.
        if (!(await h.can('team:layoff', { type: 'User', targetRole: before.role }))) {
          return { error: 'You do not have permission to lay off this member.' };
        }

        // Never strand the workspace without an admin.
        if (before.role === 'ADMIN') {
          const otherActiveAdmins = await h.db.user.count({
            where: { id: { not: before.id }, role: 'ADMIN', status: 'ACTIVE' },
          });
          if (otherActiveAdmins === 0) {
            return { error: 'You cannot lay off the last active admin.' };
          }
        }

        const cleanReason = reason.trim();
        const updated = await h.db.user.update({
          where: { id: before.id },
          data: { status: 'INACTIVE' },
          select: { id: true, name: true },
        });

        h.audit({
          category: 'TEAM',
          operation: 'UPDATE',
          action: 'layOffMember',
          description: `Laid off ${updated.name}`,
          targetType: 'User',
          targetId: updated.id,
          targetLabel: updated.name,
          changes: { status: { before: before.status ?? null, after: 'INACTIVE' } },
          metadata: { laidOff: true, reason: cleanReason },
        });

        h.activity({
          type: 'member_status_changed',
          message: `laid off ${updated.name}`,
          entityType: 'User',
          entityId: updated.id,
        });

        // Best-effort deactivation notice — never blocks the lay-off.
        if (before.email) {
          const mail = templates.accountDeactivated({
            name: updated.name,
            byName: ctx.name ?? undefined,
            reason: cleanReason,
          });
          sendEmail({
            to: { email: before.email, name: updated.name },
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
          }).catch((err) => console.error('[assistant] lay-off notice email failed:', err));
        }

        return {
          name: updated.name,
          status: 'INACTIVE',
          emailed: true,
          scopeNote: r.interpreted ? `Interpreted "${name}" as ${updated.name}.` : undefined,
        };
      },
    });
  }

  // ── ADMIN only ────────────────────────────────────────────────────────────
  if (h.isAdmin) {
    // Reactivate (ACTIVE) or place ON_LEAVE — NOT terminate (use layOffMember).
    tools.setMemberStatus = tool({
      description:
        'Reactivate a team member (set ACTIVE) or place them ON_LEAVE. Use for "reactivate <name>", "bring <name> back", "mark <name> on leave". To terminate / lay someone off, use layOffMember instead. ADMIN only. You cannot change your own status.',
      inputSchema: z.object({
        name: z.string().describe('The team member\'s name, e.g. "Aisha Khan"'),
        status: z.enum(['ACTIVE', 'ON_LEAVE']).describe('ACTIVE = reactivate'),
      }),
      needsApproval: true,
      execute: async ({ name, status }) => {
        if (!h.isAdmin) return { error: "Only admins can change a team member's status." };
        const r = await h.resolvePerson(name, { includeInactive: true });
        if (r.kind === 'notfound') return { error: `No team member matches "${name}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };

        const before = await h.db.user.findUnique({
          where: { id: r.value.id },
          select: { id: true, name: true, status: true },
        });
        if (!before) return { error: 'That team member was not found.' };
        if (before.id === ctx.userId) return { error: "You can't change your own status." };
        if (before.status === status) {
          return { name: before.name, status, message: `${before.name} is already ${status}.` };
        }

        const updated = await h.db.user.update({
          where: { id: before.id },
          data: { status },
          select: { id: true, name: true, status: true },
        });

        h.audit({
          category: 'TEAM',
          operation: 'UPDATE',
          action: 'setMemberStatus',
          description: `Set ${updated.name}'s status to ${status}`,
          targetType: 'User',
          targetId: updated.id,
          targetLabel: updated.name,
          changes: { status: { before: before.status ?? null, after: status } },
        });
        h.activity({
          type: 'member_status_changed',
          message: `set ${updated.name}'s status to ${status}`,
          entityType: 'User',
          entityId: updated.id,
        });

        return {
          name: updated.name,
          status: updated.status,
          scopeNote: r.interpreted ? `Interpreted "${name}" as ${updated.name}.` : undefined,
        };
      },
    });

    // Invite a new member (mirrors team.inviteMember): create/refresh an INVITED
    // user with no password, mint a single-use token, email an accept link.
    tools.inviteMember = tool({
      description:
        'Invite a NEW person to the workspace by email. Creates them in an invited state and emails them a single-use link to set their own password and finish their profile — you never set a password. Use for "invite <name>", "add <email> to the team", "onboard a new engineer". ADMIN only.',
      inputSchema: z.object({
        name: z.string().min(1).describe('Their full name'),
        // NB: no .email() — Groq's strict function-schema validator rejects
        // `format` keywords (400s the whole request). Validated in execute.
        email: z.string().describe('Their work email — the invite is sent here'),
        role: z.enum(['ADMIN', 'HR', 'EMPLOYEE']).nullish().describe('Default EMPLOYEE'),
        department: departmentKey,
        title: z.string().min(1).describe('Their job title, e.g. "Senior Engineer"'),
        phone: z.string().nullish(),
        bio: z.string().nullish(),
        skills: z.array(z.string()).nullish(),
      }),
      needsApproval: true,
      execute: async ({ name, email, role, department, title, phone, bio, skills }) => {
        if (!h.isAdmin) return { error: 'Only admins can invite members.' };
        // D10: normalize BEFORE validating, so a padded or upper-cased address
        // the model echoed back from a chat message is accepted and stored in the
        // one canonical form used by the guard, the create, and the invitation.
        const lowerEmail = normalizeEmail(email);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lowerEmail)) {
          return { error: `"${email}" doesn't look like a valid email address.` };
        }
        const finalRole = role ?? 'EMPLOYEE';

        // Departments are tenant-configured: reject a key this workspace does
        // not have rather than letting the composite foreign key raise.
        const departmentRow = await h.db.organizationDepartment.findFirst({
          where: { key: department, active: true },
          select: { id: true },
        });
        if (!departmentRow) {
          return { error: `"${department}" is not an active department in this workspace.` };
        }

        const existing = await h.db.user.findFirst({
          where: { email: lowerEmail },
          select: { id: true, status: true },
        });
        if (existing && existing.status !== 'INVITED') {
          return { error: 'A user with this email already exists.' };
        }

        const { token, tokenHash } = generateInviteToken();
        const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
        const profile = {
          name,
          role: finalRole,
          department,
          title,
          phone: phone ?? null,
          bio: bio ?? null,
          skills: skills ?? [],
        };

        const user = await h.db.$transaction(async (tx) => {
          const u = existing
            ? await tx.user.update({
                where: { id: existing.id },
                data: { ...profile, password: null, status: 'INVITED' },
              })
            : await tx.user.create({
                data: { ...profile, email: lowerEmail, password: null, status: 'INVITED' },
              });
          await tx.invitation.upsert({
            where: { userId: u.id },
            create: {
              userId: u.id,
              email: lowerEmail,
              tokenHash,
              invitedById: ctx.userId,
              expiresAt,
            },
            update: { tokenHash, expiresAt, acceptedAt: null, invitedById: ctx.userId },
          });
          return u;
        });

        const inviteUrl = `${appUrl()}/invite/${token}`;
        let emailed = true;
        const mail = templates.inviteMember({
          name: user.name,
          inviterName: ctx.name ?? undefined,
          role: `${titleCase(finalRole)} · ${titleCase(department)}`,
          workspace: 'DevFathom',
          acceptUrl: inviteUrl,
          expiresLabel: 'in 7 days',
        });
        try {
          await sendEmail({
            to: { email: lowerEmail, name: user.name },
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
          });
        } catch (err) {
          console.error('[assistant] invite email failed for', lowerEmail, err);
          emailed = false;
        }

        h.audit({
          category: 'TEAM',
          operation: 'CREATE',
          action: 'inviteMember',
          description: `Invited ${user.name} (${finalRole} · ${department})`,
          targetType: 'User',
          targetId: user.id,
          targetLabel: user.name,
          metadata: { email: lowerEmail, role: finalRole, department, reInvite: !!existing },
        });

        return {
          name: user.name,
          email: lowerEmail,
          role: titleCase(finalRole),
          department: titleCase(department),
          emailed,
          // Bearer credentials stay in the out-of-band invitation email.
        };
      },
    });

    // Update another member's role / department / title / phone / bio / skills
    // (mirrors team.adminUpdateMember). Changing role is a privilege; guard the
    // last active admin against being demoted out of existence.
    tools.updateMember = tool({
      description:
        'Update another team member\'s details — role, department, title, phone, bio, or skills. Use for "make <name> an admin", "move <name> to Engineering", "change <name>\'s title". Only fields you provide change. To activate/deactivate someone use setMemberStatus or layOffMember. ADMIN only.',
      inputSchema: z.object({
        name: z.string().describe('The member to update, e.g. "Aisha Khan"'),
        role: z.enum(['ADMIN', 'HR', 'EMPLOYEE']).nullish(),
        department: departmentKey.nullish(),
        title: z.string().min(1).nullish(),
        phone: z.string().nullish(),
        bio: z.string().nullish(),
        skills: z.array(z.string()).nullish().describe('Replaces their full skills list'),
      }),
      needsApproval: true,
      execute: async ({ name, role, department, title, phone, bio, skills }) => {
        if (!h.isAdmin) return { error: 'Only admins can update team members.' };
        const r = await h.resolvePerson(name, { includeInactive: true });
        if (r.kind === 'notfound') return { error: `No team member matches "${name}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };

        const before = await h.db.user.findUnique({
          where: { id: r.value.id },
          select: {
            id: true,
            name: true,
            role: true,
            department: true,
            title: true,
            phone: true,
            bio: true,
            skills: true,
            status: true,
          },
        });
        if (!before) return { error: 'That team member was not found.' };

        const data: Prisma.UserUncheckedUpdateInput = {};
        const changes: Record<string, { before: unknown; after: unknown }> = {};
        if (role != null && role !== before.role) {
          // Changing a role is privilege escalation/de-escalation: never demote
          // the last active admin out of the ADMIN role.
          if (before.role === 'ADMIN' && role !== 'ADMIN') {
            const otherActiveAdmins = await h.db.user.count({
              where: { id: { not: before.id }, role: 'ADMIN', status: 'ACTIVE' },
            });
            if (otherActiveAdmins === 0) {
              return { error: "You can't change the role of the last active admin." };
            }
          }
          data.role = role;
          changes.role = { before: before.role, after: role };
        }
        if (department != null && department !== before.department) {
          // Same tenant-configured check as the invite path.
          const departmentRow = await h.db.organizationDepartment.findFirst({
            where: { key: department, active: true },
            select: { id: true },
          });
          if (!departmentRow) {
            return { error: `"${department}" is not an active department in this workspace.` };
          }
          data.department = department;
          changes.department = { before: before.department, after: department };
        }
        if (title != null && title !== before.title) {
          data.title = title;
          changes.title = { before: before.title, after: title };
        }
        if (phone != null && phone !== before.phone) {
          data.phone = phone;
          changes.phone = { before: before.phone, after: phone };
        }
        if (bio != null && bio !== before.bio) {
          data.bio = bio;
          changes.bio = { before: before.bio, after: bio };
        }
        if (skills != null) {
          data.skills = skills;
          changes.skills = { before: before.skills, after: skills };
        }
        if (Object.keys(data).length === 0) {
          return { name: before.name, message: 'No changes provided — nothing was updated.' };
        }

        const updated = await h.db.user.update({
          where: { id: before.id },
          data,
          select: { name: true, role: true, department: true, title: true },
        });
        h.audit({
          category: 'TEAM',
          operation: 'UPDATE',
          action: 'updateMember',
          description: `Updated team member ${updated.name}`,
          targetType: 'User',
          targetId: before.id,
          targetLabel: updated.name,
          changes,
        });

        return {
          name: updated.name,
          updated: Object.keys(changes),
          role: updated.role,
          department: updated.department,
          title: updated.title,
          scopeNote: r.interpreted ? `Interpreted "${name}" as ${updated.name}.` : undefined,
        };
      },
    });

    // Reset another member's password (mirrors team.adminResetPassword).
    tools.resetMemberPassword = tool({
      description:
        'Set a new password for another team member (admin password reset). Use for "reset <name>\'s password", "set a new password for <name>". The password is stored hashed and never echoed back. ADMIN only.',
      inputSchema: z.object({
        name: z.string().describe('The member whose password to reset, e.g. "Aisha Khan"'),
        // AI-01: a bare min(8) string only — the policy regexes serialize to
        // `allOf`/`pattern`, which Groq's strict validator 400s (taking the whole
        // request, and every approval-continuation, down). Enforce the full policy
        // inside execute via passwordMeetsPolicy() instead. Mirrors inviteMember.
        newPassword: z
          .string()
          .min(8)
          .describe('At least 8 chars with an uppercase letter, a lowercase letter, and a number'),
      }),
      needsApproval: true,
      execute: async ({ name, newPassword }) => {
        if (!h.isAdmin) return { error: 'Only admins can reset passwords.' };
        if (!passwordMeetsPolicy(newPassword)) {
          return {
            error:
              'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, and a number.',
          };
        }
        const r = await h.resolvePerson(name, { includeInactive: true });
        if (r.kind === 'notfound') return { error: `No team member matches "${name}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };

        const hashed = await hash(newPassword, 12);
        const user = await h.db.user.update({
          where: { id: r.value.id },
          data: { password: hashed },
          select: { id: true, name: true },
        });
        h.audit({
          category: 'TEAM',
          operation: 'UPDATE',
          action: 'resetMemberPassword',
          description: `Reset password for ${user.name}`,
          targetType: 'User',
          targetId: user.id,
          targetLabel: user.name,
          metadata: { passwordReset: true },
        });
        return {
          name: user.name,
          success: true,
          scopeNote: r.interpreted ? `Interpreted "${name}" as ${user.name}.` : undefined,
        };
      },
    });

    // Record a performance note about a member (mirrors team.addPerformanceNote).
    tools.addPerformanceNote = tool({
      description:
        'Record a performance note / piece of feedback about a team member. Use for "add a performance note for <name>", "log feedback on <name>". The note is attributed to you and visible to admins and the subject. ADMIN only.',
      inputSchema: z.object({
        name: z.string().describe('The person the note is about, e.g. "Aisha Khan"'),
        content: z.string().min(1).max(4000).describe('The note text'),
      }),
      needsApproval: true,
      execute: async ({ name, content }) => {
        if (!h.isAdmin) return { error: 'Only admins can add performance notes.' };
        const r = await h.resolvePerson(name, { includeInactive: true });
        if (r.kind === 'notfound') return { error: `No team member matches "${name}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };

        await h.db.performanceNote.create({
          data: { userId: r.value.id, authorId: ctx.userId, content },
        });
        h.audit({
          category: 'TEAM',
          operation: 'CREATE',
          action: 'addPerformanceNote',
          description: `Added a performance note for ${r.value.name}`,
          targetType: 'User',
          targetId: r.value.id,
          targetLabel: r.value.name,
          metadata: { performanceNote: true },
        });
        return {
          person: r.value.name,
          success: true,
          scopeNote: r.interpreted ? `Interpreted "${name}" as ${r.value.name}.` : undefined,
        };
      },
    });
  }

  return tools;
}
