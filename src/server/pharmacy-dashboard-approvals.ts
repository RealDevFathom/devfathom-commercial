import 'server-only';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import {
  commandIds,
  isOwnerWithoutOtherReviewer,
  pendingCatalogueEdits,
} from '@/lib/pharmacy/catalogue-approvals';
import { STAGED_CREATION_OPERATION } from '@/lib/pharmacy/migration/staged-creation';
import { assignedRegisterBranchIds } from '@/lib/pharmacy/controlled-register';
import type { WatchRow } from '@/lib/pharmacy/owner-watch';
import { soloOwnerApprovalAllowed } from '@/lib/pharmacy/purchase-approval';
import { actorIsPharmacyOwner, actorCanProcure } from '@/lib/pharmacy/procurement-access';
import { purchaseOrderScopeWhere } from '@/lib/pharmacy/purchasing-console';
import { reachableProcurementBranchIds, isSoloOwner } from './pharmacy-procurement-scope';
import { purchasingOrderScope } from './routers/pharmacy-purchasing';
import { clinicalReviewScope } from './routers/pharmacy-dispensing';
import { admittedInventoryBranchIds } from './routers/pharmacy-inventory';
import { approvedReorderBranch, catalogueAccess } from './routers/pharmacy-medicine';
import type { TRPCContext } from './trpc';

export async function readDashboardApprovals(
  ctx: TRPCContext,
  branchIds: string[],
  selectedBranch?: string
) {
  const rows: WatchRow[] = [];
  const user = ctx.session?.user;
  const organizationId = ctx.entitlements.organizationId;
  if (!user || user.organizationId !== organizationId || !branchIds.length) return rows;
  const subject = subjectFromSession(user);
  const env = { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta.ip };
  const add = (label: string, value: number, path: string, period: string) => {
    const url = selectedBranch
      ? path + (path.includes('?') ? '&' : '?') + new URLSearchParams({ branch: selectedBranch })
      : path;
    rows.push({ label, value, href: url, period, group: 'approval' });
  };

  if (hasModule(ctx.entitlements, 'pharmacy-procurement')) {
    const [orders, suppliers] = await Promise.all([
      can(subject, 'pharmacy:procurement-approve', undefined, env),
      can(subject, 'pharmacy:procurement', undefined, env),
    ]);
    const reachable =
      orders || suppliers ? await reachableProcurementBranchIds(ctx, branchIds) : [];
    if (reachable.length && orders && (await actorCanProcure(ctx.db, user.id))) {
      const purchasing = await purchasingOrderScope(ctx);
      const scope = purchaseOrderScopeWhere({
        organizationId,
        branchIds: reachable.filter((id) => purchasing.branchIds.includes(id)),
        includeUnscoped: purchasing.includeUnscoped && !selectedBranch,
      });
      const pending = await ctx.db.pharmacyPurchaseOrder.findMany({
        where: { ...scope, status: 'SUBMITTED' },
        select: {
          branchId: true,
          createdByUserId: true,
          requisition: { select: { requestedByUserId: true } },
        },
      });
      const other = pending.filter(
        (order) =>
          order.createdByUserId !== user.id && order.requisition?.requestedByUserId !== user.id
      );
      let count = other.length;
      if (count < pending.length && (await isSoloOwner(ctx))) {
        const own = pending.filter(
          (order) =>
            order.createdByUserId === user.id || order.requisition?.requestedByUserId === user.id
        );
        for (const branch of new Set(own.map((order) => order.branchId))) {
          if (await soloOwnerApprovalAllowed(ctx.db, organizationId, user.id, branch))
            count += own.filter((order) => order.branchId === branch).length;
        }
      }
      add(
        'Purchase orders',
        count,
        '/pharmacy/purchasing/orders',
        'Submitted orders you can decide'
      );
    }
    if (reachable.length && suppliers) {
      const value = await ctx.db.pharmacySupplierSubmission.count({
        where: pendingSupplierSubmissions(organizationId, reachable),
      });
      add(
        'Supplier submission approvals',
        value,
        '/dashboard/approvals/suppliers',
        'Current supplier proposals awaiting a decision'
      );
    }
  }

  const catalogue = await catalogueAccess(ctx);
  if (catalogue.reviewer || catalogue.ownerFallback) {
    const edits = await ctx.db.pharmacyCatalogueEdit.findMany({
      where: { ...pendingCatalogueEdits, organizationId },
      select: { editorId: true, operation: true, changes: true },
    });
    const ownAllowed =
      edits.some((edit) => edit.editorId === user.id) &&
      (await isOwnerWithoutOtherReviewer(
        ctx.db,
        { organizationId, actorId: user.id, actorOrganizationId: user.organizationId },
        { countOtherOwners: true }
      ));
    const stagedBranches = edits.some((edit) => edit.operation === STAGED_CREATION_OPERATION)
      ? await admittedInventoryBranchIds(ctx)
      : new Set<string>();
    const eligible = edits.filter((edit) => {
      if (edit.editorId === user.id && !ownAllowed) return false;
      if (edit.operation === STAGED_CREATION_OPERATION) {
        const reorderBranch = approvedReorderBranch(edit.changes);
        return branchIds.some(
          (id) => stagedBranches.has(id) && (!reorderBranch || id === reorderBranch)
        );
      }
      return commandIds(edit.operation, edit.changes).branches.every((branch) =>
        branchIds.includes(branch)
      );
    });
    const price = eligible.filter((edit) => edit.operation === 'setPackPrice').length;
    add(
      'Catalogue edits',
      eligible.length - price,
      '/pharmacy/medicines',
      'Pending catalogue decisions excluding pack prices'
    );
    add(
      'Price-change proposals',
      price,
      '/pharmacy/medicines',
      'Pending pack prices in the catalogue review queue'
    );
  }

  if (
    hasModule(ctx.entitlements, 'pharmacy-safety') &&
    (await can(subject, 'pharmacy:safety', undefined, env))
  ) {
    const assigned = await assignedRegisterBranchIds(ctx.db, organizationId, user.id);
    const admitted = branchIds.filter((id) => assigned.includes(id));
    if (admitted.length)
      add(
        'Register incident approvals',
        await ctx.db.pharmacyRegisterIncident.count({
          where: pendingRegisterIncidents(organizationId, admitted),
        }),
        '/dashboard/approvals/register',
        'Open balance incidents at your register branches'
      );
  }
  if (
    hasModule(ctx.entitlements, 'pharmacy-dispensing') &&
    (await can(subject, 'pharmacy:dispense', undefined, env))
  ) {
    const assigned = (await actorIsPharmacyOwner(ctx.db, organizationId, user.id))
      ? branchIds
      : await assignedRegisterBranchIds(ctx.db, organizationId, user.id);
    const admitted = branchIds.filter((id) => assigned.includes(id));
    if (admitted.length) {
      const scope = await clinicalReviewScope(ctx, admitted);
      add(
        'Pharmacist review items',
        await ctx.db.pharmacyPharmacistReviewItem.count({ where: scope }),
        '/pharmacy/pharmacist-queue',
        'Sale lines awaiting signed review'
      );
    }
  }
  if (
    hasModule(ctx.entitlements, 'pharmacy-inventory') &&
    (await can(subject, 'pharmacy:inventory', undefined, env))
  ) {
    const assigned = await admittedInventoryBranchIds(ctx);
    const admitted = branchIds.filter((id) => assigned.has(id));
    if (admitted.length) {
      let total = 0;
      for (const branchId of admitted) {
        const where = { organizationId, branchId };
        const canCoauthorize = await soloOwnerApprovalAllowed(
          ctx.db,
          organizationId,
          user.id,
          branchId
        );
        total += await ctx.db.pharmacyInventoryCount.count({
          where: {
            ...where,
            OR: [
              { status: 'OPEN' },
              {
                status: 'AWAITING_COAUTH',
                ...(canCoauthorize ? {} : { createdById: { not: user.id } }),
              },
            ],
          },
        });
      }
      add(
        'Stock counts',
        total,
        '/pharmacy/inventory',
        'Open counts and variances you can co-authorize'
      );
    }
  }
  return rows;
}

export const pendingSupplierSubmissions = (organizationId: string, branchIds: string[]) => ({
  organizationId,
  branchId: { in: branchIds },
  supersededBy: { none: {} },
  approvals: { none: {} },
});
export const pendingRegisterIncidents = (organizationId: string, branchIds: string[]) => ({
  organizationId,
  branchId: { in: branchIds },
  status: 'OPEN' as const,
});
