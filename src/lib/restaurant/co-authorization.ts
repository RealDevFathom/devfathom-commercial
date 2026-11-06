import 'server-only';
import {
  hasOwnerPinReauthentication,
  ownerReauthenticationSessionId,
} from './owner-reauthentication';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { authenticateOperator } from './terminal-auth';
import { staffBranchMembership } from './branch-access';
import { operatorHasCapability } from './operator-capabilities';

// Proof is server-only, single-use, and bound to the request's transaction client.
// Neither a caller-supplied boolean nor a previous terminal unlock is evidence.
const pinProofs = new WeakMap<ScopedDb, { staffId: string; branchId: string; at: number }>();

export async function isSoloBranchOwner(db: ScopedDb, staffId: string, branchId: string) {
  const branch = await db.restaurantBranch.findUnique({
    where: { id: branchId },
    select: { id: true, organizationId: true, active: true },
  });
  if (!branch?.active) return false;
  const owner = await db.restaurantStaffProfile.findFirst({
    where: {
      id: staffId,
      organizationId: branch.organizationId,
      status: 'ACTIVE',
      jobRoles: { some: { jobRole: { key: 'owner', active: true } } },
    },
    select: { id: true },
  });
  if (!owner) return false;
  const staff = await db.restaurantStaffProfile.findMany({
    where: {
      organizationId: branch.organizationId,
      status: 'ACTIVE',
      OR: staffBranchMembership(branchId),
    },
    select: { id: true },
    take: 2,
  });
  return staff.length === 1 && staff[0]!.id === staffId;
}

/** Re-authenticate using the existing durable credential lockout path. */
export async function authenticateCoAuthorizationOperator(
  db: ScopedDb,
  params: Parameters<typeof authenticateOperator>[1] & { branchId: string }
) {
  pinProofs.delete(db);
  const auth = await authenticateOperator(db, {
    ...params,
    // Web administration has no rostered terminal sign-in. Preserve that path;
    // branch eligibility is rechecked before any self-approval evidence is built.
    branchId: params.deviceId ? params.branchId : undefined,
  });
  if (auth.ok && params.type === 'PIN') {
    pinProofs.set(db, { staffId: auth.staffProfileId, branchId: params.branchId, at: Date.now() });
  }
  return auth;
}

/** Used only after credential authentication; distinct approvals keep the pure invariant. */
export async function buildAuthenticatedCoAuthorizationRecord(
  db: ScopedDb,
  request: CoAuthorizationRequest
) {
  if (request.actingStaffProfileId.trim() !== request.approvingStaffProfileId.trim()) {
    pinProofs.delete(db);
    return buildCoAuthorizationRecord(request);
  }
  const proof = pinProofs.get(db);
  pinProofs.delete(db);
  if (
    !proof ||
    proof.staffId !== request.actingStaffProfileId.trim() ||
    Date.now() - proof.at > 30_000 ||
    !(await isSoloBranchOwner(db, proof.staffId, proof.branchId)) ||
    !(await operatorHasCapability(db, proof.staffId, 'coauth:approve', new Date(), proof.branchId))
  ) {
    throw new CoAuthorizationError(
      'Self-approval requires the sole active branch owner and fresh PIN re-authentication. A multi-staff branch requires a second identity: approver must differ from actor.'
    );
  }
  assertCoAuthorizationFields(request);
  return {
    ...normalizeRecord(request),
    reason: `${normalizeRecord(request).reason} [Solo owner; PIN re-authenticated; branch=${proof.branchId}; active staff=1]`,
  };
}

/**
 * M2-L1 / C6 & C7 — co-authorization record primitive.
 *
 * A co-authorization is the evidence that a sensitive action taken by one
 * operator (the *acting* staff) was authorised by a distinct manager (the
 * *approving* staff). Approval ADDS the manager's identity to the action — it
 * never replaces the actor (C6). Identities differ unless a sole owner has just
 * reauthenticated their PIN in this terminal request. The record pins both,
 * plus the capability/action, the target, the reason, the
 * device and terminal session (present on the L3 terminal path, absent on the
 * L2 back-office path), and a SERVER timestamp (the DB default — client time is
 * untrusted).
 *
 * The pure builder requires distinct identities. The authenticated builder above
 * additionally permits a sole branch owner with a fresh server-verified PIN. Both
 * return the create-shaped data the caller persists
 * (organizationId and createdAt are supplied by the database — the RLS default
 * and the row default respectively — and must not be forged by the caller).
 */

export type CoAuthorizationRequest = {
  /** The operator performing the sensitive action. */
  actingStaffProfileId: string;
  /** The manager granting approval; a sole owner must reauthenticate their PIN. */
  approvingStaffProfileId: string;
  /** The capability/action being co-authorised, e.g. `orders:void`. */
  capability: string;
  /** Why the action was approved — required audit evidence (C7). */
  reason: string;
  /** What was acted on (optional; e.g. `Order`). */
  targetType?: string | null;
  targetId?: string | null;
  /** The registered device (L3 terminal path); null for back-office (L2). */
  deviceId?: string | null;
  /** The terminal session (L3 terminal path); null for back-office (L2). */
  terminalSessionId?: string | null;
};

/**
 * The validated, create-shaped record. Field names match the
 * `RestaurantCoAuthorization` model so a caller can pass it straight to
 * `prisma.restaurantCoAuthorization.create({ data })`. `organizationId` and
 * `createdAt` are intentionally absent — the database supplies both.
 */
export type CoAuthorizationRecord = {
  actingStaffProfileId: string;
  approvingStaffProfileId: string;
  capability: string;
  reason: string;
  targetType: string | null;
  targetId: string | null;
  deviceId: string | null;
  terminalSessionId: string | null;
};

export class CoAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoAuthorizationError';
  }
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CoAuthorizationError(`A co-authorization requires a non-empty ${field}.`);
  }
  return trimmed;
}

function optionalTrimmed(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Assert the co-authorization invariants (C6/C7). Throws `CoAuthorizationError`
 * on any violation. The load-bearing rule is that the approving manager cannot
 * be the acting operator unless this request holds verified sole-owner PIN evidence.
 */
export function assertCoAuthorization(request: CoAuthorizationRequest): void {
  const acting = requireNonEmpty(request.actingStaffProfileId, 'acting staff profile');
  const approving = requireNonEmpty(request.approvingStaffProfileId, 'approving staff profile');
  if (acting === approving && !hasOwnerPinReauthentication(acting, request.deviceId)) {
    throw new CoAuthorizationError(
      'A co-authorization requires a second identity: the approving manager must differ from the acting operator.'
    );
  }
  assertCoAuthorizationFields(request);
}

function assertCoAuthorizationFields(request: CoAuthorizationRequest): void {
  requireNonEmpty(request.capability, 'capability');
  requireNonEmpty(request.reason, 'reason');
  // A target id without a type (or vice versa) is an ambiguous reference.
  const hasTargetType = optionalTrimmed(request.targetType) !== null;
  const hasTargetId = optionalTrimmed(request.targetId) !== null;
  if (hasTargetType !== hasTargetId) {
    throw new CoAuthorizationError(
      'A co-authorization target must specify both a targetType and a targetId, or neither.'
    );
  }
}

/**
 * Validate a request and return the create-shaped, normalised record. Trims all
 * strings and folds blank optionals to null so a caller cannot smuggle
 * whitespace-only evidence past the invariants.
 */
export function buildCoAuthorizationRecord(request: CoAuthorizationRequest): CoAuthorizationRecord {
  assertCoAuthorization(request);
  return normalizeRecord(request);
}

function normalizeRecord(request: CoAuthorizationRequest): CoAuthorizationRecord {
  return {
    actingStaffProfileId: request.actingStaffProfileId.trim(),
    approvingStaffProfileId: request.approvingStaffProfileId.trim(),
    capability: request.capability.trim(),
    reason:
      request.reason.trim() +
      (request.actingStaffProfileId.trim() === request.approvingStaffProfileId.trim()
        ? ' [Owner PIN reauthentication]'
        : ''),
    targetType: optionalTrimmed(request.targetType),
    targetId: optionalTrimmed(request.targetId),
    deviceId: optionalTrimmed(request.deviceId),
    terminalSessionId:
      optionalTrimmed(request.terminalSessionId) ??
      ownerReauthenticationSessionId(request.actingStaffProfileId.trim(), request.deviceId),
  };
}
