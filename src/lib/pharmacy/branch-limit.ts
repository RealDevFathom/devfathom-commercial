import type { PrismaClient } from '@/generated/prisma/client';
import { PHARMACY_BRANCH_SCOPED_ROLE_KEYS } from '@/lib/vertical-catalog';

export type PharmacyBranchLimitDb = Pick<PrismaClient, 'user' | 'pharmacyBranchAssignment'>;

/**
 * The pharmacy branches a branch-scoped member (the Manager template) may read
 * reports for and close days at: their active assignments to active branches of
 * this organization. Returns null when the member is not branch-scoped, so the
 * caller keeps its organization-wide behaviour. Session ADMIN is never narrowed.
 * A member who cannot be resolved inside this organization gets an empty list.
 */
export async function pharmacyBranchLimit(
  db: PharmacyBranchLimitDb,
  user: { id?: string | null; role?: string | null } | null | undefined,
  organizationId: string
): Promise<string[] | null> {
  if (!user?.id) return [];
  if (user.role === 'ADMIN') return null;
  const member = await db.user.findFirst({
    where: { id: user.id, organizationId },
    select: { organizationRole: { select: { key: true } } },
  });
  if (!member) return [];
  const key = member.organizationRole?.key;
  if (!key || !PHARMACY_BRANCH_SCOPED_ROLE_KEYS.has(key)) return null;
  const rows = await db.pharmacyBranchAssignment.findMany({
    where: {
      organizationId,
      userId: user.id,
      active: true,
      branch: { organizationId, active: true },
    },
    select: { branchId: true },
  });
  return rows.map((row) => row.branchId);
}
