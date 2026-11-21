import 'server-only';

import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
} from '@/lib/restaurant/operator-credentials';
import { verifyApprovalSecret } from '@/lib/approval-authenticator';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-783 — the owner re-enters their own PIN before every export request and
 * every download, because the archive carries patient, khata and
 * controlled-register records.
 *
 * The PIN is the owner's own operator credential: the staff profile linked to
 * their web login, ACTIVE, an unrevoked device-independent PIN, in this
 * organization only. Wrong PINs strike the same durable lockout counters as the
 * counter and approval PINs, so guesses here and there add up to one lockout.
 *
 * The check runs in its own tenant transaction and never throws for a refusal,
 * so a wrong-PIN strike is committed even though the caller then refuses the
 * request.
 */
export type OwnerExportPinResult = 'OK' | 'NO_PIN' | 'REJECTED' | 'LOCKED';

/** Longest PIN text worth hashing; anything longer is refused before bcrypt. */
export const OWNER_EXPORT_PIN_MAX_INPUT = 64;

/**
 * The PIN from a request body exactly as typed (PINs are never normalised), or
 * null when it is missing or too long to be one. Any other wrong value is a
 * real guess and is verified, so it strikes the lockout counter.
 */
export function readOwnerExportPin(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= OWNER_EXPORT_PIN_MAX_INPUT
    ? value
    : null;
}

export async function verifyOwnerExportPin(
  input: {
    organizationId: string;
    userId: string;
    pin: string;
    /** The approval action recorded with the PIN check (DEV-911 reuses this owner PIN). */
    action?: string;
  },
  now: Date = new Date()
): Promise<OwnerExportPinResult> {
  const { organizationId, userId, pin } = input;
  const action = input.action ?? 'pharmacy.ownerDataExport';
  return withTenantDb(
    organizationId,
    async (tx) => {
      // Serialize strikes even for simultaneous guesses at the same owner's PIN.
      await tx.$queryRaw`SELECT c.id FROM restaurant_operator_credentials c JOIN restaurant_staff_profiles s ON s.id=c."staffProfileId" AND s."organizationId"=c."organizationId" WHERE c."organizationId"=${organizationId} AND s."userId"=${userId} AND c.type='PIN' AND c."revokedAt" IS NULL AND c."deviceId" IS NULL ORDER BY c.id FOR UPDATE OF c`;
      const credential = await tx.restaurantOperatorCredential.findFirst({
        where: {
          organizationId,
          type: 'PIN',
          revokedAt: null,
          deviceId: null,
          staffProfile: { organizationId, userId, status: 'ACTIVE' },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (!credential) return 'NO_PIN';
      if (isLockedOut(credential, now)) return 'LOCKED';
      if (
        !(await verifyApprovalSecret(tx, {
          organizationId,
          approverUserId: userId,
          credentialHash: credential.credentialHash,
          secret: pin,
          action,
          approverRight: 'OWNER',
          requestedById: userId,
          now,
        }))
      ) {
        const next = registerFailedAttempt(credential, now);
        await tx.restaurantOperatorCredential.update({
          where: { id: credential.id },
          data: next,
        });
        return isLockedOut(next, now) ? 'LOCKED' : 'REJECTED';
      }
      await tx.restaurantOperatorCredential.update({
        where: { id: credential.id },
        data: clearLockout(),
      });
      return 'OK';
    },
    { userId, maxWait: 5_000, timeout: 10_000, skipDrain: true }
  );
}
