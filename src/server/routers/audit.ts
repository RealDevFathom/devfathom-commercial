import { z } from 'zod';
import { router, adminProcedure } from '../trpc';
import type { Prisma } from '@/generated/prisma/client';

/**
 * Admin-only read API over the audit trail. Every procedure here is an
 * `adminProcedure`, so a non-admin gets FORBIDDEN. These reads are themselves
 * excluded from the audit log (isAuditExcludedPath) to avoid recursion noise.
 */

const operationEnum = z.enum([
  'CREATE',
  'READ',
  'UPDATE',
  'DELETE',
  'LOGIN',
  'LOGOUT',
  'LOGIN_FAILED',
  'EXECUTE',
  'OTHER',
]);
const sourceEnum = z.enum(['TRPC', 'REST_API', 'AUTH', 'SYSTEM']);
const outcomeEnum = z.enum(['SUCCESS', 'FAILURE']);
const actorTypeEnum = z.enum(['USER', 'API_TOKEN', 'ANONYMOUS', 'SYSTEM']);

export const auditRouter = router({
  /**
   * Paginated, filtered list of audit entries (newest first). Cursor is the
   * last row's id; ordering is by (createdAt desc, id desc) for stability.
   */
  list: adminProcedure
    .input(
      z.object({
        search: z.string().trim().optional(),
        actorId: z.string().optional(),
        actorType: actorTypeEnum.optional(),
        category: z.string().optional(),
        operation: operationEnum.optional(),
        source: sourceEnum.optional(),
        outcome: outcomeEnum.optional(),
        action: z.string().optional(),
        // IMP-AI-02: surface AI-assistant-originated writes as a first-class
        // view. When true, restrict to rows whose action is `assistant.*`.
        assistantOnly: z.boolean().optional(),
        targetType: z.string().optional(),
        targetId: z.string().optional(),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
        limit: z.number().min(1).max(200).default(50),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const where: Prisma.AuditLogWhereInput = {};

      if (input.actorId) where.actorId = input.actorId;
      if (input.actorType) where.actorType = input.actorType;
      if (input.category) where.category = input.category;
      if (input.operation) where.operation = input.operation;
      if (input.source) where.source = input.source;
      if (input.outcome) where.outcome = input.outcome;
      // assistantOnly takes precedence over an exact action filter: it surfaces
      // every AI-assistant-originated write (recorded by the assistant as
      // `assistant.*`, source=SYSTEM, metadata.via='assistant').
      if (input.assistantOnly) {
        where.action = { startsWith: 'assistant.' };
      } else if (input.action) {
        where.action = input.action;
      }
      if (input.targetType) where.targetType = input.targetType;
      if (input.targetId) where.targetId = input.targetId;

      if (input.startDate || input.endDate) {
        where.createdAt = {
          ...(input.startDate && { gte: input.startDate }),
          ...(input.endDate && { lte: input.endDate }),
        };
      }

      if (input.search) {
        const q = input.search;
        where.OR = [
          { actorName: { contains: q, mode: 'insensitive' } },
          { actorEmail: { contains: q, mode: 'insensitive' } },
          { action: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { targetLabel: { contains: q, mode: 'insensitive' } },
          { targetId: { contains: q, mode: 'insensitive' } },
          { tokenName: { contains: q, mode: 'insensitive' } },
          { ip: { contains: q, mode: 'insensitive' } },
          { path: { contains: q, mode: 'insensitive' } },
          { errorMessage: { contains: q, mode: 'insensitive' } },
        ];
      }

      const rows = await ctx.db.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      let nextCursor: string | undefined;
      if (rows.length > input.limit) {
        const next = rows.pop();
        nextCursor = next?.id;
      }

      return { items: rows, nextCursor };
    }),

  /** Distinct values + actor list to populate the filter controls. */
  filters: adminProcedure.query(async ({ ctx }) => {
    const [categories, actions, actorRows] = await Promise.all([
      ctx.db.auditLog.findMany({
        distinct: ['category'],
        select: { category: true },
        orderBy: { category: 'asc' },
      }),
      ctx.db.auditLog.findMany({
        distinct: ['action'],
        select: { action: true },
        orderBy: { action: 'asc' },
        take: 500,
      }),
      ctx.db.auditLog.groupBy({
        by: ['actorId', 'actorName'],
        where: { actorId: { not: null } },
        _count: { _all: true },
      }),
    ]);

    // Collapse to one entry per actorId (keep the highest-count snapshot name).
    const actorMap = new Map<string, { id: string; name: string | null; count: number }>();
    for (const r of actorRows) {
      if (!r.actorId) continue;
      const existing = actorMap.get(r.actorId);
      const count = r._count._all;
      if (!existing || count > existing.count) {
        actorMap.set(r.actorId, { id: r.actorId, name: r.actorName, count });
      } else {
        existing.count += count;
      }
    }
    const actors = [...actorMap.values()].sort((a, b) => b.count - a.count);

    return {
      categories: categories.map((c) => c.category),
      actions: actions.map((a) => a.action),
      actors,
      operations: operationEnum.options,
      sources: sourceEnum.options,
      outcomes: outcomeEnum.options,
    };
  }),

  /** Headline counters for the dashboard strip on the audit page. */
  stats: adminProcedure.query(async ({ ctx }) => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [total, failures, last24h, failures24h, byCategoryRaw, topActorsRaw] = await Promise.all([
      ctx.db.auditLog.count(),
      ctx.db.auditLog.count({ where: { outcome: 'FAILURE' } }),
      ctx.db.auditLog.count({ where: { createdAt: { gte: since24h } } }),
      ctx.db.auditLog.count({ where: { outcome: 'FAILURE', createdAt: { gte: since24h } } }),
      ctx.db.auditLog.groupBy({ by: ['category'], _count: { _all: true } }),
      ctx.db.auditLog.groupBy({
        by: ['actorId', 'actorName'],
        where: { createdAt: { gte: since24h }, actorId: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const byCategory = byCategoryRaw
      .map((c) => ({ category: c.category, count: c._count._all }))
      .sort((a, b) => b.count - a.count);

    const topActors = topActorsRaw
      .map((a) => ({ id: a.actorId, name: a.actorName, count: a._count._all }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return { total, failures, last24h, failures24h, byCategory, topActors };
  }),
});
