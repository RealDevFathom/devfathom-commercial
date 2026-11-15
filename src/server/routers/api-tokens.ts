import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, adminProcedure, entitlementIndependentAdminProcedure } from '../trpc';
import { generateApiToken } from '@/lib/api-auth';
import { ACTIVE_STATUSES } from '@/lib/abac';
import { annotateAudit } from '../audit';

/**
 * DEV-848: the columns an admin screen may see. `tokenHash` stays on the server, so a
 * response can never hand a verifier for the bearer token to the browser.
 */
const API_TOKEN_FIELDS = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  userId: true,
  lastUsedAt: true,
  expiresAt: true,
  createdAt: true,
} as const;

export const apiTokensRouter = router({
  list: entitlementIndependentAdminProcedure.query(async ({ ctx }) => {
    return ctx.db.apiToken.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        ...API_TOKEN_FIELDS,
        user: { select: { id: true, name: true, email: true, avatar: true, role: true } },
      },
    });
  }),

  // IMP-REST-01: per-token usage metrics. Every /api/v1 request stamps
  // AuditLog.tokenId (recordRestAudit), so request counts, success/failure split,
  // last-used and recent (7-day) volume are derivable without a dedicated
  // counter. Returns a map keyed by tokenId for the token list to render inline.
  usage: entitlementIndependentAdminProcedure.query(async ({ ctx }) => {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [byOutcome, recent] = await Promise.all([
      ctx.db.auditLog.groupBy({
        by: ['tokenId', 'outcome'],
        _count: { _all: true },
        _max: { createdAt: true },
        where: { source: 'REST_API', tokenId: { not: null } },
      }),
      ctx.db.auditLog.groupBy({
        by: ['tokenId'],
        _count: { _all: true },
        where: { source: 'REST_API', tokenId: { not: null }, createdAt: { gte: since7d } },
      }),
    ]);

    const recentMap = new Map<string, number>();
    for (const r of recent) if (r.tokenId) recentMap.set(r.tokenId, r._count._all);

    const stats: Record<
      string,
      { total: number; success: number; failure: number; last7d: number; lastUsedAt: string | null }
    > = {};
    for (const row of byOutcome) {
      const id = row.tokenId!;
      const s =
        stats[id] ??
        (stats[id] = {
          total: 0,
          success: 0,
          failure: 0,
          last7d: recentMap.get(id) ?? 0,
          lastUsedAt: null,
        });
      s.total += row._count._all;
      if (row.outcome === 'SUCCESS') s.success += row._count._all;
      else if (row.outcome === 'FAILURE') s.failure += row._count._all;
      const last = row._max.createdAt;
      if (last && (!s.lastUsedAt || last > new Date(s.lastUsedAt)))
        s.lastUsedAt = last.toISOString();
    }
    return stats;
  }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        scopes: z.array(z.string()).min(1),
        expiresInDays: z.number().int().positive().optional(),
        // When set, the token acts on behalf of THIS user. All REST calls made
        // with this token will be attributed to them in activity logs / stats.
        // When omitted, defaults to the caller — preserves the old behavior.
        userId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Determine the user the token will act as
      const targetUserId = input.userId ?? ctx.session.user.id;

      // If binding to a different user, verify they exist and are active
      if (input.userId && input.userId !== ctx.session.user.id) {
        const targetUser = await ctx.db.user.findUnique({
          where: { id: input.userId },
          select: { id: true, status: true },
        });
        if (!targetUser) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Target user not found.' });
        }
        if (!ACTIVE_STATUSES.has(targetUser.status)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot issue a token for an inactive user.',
          });
        }
      }

      const { token, prefix, hash } = await generateApiToken();

      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : null;

      const created = await ctx.db.apiToken.create({
        data: {
          name: input.name,
          prefix,
          tokenHash: hash,
          scopes: input.scopes,
          userId: targetUserId,
          expiresAt,
        },
        select: { ...API_TOKEN_FIELDS, user: { select: { id: true, name: true } } },
      });

      annotateAudit(ctx, {
        targetType: 'ApiToken',
        targetId: created.id,
        targetLabel: created.name,
        description: `Created API token "${created.name}" (${created.prefix}…)`,
        metadata: {
          scopes: input.scopes,
          prefix: created.prefix,
          boundUserId: targetUserId,
          expiresAt,
        },
      });

      // Return the full token ONLY once — user must save it
      return {
        id: created.id,
        token,
        name: created.name,
        prefix: created.prefix,
        scopes: created.scopes,
        expiresAt: created.expiresAt,
        boundUser: created.user,
      };
    }),

  revoke: entitlementIndependentAdminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await ctx.db.apiToken.delete({
        where: { id: input.id },
        select: API_TOKEN_FIELDS,
      });
      annotateAudit(ctx, {
        targetType: 'ApiToken',
        targetId: deleted.id,
        targetLabel: deleted.name,
        description: `Revoked API token "${deleted.name}" (${deleted.prefix}…)`,
        metadata: { prefix: deleted.prefix, scopes: deleted.scopes },
      });
      return deleted;
    }),
});
