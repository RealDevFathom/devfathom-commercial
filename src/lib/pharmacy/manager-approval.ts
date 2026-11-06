import { can } from '@/lib/abac';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import { type ScopedDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';

/**
 * #482 — counter discounts and FEFO overrides need an owner/manager PIN.
 *
 * The approver is never taken from the caller: only a staff profile id and a PIN
 * arrive, and the approving user is resolved from the stored, organization-wide
 * PIN credential (the same credential store every pharmacy PIN check uses).
 */
export type ManagerApprovalInput = { staffProfileId: string; pin: string };

export type ManagerApprovalRefusal = 'MISSING' | 'INELIGIBLE' | 'LOCKED' | 'INVALID_PIN';

export type ManagerApprovalOutcome =
  | { ok: true; approverUserId: string; approverStaffProfileId: string }
  | { ok: false; reason: ManagerApprovalRefusal; approverStaffProfileId: string | null };

/** The server-owned policies an approved line is recorded under. */
export const DISCOUNT_APPROVAL_POLICY = 'PHARMACY_MANAGER_PIN';
export const FEFO_OVERRIDE_APPROVAL_POLICY = 'PHARMACY_MANAGER_PIN';

/**
 * Verify a manager PIN against the durable per-credential lockout counters.
 * Runs on whatever transaction it is handed; see {@link verifyManagerApprovalDurably}
 * for the request path, where the counters must survive a request rollback.
 */
export async function verifyManagerApproval(
  db: ScopedDb,
  scope: LedgerScope,
  approval: ManagerApprovalInput | undefined,
  now: Date = new Date()
): Promise<ManagerApprovalOutcome> {
  if (!approval) return { ok: false, reason: 'MISSING', approverStaffProfileId: null };
  const refuse = (reason: ManagerApprovalRefusal): ManagerApprovalOutcome => ({
    ok: false,
    reason,
    approverStaffProfileId: approval.staffProfileId,
  });
  // Serialize concurrent guesses against one credential so none reads a stale counter.
  await db.$queryRaw`SELECT id FROM restaurant_operator_credentials WHERE "organizationId"=${scope.organizationId} AND "staffProfileId"=${approval.staffProfileId} AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: scope.organizationId,
      staffProfileId: approval.staffProfileId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
    },
    include: { staffProfile: { include: { user: true } } },
  });
  const approver = credential?.staffProfile.user;
  if (
    !credential ||
    credential.staffProfile.status !== 'ACTIVE' ||
    !approver ||
    approver.organizationId !== scope.organizationId ||
    approver.status !== 'ACTIVE'
  )
    return refuse('INELIGIBLE');
  if (isLockedOut(credential, now)) return refuse('LOCKED');
  // A second approver is required whenever one exists. A tenant whose only active member is the
  // operator keeps the owner's all-capability workflow: their own PIN is still verified and the
  // approver id/policy are persisted on the line.
  if (
    approver.id === scope.actorId &&
    (await db.user.count({
      where: { organizationId: scope.organizationId, status: 'ACTIVE' },
    })) !== 1
  )
    return refuse('INELIGIBLE');
  const assignment = await db.pharmacyBranchAssignment.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      userId: approver.id,
      active: true,
    },
  });
  if (
    !assignment ||
    !(await can(approver, 'pharmacy:manage', undefined, { db, source: 'TRPC', now }))
  )
    return refuse('INELIGIBLE');
  if (!(await verifyOperatorCredential('PIN', approval.pin, credential.credentialHash))) {
    const next = registerFailedAttempt(credential, now);
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id, organizationId: scope.organizationId },
      data: next,
    });
    return refuse(isLockedOut(next, now) ? 'LOCKED' : 'INVALID_PIN');
  }
  if (credential.failedAttempts !== 0 || credential.lockedUntil !== null) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id, organizationId: scope.organizationId },
      data: clearLockout(),
    });
  }
  return {
    ok: true,
    approverUserId: approver.id,
    approverStaffProfileId: approval.staffProfileId,
  };
}

/**
 * Request-path wrapper: verify in an INDEPENDENT tenant transaction that commits on
 * its own. A tRPC request runs inside one transaction that is rolled back when any
 * procedure in the batch throws, so counters written there could be discarded by
 * batching a guess with a deliberately failing call. Here a failed attempt is
 * committed before the caller learns the outcome, and the five-attempt lockout
 * holds however the surrounding request ends.
 */
export function verifyManagerApprovalDurably(
  scope: LedgerScope,
  approval: ManagerApprovalInput | undefined
): Promise<ManagerApprovalOutcome> {
  if (!approval)
    return Promise.resolve({ ok: false, reason: 'MISSING', approverStaffProfileId: null });
  return withTenantDb(scope.organizationId, (db) => verifyManagerApproval(db, scope, approval), {
    userId: scope.actorId,
    skipDrain: true,
    maxWait: 5_000,
    timeout: 15_000,
  });
}

/** Staff who may approve at this branch, for the counter's approver picker. Never exposes PINs. */
export async function listManagerApprovers(db: ScopedDb, scope: LedgerScope) {
  const [staff, activeMembers] = await Promise.all([
    db.restaurantStaffProfile.findMany({
      where: {
        organizationId: scope.organizationId,
        status: 'ACTIVE',
        user: { organizationId: scope.organizationId, status: 'ACTIVE' },
        credentials: { some: { type: 'PIN', revokedAt: null, deviceId: null } },
      },
      include: {
        user: {
          include: {
            organizationRole: { include: { permissions: true } },
            permissionOverrides: true,
          },
        },
      },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    }),
    db.user.count({ where: { organizationId: scope.organizationId, status: 'ACTIVE' } }),
  ]);
  const eligible: Array<{ id: string; name: string }> = [];
  for (const profile of staff) {
    const user = profile.user;
    if (!user || user.organizationId !== scope.organizationId || user.status !== 'ACTIVE') continue;
    if (user.id === scope.actorId && activeMembers !== 1) continue;
    const assignment = await db.pharmacyBranchAssignment.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        userId: user.id,
        active: true,
      },
      select: { id: true },
    });
    if (assignment && (await can(user, 'pharmacy:manage', undefined, { db, source: 'TRPC' })))
      eligible.push({ id: profile.id, name: profile.displayName });
  }
  return eligible;
}
