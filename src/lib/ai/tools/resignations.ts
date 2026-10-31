/**
 * Assistant tools for RESIGNATIONS — the self-service "I quit" flow and the
 * HR/admin review queue. Every tool here is a second front-end to the SAME
 * mutations in `src/server/routers/resignations.ts`: identical input
 * validation, the identical ABAC gate (`h.can`), identical business rules
 * (one pending request at a time; owner-only withdraw; HR may not review an
 * admin; approval records the last working day but does NOT deactivate the
 * account), and identical side effects (notify HR+admins on submit, notify the
 * employee on a decision, audit the action).
 */
import { tool } from 'ai';
import { z } from 'zod';
import { appUrl, templates } from '@/lib/email';
import type { AssistantHelpers, ToolSet } from '@/lib/ai/context';

// Display-ready date label for emails (e.g. "June 30, 2026"). Mirrors the
// helper used by the resignations router so emails read identically.
const dateLabel = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

export function buildResignationsTools(h: AssistantHelpers): ToolSet {
  const tools: ToolSet = {};

  // ────────────────────────────────── READS ─────────────────────────────────

  // Mirror of resignations.mine — the current user's own resignation(s).
  tools.getMyResignation = tool({
    description:
      'Show the CURRENT user (your) own resignation and where it stands: PENDING review, APPROVED, DECLINED or WITHDRAWN, plus the stated reason, your proposed last day, any confirmed last working day, and the reviewer\'s note. Use for "did my resignation go through", "what\'s the status of my notice", "my resignation".',
    inputSchema: z.object({}),
    execute: async () => {
      const rows = await h.db.resignation.findMany({
        where: { userId: h.ctx.userId },
        select: {
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
      if (rows.length === 0) {
        return { resignations: [], note: 'You have no resignation on file.' };
      }
      return {
        resignations: rows.map((r) => ({
          status: r.status,
          reason: r.reason,
          proposedLastDay: r.proposedLastDay,
          lastWorkingDay: r.lastWorkingDay,
          reviewNote: r.reviewNote,
          reviewedBy: r.reviewedBy?.name ?? null,
          reviewedAt: r.reviewedAt,
          submittedAt: r.createdAt,
        })),
      };
    },
  });

  // Mirror of resignations.listAll — the company-wide queue (HR / admin only).
  if (h.isAdminOrHr) {
    tools.listResignations = tool({
      description:
        'List the company-wide resignation queue — who has resigned, their proposed last day, the status, and who reviewed it. Optionally filter by status. Use for "pending resignations", "who is leaving", "resignations awaiting review". HR / admin only.',
      inputSchema: z.object({
        status: z
          .enum(['PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN'])
          .nullish()
          .describe('Optional status filter; omit for all resignations'),
      }),
      execute: async ({ status }) => {
        if (!h.isAdminOrHr || !(await h.can('resignation:readAll'))) {
          return { error: 'Resignations are restricted to HR and administrators.' };
        }
        const rows = await h.db.resignation.findMany({
          where: status ? { status } : undefined,
          include: {
            user: { select: { name: true, title: true, department: true, role: true } },
            reviewedBy: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
        });
        return {
          count: rows.length,
          resignations: rows.map((r) => ({
            person: r.user.name,
            title: r.user.title,
            department: r.user.department,
            status: r.status,
            reason: r.reason,
            proposedLastDay: r.proposedLastDay,
            lastWorkingDay: r.lastWorkingDay,
            reviewedBy: r.reviewedBy?.name ?? null,
            reviewNote: r.reviewNote,
            submittedAt: r.createdAt,
          })),
        };
      },
    });
  }

  // ────────────────────────────────── WRITES ────────────────────────────────

  // Mirror of resignations.submit — file the current user's resignation and
  // alert HR + admins. One pending request at a time.
  tools.submitResignation = tool({
    description:
      'Submit a resignation for the CURRENT user (you): records your reason and proposed last day, then notifies HR and the admins to review it. You can only have one pending resignation at a time. Use for "I want to resign", "submit my resignation", "hand in my notice".',
    inputSchema: z.object({
      reason: z
        .string()
        .min(10)
        .max(2000)
        .describe('Why you are resigning (at least 10 characters)'),
      proposedLastDay: z
        .string()
        .describe('Your proposed last working day as an ISO date, e.g. "2026-07-31"'),
    }),
    needsApproval: true,
    execute: async ({ reason, proposedLastDay }) => {
      if (!(await h.can('resignation:request'))) {
        return { error: 'You are not able to submit a resignation.' };
      }
      const lastDay = new Date(proposedLastDay);
      if (Number.isNaN(lastDay.getTime())) {
        return {
          error: `"${proposedLastDay}" is not a valid date. Use an ISO date like "2026-07-31".`,
        };
      }

      const existingPending = await h.db.resignation.findFirst({
        where: { userId: h.ctx.userId, status: 'PENDING' },
        select: { id: true },
      });
      if (existingPending) {
        return { error: 'You already have a pending resignation.' };
      }

      const resignation = await h.db.resignation.create({
        data: { userId: h.ctx.userId, reason, proposedLastDay: lastDay },
      });

      // Best-effort: alert the people who can review it (in-app + email). Never
      // fail the action if reviewer lookup / dispatch hiccups — the resignation
      // is already recorded.
      try {
        const reviewers = await h.db.user.findMany({
          where: {
            role: { in: ['ADMIN', 'HR'] },
            status: { not: 'INACTIVE' },
            id: { not: h.ctx.userId },
          },
          select: { id: true },
        });
        const employeeName = h.ctx.name ?? 'A team member';
        const proposedLastDayLabel = dateLabel(resignation.proposedLastDay);
        h.notifyUsers(
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
        console.error('[assistant submitResignation] reviewer notification failed', err);
      }

      h.audit({
        category: 'RESIGNATIONS',
        action: 'resignations.submit',
        operation: 'CREATE',
        description: 'Submitted a resignation',
        targetType: 'Resignation',
        targetId: resignation.id,
        targetLabel: h.ctx.name ?? undefined,
      });

      return {
        status: resignation.status,
        reason: resignation.reason,
        proposedLastDay: resignation.proposedLastDay,
        message: 'Your resignation was submitted; HR and the admins have been notified.',
      };
    },
  });

  // Mirror of resignations.withdraw — withdraw your OWN still-pending
  // resignation. A user can only ever have one PENDING request, so we resolve
  // it implicitly rather than surface a raw id.
  tools.withdrawResignation = tool({
    description:
      'Withdraw the CURRENT user (your) own still-pending resignation, taking it back before it has been reviewed. Only a PENDING resignation can be withdrawn. Use for "withdraw my resignation", "cancel my notice", "I changed my mind about quitting".',
    inputSchema: z.object({}),
    needsApproval: true,
    execute: async () => {
      const pending = await h.db.resignation.findFirst({
        where: { userId: h.ctx.userId, status: 'PENDING' },
        select: { id: true },
      });
      if (!pending) {
        return { error: 'You have no pending resignation to withdraw.' };
      }

      const updated = await h.db.resignation.update({
        where: { id: pending.id },
        data: { status: 'WITHDRAWN' },
      });

      h.audit({
        category: 'RESIGNATIONS',
        action: 'resignations.withdraw',
        operation: 'UPDATE',
        description: 'Withdrew a resignation',
        targetType: 'Resignation',
        targetId: updated.id,
        targetLabel: h.ctx.name ?? undefined,
        changes: { status: { before: 'PENDING', after: 'WITHDRAWN' } },
      });

      return { status: updated.status, message: 'Your resignation has been withdrawn.' };
    },
  });

  // Mirror of resignations.review — approve or decline someone's PENDING
  // resignation (HR / admin). Resource-level authz (PENDING, not your own, HR
  // may not review an admin) is enforced via the ABAC engine. Approval records
  // the last working day but does NOT deactivate the account — offboarding is
  // a separate step on the last day.
  if (h.isAdminOrHr) {
    tools.reviewResignation = tool({
      description:
        'Approve or decline a team member\'s pending resignation (HR / admin). Give the person\'s name, the decision, and — when approving — optionally their confirmed last working day (defaults to the proposed last day) and an optional note for them. The employee is emailed the outcome. This records the decision only; it does NOT deactivate the account (offboarding happens separately). Use for "approve <name>\'s resignation", "decline the resignation from <name>".',
      inputSchema: z.object({
        person: z
          .string()
          .describe('The resigning team member\'s name, e.g. "Aisha" or "Aisha Khan"'),
        decision: z.enum(['APPROVED', 'DECLINED']).describe('Approve or decline the resignation'),
        lastWorkingDay: z
          .string()
          .nullish()
          .describe(
            'When APPROVING: the confirmed last working day as an ISO date. Defaults to the proposed last day.'
          ),
        note: z.string().max(2000).nullish().describe('Optional note shared with the employee'),
      }),
      needsApproval: true,
      execute: async ({ person, decision, lastWorkingDay, note }) => {
        if (!h.isAdminOrHr) {
          return { error: 'Reviewing resignations is restricted to HR and administrators.' };
        }

        const r = await h.resolvePerson(person, { includeInactive: true });
        if (r.kind === 'notfound') return { error: `No team member matches "${person}".` };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which one — ${r.candidates.join(', ')}?` };
        const target = r.value;

        const resignation = await h.db.resignation.findFirst({
          where: { userId: target.id, status: 'PENDING' },
          include: { user: { select: { id: true, role: true, name: true } } },
        });
        if (!resignation) {
          return { error: `${target.name} has no pending resignation to review.` };
        }

        const allowed = await h.can('resignation:review', {
          type: 'Resignation',
          userId: resignation.userId,
          status: resignation.status,
          targetRole: resignation.user.role,
        });
        if (!allowed) {
          return { error: 'You do not have permission to review this resignation.' };
        }

        const approved = decision === 'APPROVED';

        // Resolve the confirmed last working day only on approval; fall back to
        // the proposed last day. Validate any provided ISO date.
        let resolvedLastDay: Date | null = null;
        if (approved) {
          if (lastWorkingDay) {
            const d = new Date(lastWorkingDay);
            if (Number.isNaN(d.getTime())) {
              return {
                error: `"${lastWorkingDay}" is not a valid date. Use an ISO date like "2026-07-31".`,
              };
            }
            resolvedLastDay = d;
          } else {
            resolvedLastDay = resignation.proposedLastDay;
          }
        }

        const updated = await h.db.resignation.update({
          where: { id: resignation.id },
          data: {
            status: decision,
            reviewedById: h.ctx.userId,
            reviewedAt: h.now(),
            reviewNote: note ?? null,
            lastWorkingDay: resolvedLastDay,
          },
        });

        h.audit({
          category: 'RESIGNATIONS',
          action: 'resignations.review',
          operation: 'UPDATE',
          description: `${approved ? 'Approved' : 'Declined'} resignation for ${resignation.user.name}`,
          targetType: 'Resignation',
          targetId: updated.id,
          targetLabel: resignation.user.name,
          changes: { status: { before: resignation.status, after: decision } },
        });

        // Best-effort: let the employee know the outcome (in-app + email).
        try {
          h.notifyUsers([resignation.userId], {
            type: 'resignation_status',
            title: `Resignation ${approved ? 'approved' : 'declined'}`,
            message: `Your resignation has been ${approved ? 'approved' : 'declined'}.`,
            entityType: 'Resignation',
            entityId: updated.id,
            email: (recipient) =>
              templates.resignationDecision({
                recipientName: recipient.name,
                decision,
                lastWorkingDayLabel: updated.lastWorkingDay
                  ? dateLabel(updated.lastWorkingDay)
                  : undefined,
                reviewNote: updated.reviewNote ?? undefined,
                url: appUrl(),
              }),
          });
        } catch (err) {
          console.error('[assistant reviewResignation] decision notification failed', err);
        }

        return {
          person: resignation.user.name,
          decision: updated.status,
          lastWorkingDay: updated.lastWorkingDay,
          note: updated.reviewNote,
          message: `${resignation.user.name}'s resignation has been ${approved ? 'approved' : 'declined'} and they have been notified.`,
        };
      },
    });
  }

  return tools;
}
