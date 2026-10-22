import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import { unavailableChurnScorePort, type ChurnScorePort } from '@/lib/ai/shared/churn-score.types';
import { auditedProtectedProcedure, router } from '../trpc';

export function createAIChurnRouter(port: ChurnScorePort = unavailableChurnScorePort) {
  return router({
    list: auditedProtectedProcedure
      .input(z.object({ limit: z.number().int().min(1).max(100).default(25) }).strict())
      .query(async ({ ctx, input }) => {
        const user = ctx.session.user;
        const organizationId = ctx.organization?.id ?? user.organizationId;
        if (!organizationId) throw new TRPCError({ code: 'NOT_FOUND' });

        const allowed = await can(subjectFromSession(user), 'reports:operational', undefined, {
          db: ctx.db as Prisma.TransactionClient,
          source: 'TRPC',
          ip: ctx.requestMeta.ip,
        });
        // can() is authoritative: an explicit/custom DENY must not reach the data port.
        if (!allowed) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have permission to view churn insights.',
          });
        }

        // This check stays server-side; the client cannot opt an organization into AI.
        if (!(await port.isAIConfigured(organizationId))) return { status: 'AI_OFF' as const };

        return {
          status: 'AVAILABLE' as const,
          customers: await port.listChurnRisks({ organizationId, limit: input.limit }),
        };
      }),
  });
}

export const aiChurnRouter = createAIChurnRouter();
