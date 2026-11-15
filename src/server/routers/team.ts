import { z } from 'zod';
import { hash, compare } from 'bcryptjs';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import {
  router,
  protectedProcedure,
  adminProcedure,
  hrProcedure,
  capabilityProcedure,
  assertModuleLicensed,
} from '../trpc';
import { can, subjectFromSession } from '@/lib/abac';
import { assertNotificationOwner } from '../authz';
import { annotateAudit, diffChanges } from '../audit';
import { appUrl, templates, sendEmail } from '@/lib/email';
import { notify } from '@/lib/notifications';
import type { NotificationPrefs } from '@/lib/notifications';
import { emailSchema } from '@/lib/email-address';
import { assertInOrganization, workspaceId } from '../org-refs';
import { passwordSchema } from '@/lib/password-policy';
import { createMemberInvitation } from '@/lib/member-invitation';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// IMP-AUTH-04: per-category × per-channel notification opt-outs. Sparse —
// anything unset means "opted in" (notify() defaults to ON). Keys mirror
// NOTIFICATION_CATEGORIES in @/lib/notifications.
const channelPrefsSchema = z
  .object({ inApp: z.boolean().optional(), email: z.boolean().optional() })
  .strict();
const notificationPrefsSchema = z
  .object({
    task: channelPrefsSchema.optional(),
    mention: channelPrefsSchema.optional(),
    meeting: channelPrefsSchema.optional(),
    leave: channelPrefsSchema.optional(),
    invoice: channelPrefsSchema.optional(),
    project: channelPrefsSchema.optional(),
    client: channelPrefsSchema.optional(),
    resignation: channelPrefsSchema.optional(),
    note: channelPrefsSchema.optional(),
  })
  .strict();

// "LEADERSHIP" → "Leadership", "ADMIN" → "Admin". Acronym roles stay upper-case.
const titleCase = (s: string) => (s === 'HR' ? 'HR' : s.charAt(0) + s.slice(1).toLowerCase());

// #424: the organization row lock serializes admin-roster changes across
// requests, but a batched tRPC request runs every mutation concurrently inside
// ONE shared transaction (nested `$transaction` reuses it). Postgres row locks
// are re-entrant for their owning transaction, so sibling mutations in a batch
// would all pass the lock and could each count the same admins before either
// write lands. Chain the full lock -> check -> write section per transaction
// handle so siblings in one batch run it one at a time.
const adminRosterQueues = new WeakMap<object, Promise<unknown>>();

function withAdminRosterLock<T>(
  db: ScopedDb,
  organizationId: string,
  lock: boolean,
  run: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  const operation = () =>
    db.$transaction(async (tx) => {
      if (lock) {
        await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId} FOR UPDATE`;
      }
      return run(tx);
    });
  const prior = adminRosterQueues.get(db) ?? Promise.resolve();
  const result = prior.then(operation, operation);
  adminRosterQueues.set(
    db,
    result.then(
      () => undefined,
      () => undefined
    )
  );
  return result;
}

// IMP-HR-01: the leave types we track balances for (mirrors the LeaveType enum).
const LEAVE_TYPES = ['VACATION', 'SICK', 'REMOTE'] as const;

// IMP-HR-01: inclusive whole-day span of a leave request (Jun 3 → Jun 5 = 3 days).
// Normalize to local midnight so partial-day timestamps don't skew the count.
function leaveDayCount(start: Date, end: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
  return Math.max(1, Math.floor((e - s) / MS_PER_DAY) + 1);
}

/**
 * The tasks a viewer may see: assigned to them, or on a project they belong to.
 * The rule Ask Fathom's task and people tools apply (`taskVisibility` in
 * src/lib/ai/context.ts); an administrator sees every task.
 */
function tasksVisibleTo(viewerId: string): Prisma.TaskWhereInput {
  return {
    OR: [
      { assignees: { some: { userId: viewerId } } },
      { column: { board: { project: { members: { some: { userId: viewerId } } } } } },
    ],
  };
}

export const teamRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const me = ctx.session.user.id;
    // A custom role or override that denies `team:view` takes the directory
    // away, as it takes a colleague's profile away in `getById`; the viewer
    // still reads their own row there, and so here.
    const directory = await can(subjectFromSession(ctx.session.user), 'team:view', undefined, {
      source: 'TRPC',
      db: ctx.db,
    });
    const rows = await ctx.db.user.findMany({
      ...(directory ? {} : { where: { id: me } }),
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
    // IMP-HR-06: directory privacy — contact PII (email/phone) is visible to
    // HR/Admin and to a person on their OWN row; everyone else sees it redacted.
    const isPrivileged = ['ADMIN', 'HR'].includes(ctx.session.user.role);
    if (isPrivileged) return rows;
    return rows.map((u) => (u.id === me ? u : { ...u, email: '', phone: null }));
  }),

  // Lightweight roster — just enough to render avatars and names.
  getRoster: protectedProcedure.query(async ({ ctx }) => {
    const me = ctx.session.user.id;
    // Keep this lightweight directory consistent with getAll: an explicit
    // team:view denial must not turn the roster into a directory side door.
    const directory = await can(subjectFromSession(ctx.session.user), 'team:view', undefined, {
      source: 'TRPC',
      db: ctx.db,
    });
    return ctx.db.user.findMany({
      ...(directory ? {} : { where: { id: me } }),
      select: {
        id: true,
        name: true,
        avatar: true,
        title: true,
      },
      orderBy: { name: 'asc' },
    });
  }),

  // Invite a new member: create them in the INVITED state with no password, mint
  // a single-use token, and email them a link to set their own password and finish
  // their profile. The admin never sets (or sees) a password. Re-inviting someone
  // who is still pending just refreshes their details and issues a new link.
  inviteMember: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        // D10: normalized here so the duplicate guard below and the stored row
        // agree. Previously the guard lowercased the input but the index was
        // case-sensitive, so ALEX@COMPANY.COM could be created alongside
        // alex@company.com without the guard ever firing.
        email: emailSchema,
        role: z.enum(['ADMIN', 'HR', 'EMPLOYEE']).default('EMPLOYEE'),
        organizationRoleId: z.string().trim().min(1).max(128).nullable().default(null),
        department: z
          .string()
          .trim()
          .min(2)
          .max(80)
          .regex(/^[A-Z0-9_]+$/),
        title: z.string().min(1),
        phone: z.string().optional(),
        bio: z.string().optional(),
        skills: z.array(z.string()).default([]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const email = input.email;
      const department = await ctx.db.organizationDepartment.findFirst({
        where: { key: input.department, active: true },
        select: { id: true },
      });
      if (!department) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid department.' });
      const organizationRole = input.organizationRoleId
        ? await ctx.db.organizationRole.findFirst({
            where: { id: input.organizationRoleId, organizationId: workspaceId(ctx) },
            select: { id: true, name: true },
          })
        : null;
      if (input.organizationRoleId && !organizationRole) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid role template.' });
      }
      const profile = {
        name: input.name,
        role: input.role,
        // An unselected template (including the form's null) must not clear a
        // pending invite's staff role. New users default to no template in DB.
        ...(organizationRole ? { organizationRoleId: organizationRole.id } : {}),
        department: input.department,
        title: input.title,
        phone: input.phone ?? null,
        bio: input.bio ?? null,
        skills: input.skills,
      };

      const { user, token } = await ctx.db.$transaction((tx) =>
        createMemberInvitation(tx, {
          organizationId: workspaceId(ctx),
          email,
          seatLimit: ctx.entitlements.seatLimit,
          invitedById: ctx.session.user.id,
          profile,
        })
      );

      const inviteUrl = `${appUrl()}/invite/${token}`;

      // Best-effort send — never fail the mutation on an email hiccup; the admin
      // still gets the inviteUrl back to share manually if delivery is unverified.
      const mail = templates.inviteMember({
        name: user.name,
        inviterName: ctx.session.user.name ?? undefined,
        role: organizationRole?.name ?? `${titleCase(input.role)} · ${titleCase(input.department)}`,
        workspace: 'DevFathom',
        acceptUrl: inviteUrl,
        expiresLabel: 'in 7 days',
      });
      try {
        await sendEmail({
          to: { email, name: user.name },
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
      } catch (err) {
        console.error('[inviteMember] invite email failed for', email, err);
      }

      return { id: user.id, inviteUrl };
    }),

  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const viewerId = ctx.session.user.id;
    const isAdmin = ctx.session.user.role === 'ADMIN';
    const isSelf = viewerId === input.id;
    // IMP-HR-06, as `getAll` applies it: a colleague's email and phone are for
    // HR and Admin; everyone else reads them redacted. Your own row is yours.
    const privileged = isSelf || ['ADMIN', 'HR'].includes(ctx.session.user.role);
    // A colleague's work, only as far as the viewer could see it anyway: their
    // project list to the same privileged readers (Ask Fathom's AI-03 rule),
    // otherwise only the projects the viewer is on too; their tasks only where
    // the viewer may see the task, unless the viewer is the person or an Admin.
    const workScope = {
      projects: privileged ? 'ALL' : 'SHARED',
      tasks: isSelf || isAdmin ? 'ALL' : 'VISIBLE',
    } as const;
    // Your own profile is account self-service (Settings) and needs no module;
    // any other member is the team directory, which the `hr` module licenses.
    // The procedure is therefore in ACCOUNT_PROCEDURES and the gate lives here.
    if (!isSelf) {
      assertModuleLicensed(ctx, 'hr');
      // Reading a colleague is a directory read, decided by the ABAC engine like
      // any `team:view` gate (a custom role or override can deny it).
      const allowed = await can(
        subjectFromSession(ctx.session.user),
        'team:view',
        { type: 'User', id: input.id },
        { source: 'TRPC', db: ctx.db }
      );
      if (!allowed) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission for this action.',
        });
      }
    }

    const member = await ctx.db.user.findUnique({
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
          ...(workScope.projects === 'ALL'
            ? {}
            : { where: { project: { members: { some: { userId: viewerId } } } } }),
          include: { project: { select: { id: true, name: true, status: true, type: true } } },
        },
        assignedTasks: {
          ...(workScope.tasks === 'ALL' ? {} : { where: { task: tasksVisibleTo(viewerId) } }),
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
    if (!member) return member;
    if (privileged) return { ...member, workScope };
    return { ...member, email: '', phone: null, workScope };
  }),

  getLeaveRequests: hrProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(1000).optional(),
          cursor: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ? Math.min(input.limit, 1000) : undefined;
      return ctx.db.leaveRequest.findMany({
        include: {
          user: { select: { id: true, name: true, avatar: true, department: true, title: true } },
          approvedBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        ...(input?.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
    }),

  createLeaveRequest: protectedProcedure
    .input(
      z
        .object({
          type: z.enum(['VACATION', 'SICK', 'REMOTE']),
          startDate: z.date(),
          endDate: z.date(),
          reason: z.string().optional(),
        })
        // HR-02: endDate must not precede startDate.
        .refine((d) => d.endDate >= d.startDate, {
          message: 'End date must be on or after the start date.',
          path: ['endDate'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      // HR-02: reject past-dated starts and overlapping requests, which corrupt
      // the "out today" / team-stats math.
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (input.startDate < today) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Leave cannot start in the past.',
        });
      }
      const overlap = await ctx.db.leaveRequest.findFirst({
        where: {
          userId: ctx.session.user.id,
          status: { in: ['PENDING', 'APPROVED'] },
          startDate: { lte: input.endDate },
          endDate: { gte: input.startDate },
        },
        select: { id: true },
      });
      if (overlap) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You already have a leave request overlapping these dates.',
        });
      }
      return ctx.db.leaveRequest.create({
        data: { ...input, userId: ctx.session.user.id },
      });
    }),

  // IMP-HR-03: self-service — withdraw your OWN still-PENDING leave request.
  cancelLeaveRequest: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const leave = await ctx.db.leaveRequest.findUnique({
        where: { id: input.id },
        select: { userId: true, status: true },
      });
      if (!leave) throw new TRPCError({ code: 'NOT_FOUND', message: 'Leave request not found' });
      if (leave.userId !== ctx.session.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You can only cancel your own request.',
        });
      }
      if (leave.status !== 'PENDING') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only a pending request can be cancelled.',
        });
      }
      await ctx.db.leaveRequest.delete({ where: { id: input.id } });
      return { success: true };
    }),

  // IMP-HR-03: self-service — edit your OWN pending request (same validation as create).
  updateLeaveRequest: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        type: z.enum(['VACATION', 'SICK', 'REMOTE']).optional(),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.leaveRequest.findUnique({
        where: { id: input.id },
        select: { userId: true, status: true, startDate: true, endDate: true },
      });
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Leave request not found' });
      if (existing.userId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You can only edit your own request.' });
      }
      if (existing.status !== 'PENDING') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only a pending request can be edited.',
        });
      }
      const start = input.startDate ?? existing.startDate;
      const end = input.endDate ?? existing.endDate;
      if (end < start) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'End date must be on or after the start date.',
        });
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (start < today) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Leave cannot start in the past.' });
      }
      const overlap = await ctx.db.leaveRequest.findFirst({
        where: {
          id: { not: input.id },
          userId: ctx.session.user.id,
          status: { in: ['PENDING', 'APPROVED'] },
          startDate: { lte: end },
          endDate: { gte: start },
        },
        select: { id: true },
      });
      if (overlap) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You already have a leave request overlapping these dates.',
        });
      }
      return ctx.db.leaveRequest.update({
        where: { id: input.id },
        data: {
          ...(input.type ? { type: input.type } : {}),
          startDate: start,
          endDate: end,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
      });
    }),

  updateLeaveStatus: capabilityProcedure('leave:approve')
    .input(
      z.object({
        id: z.string(),
        status: z.enum(['APPROVED', 'REJECTED']),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // HR-01: separation of duties. Load the request first, then refuse to
      // (a) decide your OWN leave, or (b) re-decide anything not still PENDING —
      // mirroring the resignation:review flow. The coarse leave:approve capability
      // alone carried no owner/state conditions.
      const organizationId = ctx.entitlements.organizationId;
      const existing = await ctx.db.leaveRequest.findFirst({
        where: { id: input.id, organizationId },
        select: { userId: true, status: true },
      });
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Leave request not found' });
      if (existing.userId === ctx.session.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You cannot approve or reject your own leave request.',
        });
      }
      if (existing.status !== 'PENDING') {
        throw new TRPCError({
          // A contender may first observe the row only after the winning
          // decision commits. Report the same conflict as a lost CAS rather
          // than making the result depend on request scheduling.
          code: 'CONFLICT',
          message: 'This leave request has already been decided.',
        });
      }

      const leave = await ctx.db.$transaction(async (tx) => {
        const transitioned = await tx.leaveRequest.updateMany({
          where: { id: input.id, organizationId, status: 'PENDING' },
          data: { status: input.status, approvedById: ctx.session.user.id },
        });
        if (transitioned.count === 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This leave request has already been decided.',
          });
        }

        return tx.leaveRequest.findFirstOrThrow({ where: { id: input.id, organizationId } });
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

  // IMP-HR-01: set/adjust a member's annual entitlement for one leave type.
  // Upserts on the (userId, year, type) unique key. HR/Admin only.
  setLeaveBalance: hrProcedure
    .input(
      z.object({
        userId: z.string(),
        year: z.number().int().min(2000).max(2100),
        type: z.enum(['VACATION', 'SICK', 'REMOTE']),
        entitledDays: z.number().int().min(0).max(366),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertInOrganization(ctx.db.user, workspaceId(ctx), [input.userId]);
      return ctx.db.leaveBalance.upsert({
        where: {
          userId_year_type: { userId: input.userId, year: input.year, type: input.type },
        },
        create: {
          userId: input.userId,
          year: input.year,
          type: input.type,
          entitledDays: input.entitledDays,
        },
        update: { entitledDays: input.entitledDays },
      });
    }),

  // IMP-HR-01: per-type entitled / used / remaining for one user in one year.
  // HR/Admin may inspect anyone; a normal employee is forced to their OWN record.
  // "used" = inclusive day-span of that user's APPROVED leave of that type whose
  // start falls within the year. Always returns all three types (entitled 0 when
  // no balance row exists yet) so the UI can render a complete table.
  getLeaveBalances: protectedProcedure
    .input(
      z.object({ userId: z.string().optional(), year: z.number().int().optional() }).optional()
    )
    .query(async ({ ctx, input }) => {
      const isPrivileged = ['ADMIN', 'HR'].includes(ctx.session.user.role);
      const year = input?.year ?? new Date().getFullYear();
      // Normal employees can only ever see their own balances.
      const userId = isPrivileged && input?.userId ? input.userId : ctx.session.user.id;

      const yearStart = new Date(year, 0, 1);
      const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

      const [balances, approved] = await Promise.all([
        ctx.db.leaveBalance.findMany({ where: { userId, year } }),
        ctx.db.leaveRequest.findMany({
          where: {
            userId,
            status: 'APPROVED',
            startDate: { gte: yearStart, lte: yearEnd },
          },
          select: { type: true, startDate: true, endDate: true },
        }),
      ]);

      const entitledByType: Record<string, number> = {};
      for (const b of balances) entitledByType[b.type] = b.entitledDays;
      const usedByType: Record<string, number> = {};
      for (const r of approved) {
        usedByType[r.type] = (usedByType[r.type] ?? 0) + leaveDayCount(r.startDate, r.endDate);
      }

      const types = LEAVE_TYPES.map((type) => {
        const entitledDays = entitledByType[type] ?? 0;
        const usedDays = usedByType[type] ?? 0;
        return { type, entitledDays, usedDays, remaining: entitledDays - usedDays };
      });

      return { userId, year, types };
    }),

  // IMP-HR-01: team calendar — APPROVED (optionally also PENDING) leave overlapping
  // the [startDate, endDate] window, for a "who's off when" view. Readable by any
  // signed-in member. Overlap math: range starts before the window ends AND ends
  // after the window starts.
  getTeamLeaveCalendar: protectedProcedure
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
        includePending: z.boolean().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const statuses: ('APPROVED' | 'PENDING')[] = input.includePending
        ? ['APPROVED', 'PENDING']
        : ['APPROVED'];
      return ctx.db.leaveRequest.findMany({
        where: {
          status: { in: statuses },
          startDate: { lte: input.endDate },
          endDate: { gte: input.startDate },
        },
        select: {
          id: true,
          type: true,
          status: true,
          startDate: true,
          endDate: true,
          user: { select: { id: true, name: true, avatar: true } },
        },
        orderBy: { startDate: 'asc' },
      });
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
      if (!user || !user.password) throw new TRPCError({ code: 'NOT_FOUND' });

      const valid = await compare(input.currentPassword, user.password);
      if (!valid)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Current password is incorrect' });

      const hashed = await hash(input.newPassword, 12);
      // AUTH-01: bump tokenVersion so every other live JWT session for this user
      // is revoked on its next jwt() revalidation. (The current session's token
      // is also stale, so the actor is re-prompted to log in — expected after a
      // password change.)
      await ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: {
          password: hashed,
          passwordChangedAt: new Date(),
          mustChangePassword: false,
          tokenVersion: { increment: 1 },
        },
      });
      return { success: true };
    }),

  // IMP-AUTH-03: "sign out everywhere". Bumping the caller's tokenVersion revokes
  // every JWT issued before now (including the current one) on its next jwt()
  // revalidation — the cross-device kill switch after a suspected compromise.
  signOutEverywhere: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.user.update({
      where: { id: ctx.session.user.id },
      data: { tokenVersion: { increment: 1 } },
    });
    return { success: true };
  }),

  // IMP-AUTH-03 (visibility half): the caller's own recent successful sign-ins,
  // surfaced from the audit trail. Auth is stateless JWT, so there is no
  // per-session registry to enumerate or revoke individually — these LOGIN rows
  // (source AUTH / operation LOGIN, written by recordAuthAudit on every
  // successful sign-in) are the closest thing to a "where am I signed in" view.
  // "Sign out everywhere" above is the only revocation, since individual JWTs
  // can't be listed or killed one-by-one.
  mySignIns: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.auditLog.findMany({
      where: {
        actorId: ctx.session.user.id,
        operation: 'LOGIN',
        outcome: 'SUCCESS',
      },
      select: { id: true, createdAt: true, ip: true, userAgent: true },
      orderBy: { createdAt: 'desc' },
      take: 15,
    });
  }),

  // IMP-AUTH-04: read the caller's own notification preferences. Returns the
  // stored sparse blob (or null when never set — the UI treats that as "all ON").
  getNotificationPrefs: protectedProcedure.query(async ({ ctx }) => {
    const me = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { notificationPrefs: true },
    });
    return (me?.notificationPrefs ?? null) as NotificationPrefs | null;
  }),

  // IMP-AUTH-04: persist the caller's own per-category × per-channel opt-outs.
  // Stored sparsely; notify() reads this and skips opted-out channels.
  updateNotificationPrefs: protectedProcedure
    .input(notificationPrefsSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { notificationPrefs: input as Prisma.InputJsonValue },
      });
      return { success: true };
    }),

  adminUpdateMember: adminProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        role: z.enum(['ADMIN', 'HR', 'EMPLOYEE']).optional(),
        department: z
          .string()
          .trim()
          .min(2)
          .max(80)
          .regex(/^[A-Z0-9_]+$/)
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
      if (input.department) {
        const department = await ctx.db.organizationDepartment.findFirst({
          where: { key: input.department, active: true },
          select: { id: true },
        });
        if (!department)
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid department.' });
      }
      const auditFields = [
        'name',
        'email',
        'role',
        'department',
        'title',
        'phone',
        'bio',
        'skills',
        'status',
      ] as const;
      const demoting = input.role !== undefined && input.role !== 'ADMIN';
      const deactivating = input.status !== undefined && input.status !== 'ACTIVE';
      const organizationId = workspaceId(ctx);
      // Coordinate promotions/reactivations as well as removals. Read the
      // target only after locking so a stale role/status cannot skip the guard.
      const rosterChange = input.role !== undefined || input.status !== undefined;
      const { before, updated } = await withAdminRosterLock(
        ctx.db,
        organizationId,
        rosterChange,
        async (tx) => {
          const before = await tx.user.findUnique({
            where: { id },
            select: Object.fromEntries(auditFields.map((f) => [f, true])) as Record<
              (typeof auditFields)[number],
              true
            >,
          });
          if (
            before?.role === 'ADMIN' &&
            before.status === 'ACTIVE' &&
            (demoting || deactivating)
          ) {
            const activeAdmins = await tx.user.count({
              where: { organizationId, role: 'ADMIN', status: 'ACTIVE' },
            });
            if (activeAdmins <= 1) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'Cannot demote or deactivate the last active admin.',
              });
            }
          }
          // Return only the member profile needed by callers. Prisma returns every
          // scalar column when `select` is omitted, which would expose credential
          // and session fields (including the bcrypt password hash) over tRPC.
          const updated = await tx.user.update({
            where: { id },
            data,
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
            },
          });
          return { before, updated };
        }
      );
      annotateAudit(ctx, {
        targetType: 'User',
        targetId: id,
        targetLabel: updated.name,
        description: `Updated team member ${updated.name}`,
        changes:
          diffChanges(
            before as Record<string, unknown> | null,
            updated as unknown as Record<string, unknown>,
            [...auditFields]
          ) ?? undefined,
      });
      return updated;
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
      // AUTH-01: an admin reset must also revoke the member's existing sessions.
      const user = await ctx.db.user.update({
        where: { id: input.id },
        data: {
          password: hashed,
          passwordChangedAt: null,
          mustChangePassword: true,
          tokenVersion: { increment: 1 },
        },
        select: { name: true },
      });
      // The new password is redacted by the audit layer; record only that a
      // reset happened, by whom, and for whom.
      annotateAudit(ctx, {
        targetType: 'User',
        targetId: input.id,
        targetLabel: user.name,
        description: `Reset password for ${user.name}`,
        metadata: { passwordReset: true },
      });
      return { success: true };
    }),

  // Lay off (terminate) a team member. Soft-delete: the row is kept (status →
  // INACTIVE) so audit history and FK integrity survive. Captures a mandatory
  // reason, records it in the audit trail, and emails the member a notice.
  layOffMember: hrProcedure
    .input(z.object({ id: z.string(), reason: z.string().min(3).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      if (input.id === ctx.session.user.id) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot lay off yourself' });
      }
      const reason = input.reason.trim();
      // AUTH-01: revoke the laid-off member's live sessions immediately (the
      // status flip already blocks new auth; bumping tokenVersion cuts off any
      // already-issued JWT on its next revalidation rather than at token expiry).
      const organizationId = workspaceId(ctx);
      const { before, updated } = await withAdminRosterLock(
        ctx.db,
        organizationId,
        true,
        async (tx) => {
          const before = await tx.user.findUnique({
            where: { id: input.id },
            select: { status: true, name: true, email: true, role: true },
          });
          if (!before) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found' });
          }
          // Check the current role under the same lock as role changes: HR may
          // lay off non-admins only, including after a concurrent promotion.
          const subject = subjectFromSession(ctx.session.user);
          if (
            !(await can(
              subject,
              'team:layoff',
              { type: 'User', targetRole: before.role },
              { source: 'TRPC', db: tx }
            ))
          ) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'You do not have permission to lay off this member.',
            });
          }
          if (before.role === 'ADMIN' && before.status === 'ACTIVE') {
            const activeAdmins = await tx.user.count({
              where: { organizationId, role: 'ADMIN', status: 'ACTIVE' },
            });
            if (activeAdmins <= 1) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'You cannot lay off the last active admin',
              });
            }
          }
          const updated = await tx.user.update({
            where: { id: input.id },
            data: { status: 'INACTIVE', tokenVersion: { increment: 1 } },
          });
          return { before, updated };
        }
      );
      annotateAudit(ctx, {
        targetType: 'User',
        targetId: input.id,
        targetLabel: updated.name,
        description: `Laid off ${updated.name}`,
        changes: { status: { before: before.status ?? null, after: 'INACTIVE' } },
        metadata: { laidOff: true, reason },
      });

      // Best-effort notice — never fail the mutation if email delivery hiccups.
      try {
        const mail = templates.accountDeactivated({
          name: updated.name,
          byName: ctx.session.user.name ?? undefined,
          reason,
        });
        await sendEmail({
          to: { email: before.email, name: updated.name },
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
      } catch (err) {
        console.error('[layOffMember] notice email failed for', before.email, err);
      }

      return updated;
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
      await assertInOrganization(ctx.db.user, workspaceId(ctx), [input.userId]);
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
  getHrOverview: hrProcedure.query(async ({ ctx }) => {
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
