import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

/**
 * #716 — the owner re-enters their own operator PIN before every export request
 * and every download, because the archive carries patient and khata records.
 *
 * The PIN is the owner's own counter credential (the staff profile linked to
 * their web login): an ACTIVE profile, an unrevoked, device-independent PIN, in
 * this organization only. Wrong PINs use the shared durable lockout counters.
 *
 * The check opens its own tenant transaction rather than taking the caller's
 * client: /api/trpc runs the whole request in one transaction (where
 * `ctx.db.$transaction` re-enters it) and rolls it back when the procedure
 * throws. It never throws for a refusal, so a failed attempt is committed even
 * though the caller then rejects the request.
 */
export type OwnerExportPinResult = 'OK' | 'NO_PIN' | 'REJECTED' | 'LOCKED';

export async function verifyOwnerExportPin(
  input: { organizationId: string; userId: string; pin: string },
  now: Date = new Date()
): Promise<OwnerExportPinResult> {
  return withTenantDb(
    input.organizationId,
    async (tx) => {
      const where = {
        organizationId: input.organizationId,
        type: 'PIN' as const,
        revokedAt: null,
        deviceId: null,
        staffProfile: {
          organizationId: input.organizationId,
          userId: input.userId,
          status: 'ACTIVE' as const,
        },
      };
      const candidate = await tx.restaurantOperatorCredential.findFirst({
        where,
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      });
      if (!candidate) return 'NO_PIN';
      await tx.$queryRaw`SELECT id FROM restaurant_operator_credentials WHERE id=${candidate.id} AND "organizationId"=${input.organizationId} FOR UPDATE`;
      const credential = await tx.restaurantOperatorCredential.findFirst({
        where: { ...where, id: candidate.id },
      });
      if (!credential) return 'NO_PIN';
      if (isLockedOut(credential, now)) return 'LOCKED';
      if (!(await verifyOperatorCredential('PIN', input.pin, credential.credentialHash))) {
        const next = registerFailedAttempt(credential, now);
        await tx.restaurantOperatorCredential.update({ where: { id: credential.id }, data: next });
        return isLockedOut(next, now) ? 'LOCKED' : 'REJECTED';
      }
      await tx.restaurantOperatorCredential.update({
        where: { id: credential.id },
        data: clearLockout(),
      });
      return 'OK';
    },
    { userId: input.userId, maxWait: 5_000, timeout: 10_000, skipDrain: true }
  );
}
