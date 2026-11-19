import 'server-only';

import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import {
  isApprovalApproverRight,
  type ApprovalApproverRight,
} from '@/lib/approval-approver-rights';
import type { ApprovalAuthenticatorParty } from '@/lib/approval-authenticator-party';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { decryptSecret } from '@/lib/secret-crypto';
import { matchTotpStep } from '@/lib/totp';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-879 — manager and owner approvals accept a rotating authenticator code.
 *
 * Every approval that takes a person's PIN (refunds, returns, discounts, Khata over-limit,
 * FEFO overrides, witnesses, purchase approvals, co-authorization, solo self-approval and
 * the rest) still locates the approver's live PIN credential first: it names who approves
 * and carries the durable failed-attempt counters and lockout. Only the secret check is
 * replaced by `verifyApprovalSecret`:
 *
 *  - an approver who has enrolled an approval authenticator must enter its current
 *    6-digit code; their fixed PIN is no longer accepted;
 *  - an approver who has not enrolled keeps using their PIN, unless the owner turned on
 *    "Require authenticator for approvals" for the organization, which refuses every PIN.
 *
 * A code is verified here, on the server, against the AES-GCM encrypted secret; the secret
 * never leaves the server. It matches the current 30-second step or one step either side,
 * no wider, and is single use: the accepted step is recorded and any code at or below it
 * is refused, so the same code cannot approve two actions. A refusal returns null and the
 * caller strikes the PIN credential's lockout counter exactly as it does for a wrong PIN.
 * Each accepted code writes an audit row naming the approver, the action and the time;
 * the code itself is never stored or logged.
 *
 * Self-approval rules are unchanged: every caller decides who may approve (including the
 * solo-owner and sole-pharmacist exceptions) before the secret is checked.
 *
 * DEV-961: the requirement is on by default. Each caller names the approver right its own
 * permission check required (`approverRight`); a right outside the shared registry
 * (`src/lib/approval-approver-rights.ts`) is refused, so the members asked to set up an
 * authenticator are exactly the members who can approve. A staff profile with no web login
 * (a terminal-only operator) cannot enrol an authenticator, so it keeps its PIN while the
 * requirement is on; the owner sees such profiles listed as "cannot use an authenticator".
 */

/** Steps accepted either side of the server's current time step. */
export const APPROVAL_TOTP_WINDOW = 1;

export type ApprovalSecretMethod = 'PIN' | 'AUTHENTICATOR';

export type ApprovalSecretInput = {
  organizationId: string;
  /** The web login behind the approver's staff profile, or null when it has none. */
  approverUserId: string | null | undefined;
  /** The approver's live PIN credential hash. */
  credentialHash: string;
  /** What the approver entered: their PIN or a code from their authenticator app. */
  secret: string;
  /** The action being approved, recorded on the audit row (for example a procedure path). */
  action: string;
  /** DEV-961: the approver right the caller's own permission check required of the approver. */
  approverRight: ApprovalApproverRight;
  /** The signed-in member who asked for the approval, when known. */
  requestedById?: string | null;
  /** The terminal operator who asked for the approval, when known. */
  requestedByStaffProfileId?: string | null;
  now?: Date;
};

/**
 * Check the approver's PIN or authenticator code. Returns how the approval was proven, or
 * null when it is refused. Never throws for a refusal, so the caller's transaction can
 * commit its lockout strike.
 */
export async function verifyApprovalSecret(
  db: ScopedDb,
  input: ApprovalSecretInput
): Promise<ApprovalSecretMethod | null> {
  const now = input.now ?? new Date();
  const approverUserId = input.approverUserId ?? null;
  // DEV-961: an approval whose right is not in the shared registry is refused, so no route
  // can approve with a right the forced set-up does not know about.
  if (!isApprovalApproverRight(input.approverRight)) return null;
  const [organization, authenticator] = await Promise.all([
    db.organization.findFirst({
      where: { id: input.organizationId },
      select: { requireApprovalAuthenticator: true },
    }),
    approverUserId
      ? db.approvalAuthenticator.findFirst({
          where: {
            organizationId: input.organizationId,
            userId: approverUserId,
            enabledAt: { not: null },
          },
          select: { id: true, encryptedSecret: true },
        })
      : null,
  ]);
  if (authenticator && approverUserId) {
    return (await consumeApprovalCode(db, input, authenticator, approverUserId, now))
      ? 'AUTHENTICATOR'
      : null;
  }
  // Fail closed when the organization cannot be read, and when the owner switched fixed
  // approval PINs off: an approver with a web login must enrol an authenticator first.
  // DEV-961: a staff profile with no web login cannot enrol one, so it keeps its PIN.
  if (!organization || (organization.requireApprovalAuthenticator && approverUserId !== null))
    return null;
  return (await verifyOperatorCredential('PIN', input.secret, input.credentialHash)) ? 'PIN' : null;
}

/**
 * DEV-961: consume a member's own current approval code outside an approval (the owner
 * confirming that approvals go back to PINs). Same window, single use and audit as an
 * approval. Returns false for any refusal, including a member with no authenticator.
 */
export async function consumeMemberApprovalCode(
  db: ScopedDb,
  input: { organizationId: string; userId: string; code: string; action: string; now?: Date }
): Promise<boolean> {
  const now = input.now ?? new Date();
  const authenticator = await db.approvalAuthenticator.findFirst({
    where: { organizationId: input.organizationId, userId: input.userId, enabledAt: { not: null } },
    select: { id: true, encryptedSecret: true },
  });
  if (!authenticator) return false;
  return consumeApprovalCode(
    db,
    {
      organizationId: input.organizationId,
      secret: input.code,
      action: input.action,
      approverRight: 'OWNER',
      requestedById: input.userId,
    },
    authenticator,
    input.userId,
    now
  );
}

async function consumeApprovalCode(
  db: ScopedDb,
  input: Pick<
    ApprovalSecretInput,
    | 'organizationId'
    | 'secret'
    | 'action'
    | 'approverRight'
    | 'requestedById'
    | 'requestedByStaffProfileId'
  >,
  authenticator: { id: string; encryptedSecret: string },
  approverUserId: string,
  now: Date
): Promise<boolean> {
  let secret: string;
  try {
    secret = decryptSecret(authenticator.encryptedSecret);
  } catch {
    return false;
  }
  const step = matchTotpStep(secret, input.secret, APPROVAL_TOTP_WINDOW, now.getTime());
  if (step === null) return false;
  // Single use: only a step newer than the last accepted one is consumed. The guarded
  // update is atomic, so two simultaneous approvals with one code cannot both succeed.
  const consumed = await db.approvalAuthenticator.updateMany({
    where: {
      id: authenticator.id,
      enabledAt: { not: null },
      OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
    },
    data: { lastUsedStep: step },
  });
  if (consumed.count !== 1) return false;
  await db.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorId: approverUserId,
      source: 'AUTH',
      category: 'AUTH',
      operation: 'EXECUTE',
      action: input.action,
      description: 'Approved with an authenticator code',
      targetType: 'User',
      targetId: approverUserId,
      outcome: 'SUCCESS',
      metadata: {
        approvalMethod: 'AUTHENTICATOR',
        approverId: approverUserId,
        approvedAction: input.action,
        approverRight: input.approverRight,
        approvedAt: now.toISOString(),
        requestedById: input.requestedById ?? null,
        requestedByStaffProfileId: input.requestedByStaffProfileId ?? null,
      },
    },
  });
  return true;
}

export {
  approvalAuthenticatorPartySelect,
  type ApprovalAuthenticatorParty,
} from '@/lib/approval-authenticator-party';

/**
 * Who may recover (reset) a member's approval authenticator. Recovery is handled by the
 * owner or an administrator, never by the member alone, so a stolen session cannot quietly
 * fall back to a PIN:
 *   - the owner (the live all-capability identity) may reset anyone, themselves included;
 *   - an administrator may reset only a member below them: never themselves, another
 *     administrator or the owner;
 *   - nobody else may reset anyone.
 * Returns a refusal message, or null when the reset may proceed.
 */
export function approvalAuthenticatorResetDenial(
  actor: ApprovalAuthenticatorParty,
  target: ApprovalAuthenticatorParty
): string | null {
  if (hasAllCapabilityAccess(actor)) return null;
  if (actor.status !== 'ACTIVE' || actor.role !== 'ADMIN')
    return 'Only the owner or an administrator can reset an approval authenticator.';
  if (actor.id === target.id) return 'Ask the owner to reset your approval authenticator.';
  if (hasAllCapabilityAccess(target) || target.role === 'ADMIN')
    return "Only the owner can reset this member's approval authenticator.";
  return null;
}
