import 'server-only';
import { isTenantAdministrator } from '@/lib/abac/tenant-administrator';
import { authenticateApprovalPin } from './approval-auth';

/**
 * M2-L1 / C6 & C7 — co-authorization record primitive.
 *
 * A co-authorization is the evidence that a sensitive action taken by one
 * operator (the *acting* staff) was authorised by a distinct manager (the
 * *approving* staff). Approval ADDS the manager's identity to the action — it
 * never replaces the actor (C6) — so the two identities must differ, and the
 * record pins both, plus the capability/action, the target, the reason, the
 * device and terminal session (present on the L3 terminal path, absent on the
 * L2 back-office path), and a SERVER timestamp (the DB default — client time is
 * untrusted).
 *
 * This primitive lives in L1 because both the L2 back-office and L3 terminal
 * paths must construct the identical, validated record. The ordinary builder
 * validates a request and returns the create-shaped data the caller persists
 * (organizationId and createdAt are supplied by the database — the RLS default
 * and the row default respectively — and must not be forged by the caller).
 * The async solo-owner builder additionally checks live ownership, roster and PIN.
 */

export type CoAuthorizationRequest = {
  /** The operator performing the sensitive action. */
  actingStaffProfileId: string;
  /** The manager granting approval. MUST differ from the acting operator (C6). */
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
 * be the acting operator: a self-approval is not a co-authorization.
 */
function validateRequest(request: CoAuthorizationRequest, soloOwner = false): void {
  const acting = requireNonEmpty(request.actingStaffProfileId, 'acting staff profile');
  const approving = requireNonEmpty(request.approvingStaffProfileId, 'approving staff profile');
  if (acting === approving && !soloOwner) {
    throw new CoAuthorizationError(
      'A co-authorization requires a second identity: the approving manager must differ from the acting operator.'
    );
  }
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

export function assertCoAuthorization(request: CoAuthorizationRequest): void {
  validateRequest(request);
}

/**
 * Validate a request and return the create-shaped, normalised record. Trims all
 * strings and folds blank optionals to null so a caller cannot smuggle
 * whitespace-only evidence past the invariants.
 */
export function buildCoAuthorizationRecord(request: CoAuthorizationRequest): CoAuthorizationRecord {
  assertCoAuthorization(request);
  return normalizedRecord(request);
}

function normalizedRecord(request: CoAuthorizationRequest): CoAuthorizationRecord {
  return {
    actingStaffProfileId: request.actingStaffProfileId.trim(),
    approvingStaffProfileId: request.approvingStaffProfileId.trim(),
    capability: request.capability.trim(),
    reason: request.reason.trim(),
    targetType: optionalTrimmed(request.targetType),
    targetId: optionalTrimmed(request.targetId),
    deviceId: optionalTrimmed(request.deviceId),
    terminalSessionId: optionalTrimmed(request.terminalSessionId),
  };
}

/** Server-only exception: no client flag can replace the live owner/roster/PIN checks.
 * Callers persist this evidence and their explicit audit with the action.
 */
export async function buildSoloOwnerCoAuthorization(
  db: import('@/lib/tenancy/scoped-db').ScopedDb,
  request: CoAuthorizationRequest,
  branchId: string,
  pin: string | undefined
): Promise<CoAuthorizationRecord> {
  validateRequest(request, true);
  if (request.actingStaffProfileId.trim() !== request.approvingStaffProfileId.trim() || !pin) {
    throw new CoAuthorizationError('Solo-owner approval requires PIN reauthentication.');
  }
  const profile = await db.restaurantStaffProfile.findUnique({
    where: { id: request.actingStaffProfileId },
    select: {
      id: true,
      organizationId: true,
      status: true,
      user: { select: { role: true, status: true, organizationRole: { select: { key: true } } } },
      jobRoles: {
        where: { branchId, jobRole: { key: 'owner', active: true } },
        select: { id: true },
      },
    },
  });
  const tenantOwner = profile?.user?.status === 'ACTIVE' && isTenantAdministrator(profile.user);
  if (profile?.status !== 'ACTIVE' || (!tenantOwner && !profile.jobRoles?.length)) {
    throw new CoAuthorizationError('Only a solo tenant or branch owner may self-approve.');
  }
  // A sole active staff member is counted across the tenant, not just the
  // primary branch: secondary assignments and global owners must not bypass it.
  const colleagues = await db.restaurantStaffProfile.count({
    where: { status: 'ACTIVE', id: { not: profile.id } },
  });
  if (colleagues !== 0) throw new CoAuthorizationError('A second staff approver is required.');
  const { operatorHasCapability } = await import('./checkout-routes');
  const now = new Date();
  if (
    !(await operatorHasCapability(db, profile.id, 'coauth:approve', now, branchId)) ||
    !(await operatorHasCapability(db, profile.id, request.capability, now, branchId))
  ) {
    throw new CoAuthorizationError('Owner approval capability is denied for this branch.');
  }
  const auth = await authenticateApprovalPin(profile.organizationId, {
    staffProfileId: profile.id,
    deviceId: request.deviceId ?? undefined,
    type: 'PIN',
    secret: pin,
    now: new Date(),
  });
  if (!auth.ok) throw new CoAuthorizationError('PIN reauthentication failed.');
  return normalizedRecord({ ...request, reason: `[SOLO_OWNER_PIN_REAUTH] ${request.reason}` });
}
