/**
 * PLAT-04 — reading a branch-owned pharmacy record through its branch scope.
 *
 * `organizationId` is the tenant boundary and stays enforced by forced
 * row-level security. The branch is a scope *inside* that boundary: two
 * branches of the same organization are the same tenant, so RLS cannot separate
 * them and every branch-owned read has to carry the branch predicate itself.
 *
 * The database backs this up — since the PLAT-04 migration each seam column is
 * a composite `(organizationId, branchId)` foreign key onto `pharmacy_branches`,
 * so a branch id borrowed from another tenant cannot even be written. The reads
 * here close the remaining half: a branch id borrowed from a *sibling* branch
 * of the same tenant resolves to nothing rather than to the sibling's row.
 */
import type { PrismaClient } from '@/generated/prisma/client';

export type PharmacyBranchScope = {
  organizationId: string;
  branchId: string;
};

/**
 * Resolve a branch within its tenant. Returns null for a branch of another
 * tenant (RLS has already filtered it) and for an id that does not exist.
 */
export async function findBranch(db: PrismaClient, scope: PharmacyBranchScope) {
  return db.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId },
  });
}

/**
 * PLAT-04 branch-scoped purchasing read: one purchase order, by id, within one
 * branch. Passing a sibling branch's purchase order id returns null instead of
 * that sibling's order — the branch predicate is part of the query, not a check
 * the caller is trusted to remember afterwards.
 */
export async function getBranchPurchaseOrder(
  db: PrismaClient,
  scope: PharmacyBranchScope,
  purchaseOrderId: string
) {
  return db.pharmacyPurchaseOrder.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      id: purchaseOrderId,
    },
    select: {
      id: true,
      organizationId: true,
      branchId: true,
      reference: true,
      status: true,
      supplierId: true,
      freightMinor: true,
      otherChargesMinor: true,
      createdAt: true,
    },
  });
}

/** Every purchase order owned by one branch, newest first. */
export async function listBranchPurchaseOrders(db: PrismaClient, scope: PharmacyBranchScope) {
  return db.pharmacyPurchaseOrder.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
    select: { id: true, reference: true, status: true, branchId: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
}
