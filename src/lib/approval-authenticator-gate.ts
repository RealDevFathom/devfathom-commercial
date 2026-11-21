import 'server-only';

import { can, subjectFromSession } from '@/lib/abac';
import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import { approvalAuthenticatorPartySelect } from '@/lib/approval-authenticator-party';
import {
  isRestaurantApproverRight,
  type ApprovalApproverRight,
} from '@/lib/approval-approver-rights';
import { operatorHasCapability } from '@/lib/restaurant/operator-capability';
import { APPROVAL_APPROVER_RIGHTS_BY_VERTICAL } from '@/lib/vertical-catalog';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-961 — authenticator by default, and who must set one up.
 *
 * While the organization requires an authenticator for approvals (the default), a member who
 * holds any approver right of the shared approval path (`APPROVAL_APPROVER_RIGHTS_BY_VERTICAL`,
 * checked with the same permission engine the approval routes use) and has not enrolled an
 * approval authenticator cannot use their account: every page sends them to the set-up screen
 * and every API call is refused until it is done. A member with no approver right is never
 * asked.
 */

/** Owner role keys the sole-owner self-approval paths accept (see pharmacy-reports). */
const OWNER_ROLE_KEYS = new Set(['owner', 'owner-operator']);

type Party = {
  id: string;
  role: string;
  status: string;
  department: string | null;
  organizationRole: {
    key: string;
    isSystem: boolean;
    permissions: { capability: string; effect: string }[];
  } | null;
  permissionOverrides: { capability: string; effect: string }[];
};

async function holdsRestaurantRight(
  db: ScopedDb,
  userId: string,
  capability: string,
  now: Date
): Promise<boolean> {
  const profiles = await db.restaurantStaffProfile.findMany({
    where: { userId, status: 'ACTIVE' },
    select: {
      id: true,
      primaryBranchId: true,
      jobRoles: { select: { branchId: true } },
      directCapabilityGrants: { select: { branchId: true } },
    },
  });
  for (const profile of profiles) {
    const branches = new Set<string>();
    if (profile.primaryBranchId) branches.add(profile.primaryBranchId);
    for (const row of profile.jobRoles) branches.add(row.branchId);
    for (const row of profile.directCapabilityGrants) branches.add(row.branchId);
    for (const branchId of branches)
      if (await operatorHasCapability(db, profile.id, capability, now, branchId)) return true;
  }
  return false;
}

/** Whether `party` holds `right`, decided the way the approval routes decide it. */
async function holdsApproverRight(
  db: ScopedDb,
  party: Party,
  right: ApprovalApproverRight,
  now: Date
): Promise<boolean> {
  if (right === 'OWNER')
    return (
      hasAllCapabilityAccess(party) ||
      party.role === 'ADMIN' ||
      OWNER_ROLE_KEYS.has(party.organizationRole?.key ?? '')
    );
  if (isRestaurantApproverRight(right)) return holdsRestaurantRight(db, party.id, right, now);
  return can(subjectFromSession(party), right, undefined, { db, now });
}

/**
 * Whether the member can approve anything through the shared approval path in their
 * organization. Only an ACTIVE member can approve (every approval route refuses anyone
 * else), so a member on leave is not asked until they return.
 */
export async function holdsAnyApprovalRight(
  db: ScopedDb,
  input: { organizationId: string; userId: string; now?: Date }
): Promise<boolean> {
  const now = input.now ?? new Date();
  const [organization, party] = await Promise.all([
    db.organization.findFirst({ where: { id: input.organizationId }, select: { vertical: true } }),
    db.user.findFirst({
      where: { id: input.userId, organizationId: input.organizationId },
      select: { ...approvalAuthenticatorPartySelect(now), department: true },
    }),
  ]);
  if (!organization || !party || party.status !== 'ACTIVE') return false;
  for (const right of APPROVAL_APPROVER_RIGHTS_BY_VERTICAL[organization.vertical] ?? [])
    if (await holdsApproverRight(db, party, right, now)) return true;
  return false;
}

export type ApprovalAuthenticatorGate = {
  /** The member holds an approver right of the shared approval path. */
  approver: boolean;
  /** The member must set up an approval authenticator before using their account. */
  setupRequired: boolean;
};

/**
 * The live, server-side gate verdict for one member. `approver` may be passed in when the
 * caller already knows it (the session claim, refreshed with the role every revalidation),
 * so the per-request check is two indexed reads.
 */
export async function approvalAuthenticatorGate(
  db: ScopedDb,
  input: { organizationId: string; userId: string; approver?: boolean; now?: Date }
): Promise<ApprovalAuthenticatorGate> {
  const [organization, authenticator] = await Promise.all([
    db.organization.findFirst({
      where: { id: input.organizationId },
      select: { requireApprovalAuthenticator: true },
    }),
    db.approvalAuthenticator.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: input.userId,
        enabledAt: { not: null },
      },
      select: { id: true },
    }),
  ]);
  const approver = input.approver ?? (await holdsAnyApprovalRight(db, input));
  // Fail closed: an unreadable organization is treated as requiring the authenticator.
  const required = organization ? organization.requireApprovalAuthenticator : true;
  return { approver, setupRequired: approver && required && !authenticator };
}
