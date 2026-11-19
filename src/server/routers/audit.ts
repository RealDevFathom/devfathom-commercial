import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, adminProcedure, type TRPCContext } from '../trpc';
import { Prisma } from '@/generated/prisma/client';
import { auditApproverIds, auditRowBranchId } from '@/lib/audit-labels';
import { auditActorBranches } from '@/server/audit-actor-branches';

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

/**
 * DEV-913: whose entries this administrator may read. Outside a pharmacy, and
 * for the pharmacy owner (the live system Owner, or an ADMIN holding `*` with
 * no DENY), every entry. Any other pharmacy administrator reads only the entries
 * recorded at a branch they are actively assigned to; workspace-wide entries
 * and other branches stay hidden. Decided from the database, never the session.
 */
type AuditReadScope = { kind: 'ALL' } | { kind: 'BRANCHES'; branchIds: string[] };

async function auditReadScope(ctx: TRPCContext): Promise<AuditReadScope> {
  if (ctx.entitlements?.vertical !== 'PHARMACY') return { kind: 'ALL' };
  const userId = ctx.session?.user?.id;
  if (!userId) return { kind: 'BRANCHES', branchIds: [] };
  const actor = await auditActorBranches(ctx.db, ctx.entitlements.organizationId, userId);
  return actor.all ? { kind: 'ALL' } : { kind: 'BRANCHES', branchIds: actor.branchIds };
}

/**
 * Rows recorded at one of `branchIds`: the recorded branch, the branches the
 * person works at for an entry recorded away from the branch it named
 * (DEV-937), then the raw request of an entry that recorded no branch at all
 * (written before the recorder kept one). A raw request branch is only what the
 * person named, so it never places a refusal, an entry the recorder moved away
 * from it (`requestedBranchId`), or an entry recorded at another branch.
 */
function atBranches(branchIds: readonly string[]): Prisma.AuditLogWhereInput {
  if (branchIds.length === 0) return { id: { in: [] } };
  const unrecorded: Prisma.AuditLogWhereInput = {
    AND: [
      { outcome: 'SUCCESS' },
      { metadata: { path: ['branchId'], equals: Prisma.AnyNull } },
      { metadata: { path: ['requestedBranchId'], equals: Prisma.AnyNull } },
    ],
  };
  return {
    OR: branchIds.flatMap((branchId): Prisma.AuditLogWhereInput[] => [
      { metadata: { path: ['branchId'], equals: branchId } },
      { metadata: { path: ['actorBranchIds'], array_contains: [branchId] } },
      { AND: [unrecorded, { input: { path: ['branchId'], equals: branchId } }] },
      { AND: [unrecorded, { input: { path: ['pharmacyBranchId'], equals: branchId } }] },
    ]),
  };
}

function scopeWhere(scope: AuditReadScope): Prisma.AuditLogWhereInput | null {
  return scope.kind === 'ALL' ? null : atBranches(scope.branchIds);
}

function withScope(
  where: Prisma.AuditLogWhereInput,
  scope: AuditReadScope
): Prisma.AuditLogWhereInput {
  const restriction = scopeWhere(scope);
  return restriction ? { AND: [where, restriction] } : where;
}

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
        // DEV-913: entries recorded at one pharmacy branch.
        branchId: z.string().trim().min(1).max(64).optional(),
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
      const scope = await auditReadScope(ctx);
      if (input.branchId && scope.kind === 'BRANCHES' && !scope.branchIds.includes(input.branchId))
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
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

      const conditions: Prisma.AuditLogWhereInput[] = [where];
      if (input.branchId) conditions.push(atBranches([input.branchId]));
      const restriction = scopeWhere(scope);
      if (restriction) conditions.push(restriction);

      const rows = await ctx.db.auditLog.findMany({
        where: conditions.length === 1 ? where : { AND: conditions },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      // The `limit + 1`st row is a has-more probe only: it is never part of the
      // page, and it is never the cursor. The cursor is the LAST ROW WE RETURN,
      // which is what the docstring above promises and what `skip: 1` requires —
      // Prisma's cursor is INCLUSIVE, so the next call re-selects that row and
      // steps past it.
      //
      // #42: handing back the popped probe instead named a row the caller had
      // NOT been given, and `skip: 1` then discarded it — losing exactly one row
      // at every page boundary.
      let nextCursor: string | undefined;
      if (rows.length > input.limit) {
        rows.pop();
        nextCursor = rows[rows.length - 1]?.id;
      }

      return { items: await describeRows(ctx, rows), nextCursor };
    }),

  /** Distinct values + actor list to populate the filter controls. */
  filters: adminProcedure.query(async ({ ctx }) => {
    const scope = await auditReadScope(ctx);
    const scoped = scopeWhere(scope) ?? {};
    const [categories, actions, actorRows, branches] = await Promise.all([
      ctx.db.auditLog.findMany({
        where: scoped,
        distinct: ['category'],
        select: { category: true },
        orderBy: { category: 'asc' },
      }),
      ctx.db.auditLog.findMany({
        where: scoped,
        distinct: ['action'],
        select: { action: true },
        orderBy: { action: 'asc' },
        take: 500,
      }),
      ctx.db.auditLog.groupBy({
        by: ['actorId', 'actorName'],
        where: withScope({ actorId: { not: null } }, scope),
        _count: { _all: true },
      }),
      ctx.entitlements?.vertical === 'PHARMACY'
        ? ctx.db.pharmacyBranch.findMany({
            where: {
              organizationId: ctx.entitlements.organizationId,
              ...(scope.kind === 'BRANCHES' ? { id: { in: scope.branchIds } } : {}),
            },
            select: { id: true, name: true, code: true },
            orderBy: { name: 'asc' },
          })
        : Promise.resolve([]),
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
      branches,
      operations: operationEnum.options,
      sources: sourceEnum.options,
      outcomes: outcomeEnum.options,
    };
  }),

  /** Headline counters for the dashboard strip on the audit page. */
  stats: adminProcedure.query(async ({ ctx }) => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const scope = await auditReadScope(ctx);
    const scoped = (where: Prisma.AuditLogWhereInput) => withScope(where, scope);

    const [total, failures, last24h, failures24h, byCategoryRaw, topActorsRaw] = await Promise.all([
      ctx.db.auditLog.count({ where: scoped({}) }),
      ctx.db.auditLog.count({ where: scoped({ outcome: 'FAILURE' }) }),
      ctx.db.auditLog.count({ where: scoped({ createdAt: { gte: since24h } }) }),
      ctx.db.auditLog.count({
        where: scoped({ outcome: 'FAILURE', createdAt: { gte: since24h } }),
      }),
      ctx.db.auditLog.groupBy({ by: ['category'], where: scoped({}), _count: { _all: true } }),
      ctx.db.auditLog.groupBy({
        by: ['actorId', 'actorName'],
        where: scoped({ createdAt: { gte: since24h }, actorId: { not: null } }),
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

type AuditRow = Prisma.AuditLogGetPayload<object>;

/**
 * DEV-913: each entry with the branch it was recorded at and the people who
 * approved it, by name. Names are read for this page only; the stored row is
 * never changed (audit rows are append-only).
 */
async function describeRows(ctx: TRPCContext, rows: AuditRow[]) {
  const branchIds = [...new Set(rows.map(auditRowBranchId).filter((id): id is string => !!id))];
  const approverIds = [...new Set(rows.flatMap(auditApproverIds))];
  const organizationId = ctx.entitlements?.organizationId;
  const [branches, approvers] = await Promise.all([
    branchIds.length && ctx.entitlements?.vertical === 'PHARMACY'
      ? ctx.db.pharmacyBranch.findMany({
          where: { organizationId, id: { in: branchIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([] as { id: string; name: string }[]),
    approverIds.length
      ? ctx.db.user.findMany({
          where: { organizationId, id: { in: approverIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  const branchName = new Map(branches.map((branch) => [branch.id, branch.name]));
  const approverName = new Map(approvers.map((user) => [user.id, user.name]));
  return rows.map((row) => {
    const branchId = auditRowBranchId(row);
    return {
      ...row,
      branchId,
      branchName: branchId ? (branchName.get(branchId) ?? null) : null,
      approvers: auditApproverIds(row).map((id) => ({ id, name: approverName.get(id) ?? null })),
    };
  });
}
