import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readReceiptLayout, SaveReceiptLayoutSchema } from './configuration';

/** Trusted consumer must derive branchId from its authorized device/session scope. */
export async function getRestaurantReceiptLayout(
  db: ScopedDb,
  organizationId: string,
  branchId: string
) {
  const branch = await db.restaurantBranch.findFirst({
    where: { id: branchId, organizationId, active: true },
    select: { receiptLayout: true, receiptLayoutRevision: true },
  });
  if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
  return {
    layout: readReceiptLayout(branch.receiptLayout),
    revision: branch.receiptLayoutRevision,
  };
}

export async function listRestaurantReceiptLayouts(db: ScopedDb, organizationId: string) {
  const branches = await db.restaurantBranch.findMany({
    where: { organizationId, active: true },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, receiptLayout: true, receiptLayoutRevision: true },
  });
  return branches.map((branch) => ({
    id: branch.id,
    name: branch.name,
    layout: readReceiptLayout(branch.receiptLayout),
    revision: branch.receiptLayoutRevision,
  }));
}

/** Caller must authorize restaurant:configure. Organization comes only from the session. */
export async function saveRestaurantReceiptLayout(
  db: ScopedDb,
  organizationId: string,
  raw: unknown
) {
  const input = SaveReceiptLayoutSchema.parse(raw);
  const updated = await db.restaurantBranch.updateMany({
    where: {
      id: input.branchId,
      organizationId,
      active: true,
      receiptLayoutRevision: input.revision,
    },
    data: { receiptLayout: input.layout, receiptLayoutRevision: { increment: 1 } },
  });
  if (updated.count !== 1)
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Branch unavailable or layout changed. Reload saved settings before trying again.',
    });
  return { layout: input.layout, revision: input.revision + 1 };
}
