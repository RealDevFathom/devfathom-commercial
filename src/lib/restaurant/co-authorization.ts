import 'server-only';

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
 * paths must construct the identical, validated record. It performs no I/O: it
 * validates a request and returns the create-shaped data the caller persists
 * (organizationId and createdAt are supplied by the database — the RLS default
 * and the row default respectively — and must not be forged by the caller).
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
 * Structural validation only: callers MUST resolve the actor from an authenticated
 * session and verify approver credentials and capability server-side before persisting.
 * Assert the co-authorization invariants (C6/C7). Throws `CoAuthorizationError`
 * on any violation. The load-bearing rule is that the approving manager cannot
 * be the acting operator: a self-approval is not a co-authorization.
 */
export function assertCoAuthorization(request: CoAuthorizationRequest): void {
  const acting = requireNonEmpty(request.actingStaffProfileId, 'acting staff profile');
  const approving = requireNonEmpty(request.approvingStaffProfileId, 'approving staff profile');
  if (acting === approving) {
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

/**
 * Validate a request and return the create-shaped, normalised record. Trims all
 * strings and folds blank optionals to null so a caller cannot smuggle
 * whitespace-only evidence past the invariants.
 */
export function buildCoAuthorizationRecord(request: CoAuthorizationRequest): CoAuthorizationRecord {
  assertCoAuthorization(request);
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
