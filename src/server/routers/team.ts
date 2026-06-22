import { z } from 'zod';
import { hash, compare } from 'bcryptjs';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, adminProcedure, hrProcedure, capabilityProcedure } from '../trpc';
import { can, subjectFromSession } from '@/lib/abac';
import { assertNotificationOwner } from '../authz';
import { annotateAudit, diffChanges } from '../audit';
import { appUrl, templates, sendEmail } from '@/lib/email';
import { notify } from '@/lib/notifications';
import { passwordSchema } from '@/lib/password-policy';
import { generateInviteToken } from '@/lib/invite-token';

// "LEADERSHIP" → "Leadership", "ADMIN" → "Admin". Acronym roles stay upper-case.
const titleCase = (s: string) => (s === 'HR' ? 'HR' : s.charAt(0) + s.slice(1).toLowerCase());

// How long an invitation link stays valid.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const teamRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.user.findMany({
      // Permanently-deleted (anonymized) members are tombstones — never list them.
      where: { deletedAt: null },
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
  }),

  // Lightweight roster — just enough to render avatars and names.
  getRoster: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.user.findMany({
      where: { deletedAt: null },
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
        email: z.string().email(),
        role: z.enum(['ADMIN', 'HR', 'EMPLOYEE']).default('EMPLOYEE'),
        department: z.enum([
          'LEADERSHIP',
          'ENGINEERING',
          'PRODUCT',
          'QUALITY',
          'MARKETING',
          'DESIGN',
        ]),
        title: z.string().min(1),
        phone: z.string().optional(),
        bio: z.string().optional(),
        skills: z.array(z.string()).default([]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const email = input.email.toLowerCase();
      const existing = await ctx.db.user.findUnique({
        where: { email },
        select: { id: true, status: true },
      });
      // Only a still-pending invite may be re-sent; an active/real account blocks.
      if (existing && existing.status !== 'INVITED') {
        throw new TRPCError({ code: 'CONFLICT', message: 'A user with this email already exists' });
      }

      const { token, tokenHash } = generateInviteToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      const profile = {
        name: input.name,
        role: input.role,
        department: input.department,
        title: input.title,
        phone: input.phone ?? null,
        bio: input.bio ?? null,
        skills: input.skills,
      };

      const user = await ctx.db.$transaction(async (tx) => {
        // Upsert the user (re-invite refreshes the seeded details), then replace
        // any prior invitation with a fresh single-use token.
        const u = existing
          ? await tx.user.update({
              where: { id: existing.id },
              data: { ...profile, password: null, status: 'INVITED' },
            })
          : await tx.user.create({
              data: { ...profile, email, password: null, status: 'INVITED' },
            });

        await tx.invitation.upsert({
          where: { userId: u.id },
          create: {
            userId: u.id,
            email,
            tokenHash,
            invitedById: ctx.session.user.id,
            expiresAt,
          },
          update: { tokenHash, expiresAt, acceptedAt: null, invitedById: ctx.session.user.id },
        });

        return u;
      });

      const inviteUrl = `${appUrl()}/invite/${token}`;

      // Best-effort send — never fail the mutation on an email hiccup; the admin
      // still gets the inviteUrl back to share manually if delivery is unverified.
      const mail = templates.inviteMember({
        name: user.name,
        inviterName: ctx.session.user.name ?? undefined,
        role: `${titleCase(input.role)} · ${titleCase(input.department)}`,
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
    const isAdmin = ctx.session.user.role === 'ADMIN';
    const isSelf = ctx.session.user.id === input.id;

    return ctx.db.user.findUnique({
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
          include: { project: { select: { id: true, name: true, status: true, type: true } } },
        },
        assignedTasks: {
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
      z.object({
        type: z.enum(['VACATION', 'SICK', 'REMOTE']),
        startDate: z.date(),
        endDate: z.date(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.leaveRequest.create({
        data: { ...input, userId: ctx.session.user.id },
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
      const leave = await ctx.db.leaveRequest.update({
        where: { id: input.id },
        data: { status: input.status, approvedById: ctx.session.user.id },
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
      await ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { password: hashed },
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
          .enum(['LEADERSHIP', 'ENGINEERING', 'PRODUCT', 'QUALITY', 'MARKETING', 'DESIGN'])
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
      const before = await ctx.db.user.findUnique({
        where: { id },
        select: Object.fromEntries(auditFields.map((f) => [f, true])) as Record<
          (typeof auditFields)[number],
          true
        >,
      });
      const updated = await ctx.db.user.update({ where: { id }, data });
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
      const user = await ctx.db.user.update({
        where: { id: input.id },
        data: { password: hashed },
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
      const before = await ctx.db.user.findUnique({
        where: { id: input.id },
        select: { status: true, name: true, email: true, role: true, deletedAt: true },
      });
      if (!before || before.deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found' });
      }
      // ABAC: admins may lay off anyone; HR may lay off non-admins only. The
      // coarse hrProcedure gate already required ADMIN/HR; this resource-level
      // check enforces the "HR can't terminate an admin" attribute condition.
      const subject = subjectFromSession(ctx.session.user);
      if (!(await can(subject, 'team:layoff', { type: 'User', targetRole: before.role }, { source: 'TRPC' }))) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission to lay off this member.',
        });
      }
      // Never strand the workspace without an admin: if the target is the last
      // active ADMIN, block the lay-off.
      if (before.role === 'ADMIN') {
        const otherActiveAdmins = await ctx.db.user.count({
          where: { id: { not: input.id }, role: 'ADMIN', status: 'ACTIVE' },
        });
        if (otherActiveAdmins === 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'You cannot lay off the last active admin',
          });
        }
      }
      const reason = input.reason.trim();
      const updated = await ctx.db.user.update({
        where: { id: input.id },
        data: { status: 'INACTIVE' },
      });
      annotateAudit(ctx, {
        targetType: 'User',
        targetId: input.id,
        targetLabel: updated.name,
        description: `Laid off ${updated.name}`,
        changes: { status: { before: before.status ?? null, after: 'INACTIVE' } },
        metadata: { laidOff: true, reason },
      });

      // Best-effort notice — never fail the mutation if email delivery hiccups,
      // but report whether it sent so the admin gets honest feedback (e.g. if
      // BREVO_* env vars are unset, the notice silently no-ops otherwise).
      let emailSent = false;
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
        emailSent = true;
      } catch (err) {
        console.error('[layOffMember] notice email failed for', before.email, err);
      }

      return { ...updated, emailSent };
    }),

  // Permanently delete an already-laid-off member. We do NOT drop the row —
  // many tables (tasks they created, messages they sent, time/leave/perf
  // records, the audit trail) reference a User with ON DELETE RESTRICT, and an
  // agency must keep that history. Instead we anonymize: scrub all PII, pull
  // the member out of every collaborative surface (projects, channels, task
  // assignments, etc.), revoke API tokens, and stamp deletedAt. The tombstone
  // is then hidden from rosters/search and blocked from sign-in. Admin-only and
  // irreversible — gated behind a prior lay-off (status must be INACTIVE).
  deleteMember: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (input.id === ctx.session.user.id) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot delete yourself' });
      }
      const before = await ctx.db.user.findUnique({
        where: { id: input.id },
        select: { status: true, name: true, email: true, role: true, deletedAt: true },
      });
      if (!before || before.deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found' });
      }
      // Two-step gate: a member must be laid off (deactivated) before they can be
      // permanently removed. This keeps the destructive action deliberate.
      if (before.status !== 'INACTIVE') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Lay off this member before deleting them permanently.',
        });
      }

      const tombstoneEmail = `deleted+${input.id}@removed.invalid`;

      await ctx.db.$transaction([
        // Strip the member out of every collaborative / membership surface so
        // they vanish from project rosters, channels, boards, mentions, etc.
        ctx.db.projectMember.deleteMany({ where: { userId: input.id } }),
        ctx.db.taskAssignee.deleteMany({ where: { userId: input.id } }),
        ctx.db.channelMember.deleteMany({ where: { userId: input.id } }),
        ctx.db.columnDefaultAssignee.deleteMany({ where: { userId: input.id } }),
        ctx.db.messageReaction.deleteMany({ where: { userId: input.id } }),
        ctx.db.messageMention.deleteMany({ where: { userId: input.id } }),
        ctx.db.savedMessage.deleteMany({ where: { userId: input.id } }),
        ctx.db.pinnedMessage.deleteMany({ where: { pinnedById: input.id } }),
        ctx.db.meetingAttendee.deleteMany({ where: { userId: input.id } }),
        ctx.db.meetingAttendanceLog.deleteMany({ where: { userId: input.id } }),
        ctx.db.noteShare.deleteMany({ where: { userId: input.id } }),
        // Personal / actionable rows that only matter while the account is live.
        ctx.db.apiToken.deleteMany({ where: { userId: input.id } }),
        ctx.db.notification.deleteMany({ where: { userId: input.id } }),
        ctx.db.activity.deleteMany({ where: { userId: input.id } }),
        // Anonymize the surviving row. Authored content (tasks, messages, files,
        // audit entries) now attributes to "Former Employee". email must stay
        // unique + non-null, so a per-id tombstone address is used.
        ctx.db.user.update({
          where: { id: input.id },
          data: {
            name: 'Former Employee',
            title: 'Former Employee',
            email: tombstoneEmail,
            password: null,
            avatar: null,
            phone: null,
            bio: null,
            skills: [],
            lastActiveAt: null,
            deletedAt: new Date(),
          },
        }),
      ]);

      annotateAudit(ctx, {
        targetType: 'User',
        targetId: input.id,
        targetLabel: before.name,
        description: `Permanently deleted (anonymized) ${before.name}`,
        changes: { deletedAt: { before: null, after: 'now' } },
        metadata: { permanentlyDeleted: true, previousEmail: before.email },
      });

      return { success: true };
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
