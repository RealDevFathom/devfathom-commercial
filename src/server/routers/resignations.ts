import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, hrProcedure, capabilityProcedure } from '../trpc';
import { refuseSupportSession } from '@/lib/tenancy/support-session-rule';
import { can, subjectFromSession } from '@/lib/abac';
import { annotateAudit } from '../audit';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { guardPharmacyAccessChanges } from '@/lib/team/pharmacy-access-guard';
import { rethrowAccessChange } from '@/lib/team/member-sub-role-edit';
import { appUrl, templates } from '@/lib/email';
import { notify } from '@/lib/notifications';

// Display-ready date label for emails (e.g. "June 30, 2026").
const dateLabel = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

export const resignationsRouter = router({
  // The current user's own resignations, newest first.
  mine: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.resignation.findMany({
      where: { userId: ctx.session.user.id },
      select: {
        id: true,
        reason: true,
        proposedLastDay: true,
        status: true,
        reviewNote: true,
        lastWorkingDay: true,
        reviewedAt: true,
        createdAt: true,
        reviewedBy: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }),

  // Submit a resignation. One pending request at a time; on success, HR + admins
  // are notified (in-app + email). Notification/email failures are best-effort
  // and never roll back the created resignation.
  submit: capabilityProcedure('resignation:request')
    .input(
      z.object({
        reason: z.string().min(10).max(2000),
        proposedLastDay: z.date(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existingPending = await ctx.db.resignation.findFirst({
        where: { userId: ctx.session.user.id, status: 'PENDING' },
        select: { id: true },
      });
      if (existingPending) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'You already have a pending resignation.',
        });
      }

      const resignation = await ctx.db.resignation.create({
        data: {
          userId: ctx.session.user.id,
          reason: input.reason,
          proposedLastDay: input.proposedLastDay,
        },
      });

      // Best-effort: alert the people who can review it. Never fail the mutation
      // if reviewer lookup / notification dispatch hiccups — the resignation is
      // already recorded.
      try {
        const reviewers = await ctx.db.user.findMany({
          where: {
            role: { in: ['ADMIN', 'HR'] },
            status: { not: 'INACTIVE' },
            id: { not: ctx.session.user.id },
          },
          select: { id: true },
        });
        const employeeName = ctx.session.user.name ?? 'A team member';
        const proposedLastDayLabel = dateLabel(resignation.proposedLastDay);
        notify(
          ctx.db,
          reviewers.map((r) => r.id),
          {
            type: 'resignation_submitted',
            title: 'Resignation submitted',
            message: `${employeeName} submitted a resignation (proposed last day ${proposedLastDayLabel}).`,
            entityType: 'Resignation',
            entityId: resignation.id,
            email: () =>
              templates.resignationSubmitted({
                employeeName,
                reason: resignation.reason,
                proposedLastDayLabel,
                reviewUrl: `${appUrl()}/hr`,
              }),
          }
        );
      } catch (err) {
        console.error('[resignations.submit] reviewer notification failed', err);
      }

      return resignation;
    }),

  // Withdraw your own still-pending resignation.
  withdraw: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const resignation = await ctx.db.resignation.findUnique({ where: { id: input.id } });
      if (!resignation) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Resignation not found.' });
      }
      if (resignation.userId !== ctx.session.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'This is not your resignation.' });
      }
      if (resignation.status !== 'PENDING') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only a pending resignation can be withdrawn.',
        });
      }
      return ctx.db.resignation.update({
        where: { id: input.id },
        data: { status: 'WITHDRAWN' },
      });
    }),

  // Company-wide resignation queue (HR / admin), optionally filtered by status.
  listAll: capabilityProcedure('resignation:readAll')
    .input(
      z
        .object({
          status: z.enum(['PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN']).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return ctx.db.resignation.findMany({
        where: input?.status ? { status: input.status } : undefined,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              avatar: true,
              title: true,
              department: true,
              role: true,
            },
          },
          reviewedBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    }),

  // Approve or decline a resignation. Resource-level authorization (PENDING, not
  // your own, HR may not review an admin's) is enforced via the ABAC engine. Does
  // NOT deactivate the account — offboarding happens separately on the last day.
  review: hrProcedure
    .meta(refuseSupportSession)
    .input(
      z.object({
        id: z.string(),
        decision: z.enum(['APPROVED', 'DECLINED']),
        reviewNote: z.string().max(2000).optional(),
        lastWorkingDay: z.date().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const approved = input.decision === 'APPROVED';
      const organizationId = ctx.entitlements.organizationId;
      const { resignation, updated } = await ctx.db.$transaction(async (tx) => {
        // The target's role is part of the authorization decision. Lock both it
        // and the resignation before re-reading either so a concurrent promotion
        // cannot make that decision stale before the transition commits.
        // NO KEY UPDATE still blocks role changes, while allowing reviewer FK
        // key-share locks when two admins review each other's resignations.
        await tx.$queryRaw`SELECT r.id FROM "resignations" r
          JOIN "users" u ON u.id = r."userId" AND u."organizationId" = r."organizationId"
          WHERE r.id = ${input.id} AND r."organizationId" = ${organizationId}
          FOR NO KEY UPDATE OF r, u`;
        const resignation = await tx.resignation.findFirst({
          where: { id: input.id, organizationId },
          include: { user: { select: { id: true, role: true, name: true, email: true } } },
        });
        if (!resignation) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Resignation not found.' });
        }
        if (resignation.status !== 'PENDING') {
          // A concurrent reviewer can acquire the lock after the winner has
          // committed. Treat that request as a lost transition, before ABAC's
          // pending-state rule could turn the race into a permission error.
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This resignation has already been decided.',
          });
        }

        const allowed = await can(
          subjectFromSession(ctx.session.user),
          'resignation:review',
          {
            type: 'Resignation',
            userId: resignation.userId,
            status: resignation.status,
            targetRole: resignation.user.role,
          },
          { source: 'TRPC', db: tx }
        );
        if (!allowed) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have permission to review this resignation.',
          });
        }

        const transitioned = await tx.resignation.updateMany({
          where: { id: input.id, organizationId, status: 'PENDING' },
          data: {
            status: input.decision,
            reviewedById: ctx.session.user.id,
            reviewedAt: new Date(),
            reviewNote: input.reviewNote ?? null,
            lastWorkingDay: approved ? (input.lastWorkingDay ?? resignation.proposedLastDay) : null,
          },
        });
        if (transitioned.count === 0) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This resignation has already been decided.',
          });
        }

        const decided = await tx.resignation.findFirstOrThrow({
          where: { id: input.id, organizationId },
        });

        // IMP-HR-02: off-boarding automation. Keep deactivation atomic with the
        // winning decision so a failed off-boarding cannot leave a partial review.
        if (approved && decided.lastWorkingDay && decided.lastWorkingDay <= new Date()) {
          const deactivate = async () => {
            await tx.user.update({
              where: { organizationId_id: { organizationId, id: resignation.userId } },
              data: { status: 'INACTIVE' },
            });
          };
          const scoped = tx as unknown as ScopedDb;
          if (ctx.entitlements.vertical !== 'PHARMACY') await deactivate();
          else {
            // DEV-959B: in a pharmacy, off-boarding passes the access guard, so it never
            // leaves the pharmacy without an active owner; the audit shares this transaction.
            try {
              await guardPharmacyAccessChanges(
                scoped,
                {
                  organizationId,
                  actor: { kind: 'system', source: 'RESIGNATION' },
                  targetIds: [resignation.userId],
                  pinVerified: false,
                  mode: 'role',
                  action: 'resignations.decide',
                  describe: (person) => `Resignation approval deactivated ${person}`,
                },
                async () => {
                  await deactivate();
                  return { targetIds: [resignation.userId], value: null };
                }
              );
            } catch (error) {
              rethrowAccessChange(error);
            }
          }
        }

        return { resignation, updated: decided };
      });

      annotateAudit(ctx, {
        targetType: 'Resignation',
        targetId: updated.id,
        targetLabel: resignation.user.name,
        description: `${approved ? 'Approved' : 'Declined'} resignation for ${resignation.user.name}`,
        changes: { status: { before: resignation.status, after: input.decision } },
      });

      // Best-effort: let the employee know the outcome (in-app + email).
      try {
        notify(ctx.db, [resignation.userId], {
          type: 'resignation_status',
          title: `Resignation ${approved ? 'approved' : 'declined'}`,
          message: `Your resignation has been ${approved ? 'approved' : 'declined'}.`,
          entityType: 'Resignation',
          entityId: updated.id,
          email: (r) =>
            templates.resignationDecision({
              recipientName: r.name,
              decision: input.decision,
              lastWorkingDayLabel: updated.lastWorkingDay
                ? dateLabel(updated.lastWorkingDay)
                : undefined,
              reviewNote: updated.reviewNote ?? undefined,
              url: appUrl(),
            }),
        });
      } catch (err) {
        console.error('[resignations.review] decision notification failed', err);
      }

      return updated;
    }),
});
