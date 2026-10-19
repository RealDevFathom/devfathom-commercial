/**
 * OPS-01 — the hotel operations audit timeline.
 *
 * One read: the audit trail for ONE hotel entity, newest first, cursor-paginated.
 * It serves the rows the platform audit log already holds; this lane adds no
 * audit model, no table and no second trail.
 *
 * Four walls stand between a caller and a row, and none of them is the client's
 * to choose:
 *
 *  1. ROLE. 06 §1 gives property configuration to `hotel:property-admin` and the
 *     money/reporting surfaces to `hotel:reports-financial`. Either may read the
 *     trail; neither is implied by simply holding a hotel seat. The ABAC engine
 *     decides, and it is asked for both capabilities explicitly. A shared base
 *     procedure cannot express "either", so the check is in the resolver — the
 *     documented pattern for a decision a single `capabilityProcedure(...)` gate
 *     cannot make (see `restaurant-reports`'s `allowed`).
 *  2. TENANT. Every query carries an explicit `organizationId` predicate. Forced
 *     row-level security is the second wall and never the only one.
 *  3. PROPERTY / BRANCH. The property is resolved from the SERVER's session, and
 *     the requested entity is checked against it. The client never names a branch,
 *     so it cannot address a sibling property of the same chain. A `HotelProperty`
 *     is keyed BY its `branchId`, so the same-property check and the no-cross-branch
 *     check are one predicate, not two that might disagree.
 *  4. ENTITY TYPE. A closed allowlist, shared with the writer so the two cannot
 *     drift (`HOTEL_AUDIT_ENTITY_TYPES`). An unlisted type is rejected by the
 *     input schema, before any query runs.
 *
 * What comes back is a PROJECTION, not the row. `input`, `result` and `metadata`
 * are never selected, so a reader gets who/when/what-changed and not the whole
 * captured request payload. The `changes` diff that is returned goes back through
 * the platform redactor on the way out: it was already redacted on the way in, and
 * re-running it covers rows written before a redaction rule existed rather than
 * trusting that every historical writer applied the current one.
 *
 * OPEN GAP — the module entitlement gate is INERT for this router. `hotelOps` has
 * no row in `PROCEDURE_MODULES`, so `moduleForProcedure('hotelOps.timeline')`
 * returns null and `requireLicensedModule` waves the call through; the sibling
 * `hotelProperty` maps to `hotel-core`. Authorization does not depend on it — the
 * capabilities above are granted by the hotel packages, so an organization without
 * the module holds neither — but the defence in depth is missing until the catalog
 * gains `hotelOps: 'hotel-core'`. That file is outside this lane's lease; the line
 * is named in the handoff.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import { HOTEL_AUDIT_ENTITY_TYPES } from '@/lib/hotel/audit';
import { toAuditJson } from '@/server/audit';
import { protectedProcedure, router, type TRPCContext } from '../trpc';

/** Either capability admits a reader; holding neither is a refusal. */
const TIMELINE_ACTIONS: readonly Action[] = ['hotel:property-admin', 'hotel:reports-financial'];

const timelineInput = z
  .object({
    /** The allowlist IS the schema, so an unlisted type never reaches a query. */
    entityType: z.enum(HOTEL_AUDIT_ENTITY_TYPES),
    entityId: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * The columns a timeline reader may see: who acted, when, on what, and the
 * field-level diff. Deliberately omits `input`, `result` and `metadata` — those
 * carry the whole captured request, which is more than this read is authorized to
 * disclose, and omitting them from the `select` means they are never loaded at all.
 */
const TIMELINE_SELECT = {
  id: true,
  createdAt: true,
  action: true,
  category: true,
  operation: true,
  outcome: true,
  actorType: true,
  actorId: true,
  actorName: true,
  actorEmail: true,
  actorRole: true,
  targetType: true,
  targetId: true,
  targetLabel: true,
  changes: true,
} satisfies Prisma.AuditLogSelect;

async function allowed(ctx: TRPCContext, action: Action) {
  const user = ctx.session?.user;
  return Boolean(
    user &&
    (await can(subjectFromSession(user), action, undefined, {
      db: ctx.db as Prisma.TransactionClient,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    }))
  );
}

/**
 * The property this session operates, chosen by the server. The twin in
 * `hotel-property` is private to that router and this lane does not own that file;
 * the query is the foundation's own contract — the active property, oldest first.
 */
async function currentProperty(ctx: TRPCContext) {
  return ctx.db.hotelProperty.findFirst({
    where: { organizationId: ctx.entitlements.organizationId, active: true },
    orderBy: { createdAt: 'asc' },
  });
}

export const hotelOpsRouter = router({
  /**
   * OPS-01 — the audit events for one entity, newest first.
   *
   * Ordering is `(createdAt desc, id desc)`: `createdAt` alone is not unique, and
   * a page boundary landing inside a block of rows sharing one instant needs the
   * id tiebreaker to be stable across calls.
   */
  timeline: protectedProcedure.input(timelineInput).query(async ({ ctx, input }) => {
    if (!ctx.session?.user) throw new TRPCError({ code: 'UNAUTHORIZED' });

    const grants = await Promise.all(TIMELINE_ACTIONS.map((action) => allowed(ctx, action)));
    if (!grants.some(Boolean)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'You do not have permission to read the hotel audit timeline.',
      });
    }

    const property = await currentProperty(ctx);
    if (!property) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message:
          'This workspace has no property yet. A property is created with the workspace, so ask your DevFathom account manager to re-run provisioning.',
      });
    }

    // Same-property authorization. A property IS its branch (`branchId` is the
    // primary key), so an entity id that is not this session's property is a
    // request for somebody else's trail. It is refused as NOT_FOUND rather than
    // FORBIDDEN: a distinguishable refusal would confirm that the id names a real
    // property of some other branch, which is itself the disclosure.
    if (input.entityType === 'HotelProperty' && input.entityId !== property.branchId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No audit timeline for that entity.' });
    }

    const rows = await ctx.db.auditLog.findMany({
      where: {
        organizationId: ctx.entitlements.organizationId,
        targetType: input.entityType,
        targetId: input.entityId,
      },
      select: TIMELINE_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
    });

    // The `limit + 1`st row is a has-more probe only: it is never part of the page
    // and it is never the cursor. The cursor is the LAST ROW WE RETURN, because
    // Prisma's cursor is INCLUSIVE and `skip: 1` steps past it — handing back the
    // popped probe would name a row the caller was never given and then discard
    // it, losing exactly one row at every page boundary (#42).
    let nextCursor: string | undefined;
    if (rows.length > input.limit) {
      rows.pop();
      nextCursor = rows[rows.length - 1]?.id;
    }

    return {
      items: rows.map((row) => ({ ...row, changes: toAuditJson(row.changes) })),
      nextCursor,
    };
  }),
});
