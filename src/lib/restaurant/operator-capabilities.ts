import 'server-only';

import { capabilityMatches } from '@/lib/abac/capabilities';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { hasStaffBranchAccess } from './branch-access';
import { resolveStaffCapabilityDecision } from './job-roles';

type CapabilityRule = { capability: string; effect: 'ALLOW' | 'DENY' };

/** Resolve branch-bound active staff access. Any matching DENY across linked-user
 * rules and staff overrides wins over all grants, including wildcard grants.
 * A branch binding is a primary branch, held job role, or direct staff override. */
export async function operatorHasCapability(
  db: ScopedDb,
  staffProfileId: string,
  capability: string,
  now: Date,
  branchId: string
): Promise<boolean> {
  if (!branchId?.trim()) return false;
  const profile = await db.restaurantStaffProfile.findUnique({
    where: { id: staffProfileId },
    select: {
      status: true,
      primaryBranchId: true,
      jobRoles: { where: { branchId }, select: { branchId: true } },
      directCapabilityGrants: { where: { branchId }, select: { branchId: true } },
      user: {
        select: {
          organizationRole: {
            select: { permissions: { select: { capability: true, effect: true } } },
          },
          permissionOverrides: {
            where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            select: { capability: true, effect: true },
          },
        },
      },
    },
  });
  if (
    !profile ||
    profile.status !== 'ACTIVE' ||
    (profile.primaryBranchId !== branchId &&
      !profile.jobRoles.some((row) => row.branchId === branchId) &&
      !profile.directCapabilityGrants.some((row) => row.branchId === branchId) &&
      !(await hasStaffBranchAccess(db, staffProfileId, branchId)))
  )
    return false;
  const user = profile.user;

  const decide = (rules: readonly CapabilityRule[]): boolean | null => {
    const matching = rules.filter((rule) =>
      capabilityMatches(rule.capability, capability, rule.effect === 'DENY' ? 'DENY' : 'ALLOW')
    );
    if (matching.some((rule) => rule.effect === 'DENY')) return false;
    if (matching.some((rule) => rule.effect === 'ALLOW')) return true;
    return null;
  };

  const staff = await resolveStaffCapabilityDecision(db, staffProfileId, branchId);
  const overrides = decide(user?.permissionOverrides ?? []);
  const role = decide(user?.organizationRole?.permissions ?? []);
  if (
    overrides === false ||
    role === false ||
    [...staff.denied].some((rule) => capabilityMatches(rule, capability, 'DENY'))
  )
    return false;

  return (
    overrides === true ||
    role === true ||
    [...staff.effective].some((rule) => capabilityMatches(rule, capability, 'ALLOW'))
  );
}
