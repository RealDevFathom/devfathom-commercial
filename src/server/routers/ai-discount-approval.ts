import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { can, subjectFromSession } from '@/lib/abac';
import { readAIConfig } from '@/lib/ai/provider';
import { getTierForFeature } from '@/lib/ai/tiers';
import {
  unconfiguredDiscountScheduler,
  type DiscountSchedulerPort,
  type ScheduledDiscountDraft,
} from '@/lib/ai/shared/discount-scheduler.types';
import { annotateAudit } from '../audit';
import { auditedProtectedProcedure, router, type TRPCContext } from '../trpc';

const idInput = z.object({ id: z.string().min(1) });
const editInput = idInput.extend({
  name: z.string().trim().min(1).max(120).optional(),
  percentage: z.number().positive().max(100).optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
});

async function authorize(ctx: TRPCContext) {
  const user = ctx.session!.user;
  const orgId = ctx.organization?.id ?? user.organizationId;
  if (
    !orgId ||
    !(await can(subjectFromSession(user), 'restaurant:configure', undefined, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    }))
  )
    throw new TRPCError({ code: 'FORBIDDEN' });
  return orgId;
}

async function enabled(port: DiscountSchedulerPort, orgId: string) {
  try {
    readAIConfig();
  } catch {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'DevFathom AI is not configured.',
    });
  }
  if (!(await port.isAIEnabled(orgId)))
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'DevFathom AI is off for this organization.',
    });
}

function audit(ctx: TRPCContext, oldDraft: ScheduledDiscountDraft, next: ScheduledDiscountDraft) {
  annotateAudit(ctx, {
    category: 'RESTAURANT_GROWTH',
    targetType: 'SCHEDULED_DISCOUNT_DRAFT',
    targetId: oldDraft.id,
    changes: { draft: { before: oldDraft, after: next } },
    metadata: { aiModel: oldDraft.model, aiTier: oldDraft.tier },
  });
}

export function createAIDiscountApprovalRouter(
  port: DiscountSchedulerPort = unconfiguredDiscountScheduler
) {
  return router({
    list: auditedProtectedProcedure.query(async ({ ctx }) => {
      const orgId = await authorize(ctx);
      await enabled(port, orgId);
      return { label: 'DevFathom AI' as const, drafts: await port.listDrafts(orgId) };
    }),
    edit: auditedProtectedProcedure.input(editInput).mutation(async ({ ctx, input }) => {
      const orgId = await authorize(ctx);
      await enabled(port, orgId);
      const oldDraft = await port.getDraft(orgId, input.id);
      if (!oldDraft || oldDraft.status !== 'SCHEDULED') throw new TRPCError({ code: 'NOT_FOUND' });
      const { id: _id, ...patch } = input;
      const next = await port.updateDraft(orgId, input.id, patch);
      audit(ctx, oldDraft, next);
      return next;
    }),
    decide: auditedProtectedProcedure
      .input(idInput.extend({ decision: z.enum(['APPROVE', 'REJECT']) }))
      .mutation(async ({ ctx, input }) => {
        const orgId = await authorize(ctx);
        await enabled(port, orgId);
        const oldDraft = await port.getDraft(orgId, input.id);
        if (!oldDraft) throw new TRPCError({ code: 'NOT_FOUND' });
        const alreadyDecided =
          (input.decision === 'REJECT' && oldDraft.status === 'REJECTED') ||
          (input.decision === 'APPROVE' &&
            (oldDraft.status === 'APPROVED' || oldDraft.status === 'ACTIVE'));
        if (alreadyDecided) return oldDraft;
        if (oldDraft.status !== 'SCHEDULED') throw new TRPCError({ code: 'NOT_FOUND' });
        const now = new Date();
        let next = await port.transitionDraft(
          orgId,
          input.id,
          input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          now
        );
        if (input.decision === 'APPROVE' && now >= next.startsAt && now < next.endsAt)
          next = await port.transitionDraft(orgId, input.id, 'ACTIVE', now);
        audit(ctx, oldDraft, next);
        return next;
      }),
  });
}

export const aiDiscountApprovalRouter = createAIDiscountApprovalRouter();

// Compile-time guard: discounts are growth work and must never silently fall back to cheap.
const discountTier = getTierForFeature('growth');
if (discountTier !== 'standard')
  throw new Error('Discount approval requires the standard AI tier.');
