import 'server-only';

import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import {
  isApprovalApproverRight,
  type ApprovalApproverRight,
} from '@/lib/approval-approver-rights';
import type { ApprovalAuthenticatorParty } from '@/lib/approval-authenticator-party';
import { holdsAnyApprovalRight } from '@/lib/approval-authenticator-gate';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { decryptSecret } from '@/lib/secret-crypto';
import { matchTotpStep } from '@/lib/totp';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-879 / DEV-961 — how an approval is proven.
 *
 * Every approval that takes a person's PIN (refunds, returns, discounts, Khata over-limit,
 * FEFO overrides, witnesses, purchase approvals, co-authorization, solo self-approval and
 * the rest) still locates the approver's live PIN credential first: it names who approves
 * and carries the durable failed-attempt counters and lockout. Only the secret check is
 * replaced by `verifyApprovalSecret`, and it follows the organization's one setting,
 * "Authenticator for approvals" (`requireApprovalAuthenticator`, on by default):
 *
 *  - ON: an approver with a web login approves with the current 6-digit code from their
 *    authenticator app; their permanent PIN is refused (an approver who has not set up the
 *    app is held on the set-up screen and cannot approve). A staff profile with no web login
 *    (a terminal-only operator) cannot set up an app, so it keeps its PIN; the owner sees
 *    such profiles listed as "Cannot use an authenticator: no login".
 *  - OFF (only the owner can turn it off): everyone approves with their permanent PIN,
 *    whether or not they set up an app. App codes are not accepted while it is off; the
 *    apps stay set up, so turning it on again restores codes without a new set-up.
 *
 * A person re-entering their own PIN to confirm their own action (`purpose: 'OWN_ACTION'`,
 * for example a cashier redeeming a voucher) is a separate case: someone who holds no
 * approver right keeps their own PIN in both modes; someone who holds one confirms the same
 * way they approve.
 *
 * A code is verified here, on the server, against the AES-GCM encrypted secret; the secret
 * never leaves the server. It matches the current 30-second step or one step either side,
 * no wider, and is single use: the accepted step is recorded and any code at or below it
 * is refused, so the same code cannot approve two actions. A refusal returns null and the
 * caller strikes the PIN credential's lockout counter exactly as it does for a wrong PIN,
 * in both modes. Each accepted approval writes one audit row naming the approver, the
 * action, the time and the method (AUTHENTICATOR, PIN, or BADGE for a restaurant operator's
 * badge, which follows the PIN rules); no code, PIN or badge is stored or logged.
 *
 * Self-approval rules are unchanged: every caller decides who may approve (including the
 * solo-owner and sole-pharmacist exceptions) before the secret is checked. Each caller names
 * the approver right its own permission check required (`approverRight`); a right outside the
 * shared registry (`src/lib/approval-approver-rights.ts`) is refused, so the members asked to
 * set up an authenticator are exactly the members who can approve.
 */

/** Steps accepted either side of the server's current time step. */
export const APPROVAL_TOTP_WINDOW = 1;

export type ApprovalSecretMethod = 'PIN' | 'BADGE' | 'AUTHENTICATOR';

export type ApprovalSecretInput = {
  organizationId: string;
  /** The web login behind the approver's staff profile, or null when it has none. */
  approverUserId: string | null | undefined;
  /** The approver's live PIN (or badge) credential hash. */
  credentialHash: string;
  /**
   * DEV-961: the kind of permanent credential `credentialHash` is (a restaurant operator may
   * approve with a badge). A badge is a permanent secret like a PIN: it is accepted exactly
   * where a PIN would be, and refused where an app code is required, since it cannot carry
   * one. Defaults to PIN.
   */
  credentialType?: 'PIN' | 'BADGE';
  /** Auto-detection matched an app code. A mode change must never reinterpret it as a PIN. */
  authenticatorOnly?: boolean;
  /** What the approver entered: their PIN or badge, or a code from their authenticator app. */
  secret: string;
  /** The action being approved, recorded on the audit row (for example a procedure path). */
  action: string;
  /** DEV-961: the approver right the caller's own permission check required of the approver. */
  approverRight: ApprovalApproverRight;
  /**
   * DEV-961: APPROVAL (the default) — the person approves an action, their own or someone
   * else's, under an approver right. OWN_ACTION — the signed-in person re-enters their own
   * PIN to confirm their own action; a person with no approver right keeps the PIN for it.
   */
  purpose?: 'APPROVAL' | 'OWN_ACTION';
  /** The signed-in member who asked for the approval, when known. */
  requestedById?: string | null;
  /** The terminal operator who asked for the approval, when known. */
  requestedByStaffProfileId?: string | null;
  now?: Date;
};

/**
 * DEV-961: what this organization's approvals take, for wording a prompt or a refusal only (the
 * verifier decides): the current app code while "Authenticator for approvals" is on (the
 * default, and when the organization cannot be read), the permanent PIN while it is off.
 */
export async function approvalSecretKindFor(
  db: ScopedDb,
  organizationId: string
): Promise<'CODE' | 'PIN'> {
  const organization = await db.organization.findFirst({
    where: { id: organizationId },
    select: { requireApprovalAuthenticator: true },
  });
  return organization?.requireApprovalAuthenticator === false ? 'PIN' : 'CODE';
}

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
  const organization = await db.organization.findFirst({
    where: { id: input.organizationId },
    select: { requireApprovalAuthenticator: true },
  });
  // Fail closed when the organization cannot be read.
  if (!organization) return null;
  const pinAccepted =
    // OFF: everyone approves with their permanent PIN, whether or not they set up an app.
    !organization.requireApprovalAuthenticator ||
    // ON: a staff profile with no web login cannot set up an app, so it keeps its PIN.
    approverUserId === null ||
    // ON: a person with no approver right confirming their own action keeps their own PIN.
    (input.purpose === 'OWN_ACTION' &&
      !(await holdsAnyApprovalRight(db, {
        organizationId: input.organizationId,
        userId: approverUserId,
        now,
      })));
  const credentialType = input.credentialType ?? 'PIN';
  if (pinAccepted) {
    if (input.authenticatorOnly) return null;
    if (!(await verifyOperatorCredential(credentialType, input.secret, input.credentialHash)))
      return null;
    await recordApproval(db, input, credentialType, approverUserId, now);
    return credentialType;
  }
  // ON, an approver with a web login: only the current code from their app. A badge is a
  // permanent secret and cannot carry a code, so it is refused here like a PIN.
  if (credentialType !== 'PIN') return null;
  const authenticator = await db.approvalAuthenticator.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: approverUserId,
      enabledAt: { not: null },
    },
    select: { id: true, encryptedSecret: true },
  });
  if (!authenticator) return null;
  return (await consumeApprovalCode(db, input, authenticator, approverUserId, now))
    ? 'AUTHENTICATOR'
    : null;
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

/** Non-consuming comparison used only after the caller has checked eligibility and guess budgets. */
export function matchingApprovalStep(
  encryptedSecret: string,
  code: string,
  now: Date
): number | null {
  let secret: string;
  try {
    secret = decryptSecret(encryptedSecret);
  } catch {
    return null;
  }
  return matchTotpStep(secret, code, APPROVAL_TOTP_WINDOW, now.getTime());
}

/** Advance the replay guard without attributing a successful approval. */
export async function retireApprovalStep(db: ScopedDb, authenticatorId: string, step: number) {
  const consumed = await db.approvalAuthenticator.updateMany({
    where: {
      id: authenticatorId,
      enabledAt: { not: null },
      OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
    },
    data: { lastUsedStep: step },
  });
  return consumed.count === 1;
}

async function consumeApprovalCode(
  db: ScopedDb,
  input: ApprovalRecordInput & Pick<ApprovalSecretInput, 'secret'>,
  authenticator: { id: string; encryptedSecret: string },
  approverUserId: string,
  now: Date
): Promise<boolean> {
  const step = matchingApprovalStep(authenticator.encryptedSecret, input.secret, now);
  if (step === null) return false;
  if (!(await retireApprovalStep(db, authenticator.id, step))) return false;
  await recordApproval(db, input, 'AUTHENTICATOR', approverUserId, now);
  return true;
}

type ApprovalRecordInput = Pick<
  ApprovalSecretInput,
  | 'organizationId'
  | 'action'
  | 'approverRight'
  | 'purpose'
  | 'requestedById'
  | 'requestedByStaffProfileId'
>;

/**
 * DEV-961: the one audit row every accepted approval writes, whichever way it was proven,
 * so a PIN approval reads exactly like a code approval except for `approvalMethod`.
 */
async function recordApproval(
  db: ScopedDb,
  input: ApprovalRecordInput,
  method: ApprovalSecretMethod,
  approverUserId: string | null,
  now: Date
): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorId: approverUserId,
      source: 'AUTH',
      category: 'AUTH',
      operation: 'EXECUTE',
      action: input.action,
      description:
        method === 'AUTHENTICATOR'
          ? 'Approved with an authenticator code'
          : method === 'BADGE'
            ? 'Approved with a badge'
            : 'Approved with a PIN',
      targetType: approverUserId ? 'User' : null,
      targetId: approverUserId,
      outcome: 'SUCCESS',
      metadata: {
        approvalMethod: method,
        approvalPurpose: input.purpose ?? 'APPROVAL',
        approverId: approverUserId,
        approvedAction: input.action,
        approverRight: input.approverRight,
        approvedAt: now.toISOString(),
        requestedById: input.requestedById ?? null,
        requestedByStaffProfileId: input.requestedByStaffProfileId ?? null,
      },
    },
  });
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
