import 'server-only';

import { hashOperatorCredential, type OperatorCredentialType } from './operator-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M2-L2 / §9 / C2 / C4 — operator-credential lifecycle (issue / rotate / revoke)
 * for the back-office server surface.
 *
 * This module is pure orchestration on top of L1's security core: it calls
 * `hashOperatorCredential` (which asserts the D11 policy floor and never returns
 * plaintext) and persists only the hash plus the durable lockout counters. The
 * hashing/verification/lockout math itself is NOT reimplemented here (it stays in
 * `operator-credentials.ts`). Credentials reference a staff profile, never a
 * `User`, so they are structurally unreachable from web login (C2).
 *
 * The schema enforces "at most one active (non-revoked) credential per
 * (organization, staff, type, device)" with a partial unique index; `issue`
 * pre-checks that to return a friendly conflict, and rotation edits the existing
 * row in place rather than racing the index. `organizationId` is supplied by the
 * RLS default on the row and is never forged by the caller.
 */

export type CredentialLifecycleErrorReason =
  'INVALID' | 'STAFF_NOT_FOUND' | 'ALREADY_EXISTS' | 'NOT_FOUND' | 'REVOKED';

export class CredentialLifecycleError extends Error {
  constructor(
    message: string,
    readonly reason: CredentialLifecycleErrorReason
  ) {
    super(message);
    this.name = 'CredentialLifecycleError';
  }
}

export type IssueCredentialInput = {
  /** Granted only by a password-verified approval PIN self-service writer. */
  memberSelectedApprovalPin?: true;
  staffProfileId: string;
  type: OperatorCredentialType;
  secret: string;
  /** Optional device scope; null = valid across the organization's terminals for this operator. */
  deviceId?: string | null;
};

/**
 * Issue a brand-new credential for an operator. Refuses if an active credential
 * of the same type already exists for the same (staff, device) scope — rotate
 * that one instead. The raw secret is hashed via the L1 primitive (which throws
 * `CredentialPolicyError` on a policy violation) and is never persisted or
 * returned in plaintext.
 */
export async function issueOperatorCredential(db: ScopedDb, input: IssueCredentialInput) {
  const staff = await db.restaurantStaffProfile.findUnique({
    where: { id: input.staffProfileId },
    select: { id: true, status: true },
  });
  if (!staff) {
    throw new CredentialLifecycleError('Staff profile not found.', 'STAFF_NOT_FOUND');
  }
  if (staff.status === 'ARCHIVED') {
    throw new CredentialLifecycleError(
      'Cannot issue a credential to an archived staff profile.',
      'INVALID'
    );
  }

  const deviceId = input.deviceId ?? null;
  const existing = await db.restaurantOperatorCredential.findFirst({
    where: { staffProfileId: input.staffProfileId, type: input.type, deviceId, revokedAt: null },
    select: { id: true },
  });
  if (existing) {
    throw new CredentialLifecycleError(
      'An active credential of this type already exists for this operator and device; rotate it instead.',
      'ALREADY_EXISTS'
    );
  }

  // L1 asserts the D11 policy floor and returns only a salted slow hash (C4).
  const credentialHash = await hashOperatorCredential(input.type, input.secret);

  return db.restaurantOperatorCredential.create({
    data: {
      staffProfileId: input.staffProfileId,
      deviceId,
      type: input.type,
      credentialHash,
      approvalPinMustChange:
        input.type === 'PIN' && deviceId === null && !input.memberSelectedApprovalPin,
      failedAttempts: 0,
      lockedUntil: null,
      revokedAt: null,
    },
  });
}

export type RotateCredentialInput = {
  /** Only the password-verified self-service writer can clear the historical marker. */
  memberSelectedApprovalPin?: true;
  credentialId: string;
  secret: string;
};

/**
 * Rotate an existing credential's secret in place: writes the new hash and
 * resets the durable lockout counters (a fresh secret starts with a clean slate,
 * clearing any strikes or active lock). A revoked credential cannot be rotated —
 * issue a new one. The credential's type and device scope are preserved.
 */
export async function rotateOperatorCredential(db: ScopedDb, input: RotateCredentialInput) {
  const existing = await db.restaurantOperatorCredential.findUnique({
    where: { id: input.credentialId },
    select: { id: true, type: true, deviceId: true, revokedAt: true },
  });
  if (!existing) {
    throw new CredentialLifecycleError('Credential not found.', 'NOT_FOUND');
  }
  if (existing.revokedAt) {
    throw new CredentialLifecycleError(
      'A revoked credential cannot be rotated; issue a new one.',
      'REVOKED'
    );
  }

  const credentialHash = await hashOperatorCredential(
    existing.type as OperatorCredentialType,
    input.secret
  );

  return db.restaurantOperatorCredential.update({
    where: { id: input.credentialId },
    data: {
      credentialHash,
      failedAttempts: 0,
      lockedUntil: null,
      approvalPinMustChange:
        existing.type === 'PIN' && existing.deviceId === null && !input.memberSelectedApprovalPin,
    },
  });
}

export type RevokeCredentialInput = {
  credentialId: string;
  /** Server timestamp for the revocation. Client time is untrusted (C5). */
  now?: Date;
};

/**
 * Revoke a credential immediately by stamping `revokedAt` with a server
 * timestamp. Revocation is idempotent: re-revoking an already-revoked credential
 * is a no-op that returns the existing row (a safety operation should never error
 * on a double-invocation), and the recorded `revokedAt` is preserved. The
 * terminal path re-checks `revokedAt` in the DB on every call (C5, enforced in
 * L3), so revocation takes effect without any client cache invalidation.
 */
export async function revokeOperatorCredential(db: ScopedDb, input: RevokeCredentialInput) {
  const existing = await db.restaurantOperatorCredential.findUnique({
    where: { id: input.credentialId },
  });
  if (!existing) {
    throw new CredentialLifecycleError('Credential not found.', 'NOT_FOUND');
  }
  if (existing.revokedAt) return existing;

  const now = input.now ?? new Date();
  return db.restaurantOperatorCredential.update({
    where: { id: input.credentialId },
    data: { revokedAt: now },
  });
}
