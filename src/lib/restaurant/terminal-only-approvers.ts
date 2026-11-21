import 'server-only';

import { capabilityMatches } from '@/lib/abac/capabilities';
import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import { RESTAURANT_APPROVER_RIGHTS } from '@/lib/approval-approver-rights';
import { approvalAuthenticatorPartySelect } from '@/lib/approval-authenticator-party';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { resolveStaffCapabilityDecision } from './job-roles';
import { operatorHasCapability } from './operator-capability';

/**
 * DEV-961 — terminal-only approvers.
 *
 * A staff profile with no web login cannot set up an authenticator app, so it keeps
 * approving with its PIN while the owner's "Authenticator for approvals" setting is on. That
 * exception is the owner's alone to grant: only the owner may leave a staff profile that holds
 * an approver right without a login, by
 *  - removing the login from a profile that can approve (a manager cannot unlink a login,
 *    their own included), or
 *  - giving a profile with no login an approver right (a job role, a role's capabilities, a
 *    direct override, reactivating it).
 * Every such change is audited and every owner is notified. Settings lists these profiles
 * under "Cannot use an authenticator: no login".
 */

export const TERMINAL_ONLY_APPROVER_OWNER_ONLY =
  'Only the owner can leave a staff member who can approve without a login. Ask the owner.';

export class TerminalOnlyApproverError extends Error {
  constructor() {
    super(TERMINAL_ONLY_APPROVER_OWNER_ONLY);
    this.name = 'TerminalOnlyApproverError';
  }
}

async function boundBranches(db: ScopedDb, staffProfileId: string): Promise<string[]> {
  const profile = await db.restaurantStaffProfile.findUnique({
    where: { id: staffProfileId },
    select: {
      primaryBranchId: true,
      jobRoles: { select: { branchId: true } },
      directCapabilityGrants: { select: { branchId: true } },
    },
  });
  if (!profile) return [];
  const branches = new Set<string>();
  if (profile.primaryBranchId) branches.add(profile.primaryBranchId);
  for (const row of profile.jobRoles) branches.add(row.branchId);
  for (const row of profile.directCapabilityGrants) branches.add(row.branchId);
  return [...branches];
}

/** Whether the profile holds an approver right at any branch it is bound to, as it stands. */
export async function staffProfileHoldsApproverRight(
  db: ScopedDb,
  staffProfileId: string,
  now = new Date()
): Promise<boolean> {
  for (const branchId of await boundBranches(db, staffProfileId))
    for (const right of RESTAURANT_APPROVER_RIGHTS)
      if (await operatorHasCapability(db, staffProfileId, right, now, branchId)) return true;
  return false;
}

/**
 * Whether the profile would hold an approver right from its own staff rules alone (job roles
 * and direct overrides), that is once its login, and the login's organization role, is gone.
 */
async function staffRulesGrantApproverRight(
  db: ScopedDb,
  staffProfileId: string
): Promise<boolean> {
  for (const branchId of await boundBranches(db, staffProfileId)) {
    const decision = await resolveStaffCapabilityDecision(db, staffProfileId, branchId);
    for (const right of RESTAURANT_APPROVER_RIGHTS)
      if (
        [...decision.effective].some((rule) => capabilityMatches(rule, right, 'ALLOW')) &&
        ![...decision.denied].some((rule) => capabilityMatches(rule, right, 'DENY'))
      )
        return true;
  }
  return false;
}

/** The ACTIVE profiles with no web login that hold an approver right. */
export async function terminalOnlyApproverIds(db: ScopedDb, now = new Date()): Promise<Set<string>> {
  const profiles = await db.restaurantStaffProfile.findMany({
    where: { userId: null, status: 'ACTIVE' },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const ids = new Set<string>();
  for (const profile of profiles)
    if (await staffProfileHoldsApproverRight(db, profile.id, now)) ids.add(profile.id);
  return ids;
}

/** Whether the member is the owner (the live all-capability identity). */
export async function memberIsOwner(
  db: ScopedDb,
  organizationId: string,
  userId: string,
  now = new Date()
): Promise<boolean> {
  const party = await db.user.findFirst({
    where: { id: userId, organizationId },
    select: approvalAuthenticatorPartySelect(now),
  });
  return party !== null && hasAllCapabilityAccess(party);
}

/**
 * Refuses, before the write, a non-owner removing the login from a profile that can approve
 * now or would still approve without it.
 */
export async function assertMayRemoveLogin(
  db: ScopedDb,
  input: { organizationId: string; actorUserId: string; staffProfileId: string; now?: Date }
): Promise<void> {
  const now = input.now ?? new Date();
  const profile = await db.restaurantStaffProfile.findUnique({
    where: { id: input.staffProfileId },
    select: { userId: true },
  });
  if (!profile?.userId) return;
  const approves =
    (await staffProfileHoldsApproverRight(db, input.staffProfileId, now)) ||
    (await staffRulesGrantApproverRight(db, input.staffProfileId));
  if (approves && !(await memberIsOwner(db, input.organizationId, input.actorUserId, now)))
    throw new TerminalOnlyApproverError();
}

export type TerminalOnlyApproverChange = {
  /** Profiles that became terminal-only approvers through this change. */
  added: { id: string; displayName: string }[];
};

/**
 * Runs a staff or role change in one transaction and compares the terminal-only approvers
 * before and after. A non-owner whose change would add one is refused and the change rolls
 * back. When the owner makes it, each new terminal-only approver gets an audit row and every
 * owner a notification, in the same transaction.
 */
export async function guardTerminalOnlyApprovers<T>(
  db: ScopedDb,
  input: { organizationId: string; actorUserId: string; action: string; now?: Date },
  work: (tx: ScopedDb) => Promise<T>
): Promise<{ result: T } & TerminalOnlyApproverChange> {
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    const scoped = tx as unknown as ScopedDb;
    const before = await terminalOnlyApproverIds(scoped, now);
    const result = await work(scoped);
    const after = await terminalOnlyApproverIds(scoped, now);
    const addedIds = [...after].filter((id) => !before.has(id));
    if (addedIds.length === 0) return { result, added: [] };
    if (!(await memberIsOwner(scoped, input.organizationId, input.actorUserId, now)))
      throw new TerminalOnlyApproverError();
    const added = await scoped.restaurantStaffProfile.findMany({
      where: { id: { in: addedIds } },
      select: { id: true, displayName: true },
      orderBy: { id: 'asc' },
    });
    await recordTerminalOnlyApprovers(scoped, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.action,
      profiles: added,
      now,
    });
    return { result, added };
  });
}

/** One audit row per profile, and a notification to every owner. */
export async function recordTerminalOnlyApprovers(
  db: ScopedDb,
  input: {
    organizationId: string;
    actorUserId: string;
    action: string;
    profiles: { id: string; displayName: string }[];
    now?: Date;
  }
): Promise<void> {
  if (input.profiles.length === 0) return;
  const now = input.now ?? new Date();
  await db.auditLog.createMany({
    data: input.profiles.map((profile) => ({
      organizationId: input.organizationId,
      actorId: input.actorUserId,
      source: 'TRPC' as const,
      category: 'AUTH' as const,
      operation: 'UPDATE' as const,
      action: input.action,
      description: `"${profile.displayName}" can approve without a login: approves with a PIN`,
      targetType: 'RestaurantStaffProfile',
      targetId: profile.id,
      targetLabel: profile.displayName,
      outcome: 'SUCCESS' as const,
      metadata: { terminalOnlyApprover: true, approvesWith: 'PIN', at: now.toISOString() },
    })),
  });
  const members = await db.user.findMany({
    where: { organizationId: input.organizationId, status: 'ACTIVE' },
    select: approvalAuthenticatorPartySelect(now),
  });
  const owners = members.filter((member) => hasAllCapabilityAccess(member));
  if (owners.length === 0) return;
  await db.notification.createMany({
    data: owners.flatMap((owner) =>
      input.profiles.map((profile) => ({
        organizationId: input.organizationId,
        userId: owner.id,
        type: 'terminal_only_approver',
        title: 'A staff member can approve without a login',
        message: `${profile.displayName} has no login, so they approve with a PIN instead of an authenticator code. You can review this in Settings, under Cannot use an authenticator: no login.`,
        entityType: 'RestaurantStaffProfile',
        entityId: profile.id,
      }))
    ),
  });
}
