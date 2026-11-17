import 'server-only';

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { operatorHasCapability } from './checkout-routes';
import {
  hasOwnerPinReauthentication,
  recordOwnerPinReauthentication,
  withOwnerReauthenticationScope,
} from './owner-reauthentication';
import { authenticateOperator } from './terminal-auth';

/**
 * Back-office (L2, tRPC) maker-checker approval.
 *
 * The approving staff member must prove who they are on the server: an
 * organization-wide PIN or badge checked by `authenticateOperator` (ACTIVE
 * profile, unrevoked credential, durable failed-attempt lockout). The approver
 * must then hold `capability` at the target's branch.
 *
 * The credential check commits in its own `withTenantDb` transaction, so a
 * refused request never rolls back the brute-force counter. A `FOR UPDATE` lock
 * on the credential rows serializes parallel guesses.
 *
 * Self-approval (approver === session actor) is allowed only for a sole owner:
 * a fresh PIN (never a badge), plus the server-side `isSoloOwner` check (exactly
 * one ACTIVE staff profile in the tenant, owner role, `coauth:approve` not
 * denied). It must run inside `withBackOfficeApprovalScope`, so the proof is
 * bound to this request and the session actor. `buildCoAuthorizationRecord` then
 * stamps the record `[Owner PIN reauthentication]` in the same transaction as
 * the guarded write.
 *
 * Every refusal returns the same `{ ok: false }`, so a caller cannot tell a wrong
 * PIN, a lockout, an unknown staff id or a missing permission apart.
 */

export const APPROVER_REFUSED_MESSAGE = 'Approving credential is invalid or locked.';

export type ApprovalMode = 'SECOND_OPERATOR' | 'OWNER_PIN_REAUTHENTICATION';

export type BackOfficeApproverRequest = {
  organizationId: string;
  /** The session-derived acting staff profile (never caller-supplied). */
  actingStaffProfileId: string;
  approvingStaffProfileId: string;
  type: 'PIN' | 'BADGE';
  secret: string;
  /** The capability the approver must hold at `branchId`. */
  capability: string;
  /** The branch of the record being acted on, derived server-side. */
  branchId: string;
  /** The device the co-authorization record will carry (null when none). */
  deviceId?: string | null;
  now?: Date;
};

export type BackOfficeApproverResult =
  { ok: true; staffProfileId: string; mode: ApprovalMode } | { ok: false };

/**
 * Bind solo-owner PIN proof to this request and the session actor. Wrap both
 * `verifyBackOfficeApprover` and the command that persists the co-authorization.
 */
export function withBackOfficeApprovalScope<T>(
  scope: { actingStaffProfileId: string; deviceId?: string | null },
  work: () => Promise<T>
): Promise<T> {
  return withOwnerReauthenticationScope(
    {
      actingStaffProfileId: scope.actingStaffProfileId,
      deviceId: scope.deviceId ?? null,
      terminalSessionId: null,
    },
    work
  );
}

export async function verifyBackOfficeApprover(
  db: ScopedDb,
  request: BackOfficeApproverRequest
): Promise<BackOfficeApproverResult> {
  const now = request.now ?? new Date();
  const approvingStaffProfileId = request.approvingStaffProfileId.trim();
  const selfApproval = approvingStaffProfileId === request.actingStaffProfileId;
  // A sole owner approving their own request must re-enter a PIN; a badge is a
  // possession factor and can be used by whoever holds it.
  if (selfApproval && request.type !== 'PIN') return { ok: false };

  const auth = await withTenantDb(request.organizationId, async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT id FROM restaurant_operator_credentials
       WHERE "staffProfileId" = $1 AND type::text = $2
         AND "deviceId" IS NULL AND "revokedAt" IS NULL
       ORDER BY id FOR UPDATE`,
      approvingStaffProfileId,
      request.type
    );
    return authenticateOperator(tx, {
      staffProfileId: approvingStaffProfileId,
      type: request.type,
      secret: request.secret,
      now,
      approval: {
        action: `restaurant.backOfficeApproval.${request.capability}`,
        requestedByStaffProfileId: request.actingStaffProfileId,
      },
    });
  });
  if (!auth.ok || auth.staffProfileId !== approvingStaffProfileId) return { ok: false };

  if (
    !(await operatorHasCapability(
      db,
      auth.staffProfileId,
      request.capability,
      now,
      request.branchId
    ))
  ) {
    return { ok: false };
  }

  if (!selfApproval) {
    return { ok: true, staffProfileId: auth.staffProfileId, mode: 'SECOND_OPERATOR' };
  }

  await recordOwnerPinReauthentication(db, auth.staffProfileId, request.branchId);
  if (!hasOwnerPinReauthentication(request.actingStaffProfileId, request.deviceId ?? null)) {
    return { ok: false };
  }
  return { ok: true, staffProfileId: auth.staffProfileId, mode: 'OWNER_PIN_REAUTHENTICATION' };
}
