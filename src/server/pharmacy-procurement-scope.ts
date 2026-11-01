import { TRPCError } from '@trpc/server';
import type { ReceivingScope } from '@/lib/pharmacy/goods-receipt';
import { isSoloPharmacyOwner } from '@/lib/pharmacy/solo-owner';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from './audit';
import type { TRPCContext } from './trpc';

/**
 * Server-side branch boundary for pharmacy purchasing and supplier links
 * (#979, PR J).
 *
 * The capability says *what* a member may do; this says *where*. A branch id in
 * a payload is only a claim: it is honoured when the branch is an active branch
 * of the session's organization AND the session user holds an active
 * assignment to it. A tenant administrator (session role ADMIN of this
 * organization) reaches every active branch, exactly as the counter receipt
 * reads in `pharmacy-sales` already allow, and that use is written to the
 * audit entry so it is visible afterwards.
 */

export type ProcurementActor = { organizationId: string; actorId: string };

const outsideScope = () =>
  new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });

/** Tenant and actor from the SESSION, never from a payload. */
export function procurementActor(ctx: TRPCContext): ProcurementActor {
  const organizationId = ctx.entitlements?.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!organizationId || !actorId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No tenant actor on this request.' });
  }
  return { organizationId, actorId };
}

function isTenantAdministrator(ctx: TRPCContext, organizationId: string): boolean {
  const user = ctx.session?.user;
  return user?.role === 'ADMIN' && user.organizationId === organizationId;
}

/**
 * The receiving scope for `branchId`, or FORBIDDEN when the caller may not act
 * there. Pass the transaction client as `db` when called inside one.
 */
export async function assertProcurementBranch(
  ctx: TRPCContext,
  branchId: string,
  db: ScopedDb = ctx.db
): Promise<ReceivingScope> {
  const { organizationId, actorId } = procurementActor(ctx);
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: branchId, organizationId, active: true },
    select: { id: true },
  });
  if (!branch) throw outsideScope();

  const assignment = await db.pharmacyBranchAssignment.findFirst({
    where: { organizationId, branchId, userId: actorId, active: true },
    select: { id: true },
  });
  if (assignment) return { organizationId, branchId, actorId };

  if (isTenantAdministrator(ctx, organizationId)) {
    annotateAudit(ctx, {
      targetType: 'PharmacyBranch',
      targetId: branchId,
      metadata: { branchId, reason: 'org-admin-procurement-access-without-branch-assignment' },
    });
    return { organizationId, branchId, actorId };
  }
  throw outsideScope();
}

/**
 * Every branch a purchasing document is tied to: its own `branchId`, and the
 * branch of the requisition it came from. Requisitions and orders without a
 * branch are tenant-level records and carry no branch boundary of their own.
 */
export async function assertOrderBranches(
  ctx: TRPCContext,
  refs: {
    branchId?: string | null;
    requisitionId?: string | null;
    requisitionBranchId?: string | null;
  },
  db: ScopedDb = ctx.db
): Promise<void> {
  const { organizationId } = procurementActor(ctx);
  const branchIds = new Set<string>();
  if (refs.branchId) branchIds.add(refs.branchId);
  if (refs.requisitionBranchId) branchIds.add(refs.requisitionBranchId);
  if (refs.requisitionId && refs.requisitionBranchId === undefined) {
    const requisition = await db.pharmacyRequisition.findFirst({
      where: { id: refs.requisitionId, organizationId },
      select: { branchId: true },
    });
    if (requisition?.branchId) branchIds.add(requisition.branchId);
  }
  for (const branchId of branchIds) await assertProcurementBranch(ctx, branchId, db);
}

/** The solo rule (see `isSoloPharmacyOwner`) for the session user. */
export async function isSoloOwner(ctx: TRPCContext, db: ScopedDb = ctx.db): Promise<boolean> {
  const { organizationId, actorId } = procurementActor(ctx);
  return isSoloPharmacyOwner(db, {
    organizationId,
    actorId,
    role: ctx.session?.user?.role,
    actorOrganizationId: ctx.session?.user?.organizationId,
  });
}

/**
 * Of `branchIds`, the ones the caller may act at: every one for a tenant
 * administrator, otherwise those the session user holds an active assignment
 * to. A branch-owned surface offers only these, so its reads are not refused
 * by `assertProcurementBranch` after the branch has been picked.
 */
export async function reachableProcurementBranchIds(
  ctx: TRPCContext,
  branchIds: readonly string[],
  db: ScopedDb = ctx.db
): Promise<string[]> {
  const { organizationId, actorId } = procurementActor(ctx);
  if (branchIds.length === 0) return [];
  if (isTenantAdministrator(ctx, organizationId)) return [...branchIds];
  const assignments = await db.pharmacyBranchAssignment.findMany({
    where: { organizationId, userId: actorId, active: true, branchId: { in: [...branchIds] } },
    select: { branchId: true },
  });
  const assigned = new Set(assignments.map((row) => row.branchId));
  return branchIds.filter((id) => assigned.has(id));
}
