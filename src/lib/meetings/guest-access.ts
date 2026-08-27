import 'server-only';

import { hashGuestSecret } from './occurrences';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

/** Resolve a guest credential without exposing whether the locator or secret was wrong. */
export async function authorizeGuestOccurrence(publicId: string, secret: string, now = new Date()) {
  if (publicId.length < 8 || publicId.length > 128 || secret.length < 32 || secret.length > 512) {
    return null;
  }
  const guestTokenHash = hashGuestSecret(secret);
  const resolved = await withPlatformDb((db) =>
    db.meetingOccurrenceParticipant.findUnique({
      where: { guestTokenHash },
      select: {
        organizationId: true,
        guestTokenExpiresAt: true,
        guestTokenRevokedAt: true,
        occurrence: { select: { publicId: true } },
      },
    })
  );
  if (
    !resolved ||
    resolved.occurrence.publicId !== publicId ||
    !resolved.guestTokenExpiresAt ||
    resolved.guestTokenExpiresAt <= now ||
    resolved.guestTokenRevokedAt
  ) {
    return null;
  }

  return withTenantDb(resolved.organizationId, (db) =>
    db.meetingOccurrence.findUnique({
      where: { publicId },
      select: {
        publicId: true,
        scheduledStart: true,
        scheduledEnd: true,
        joinOpensAt: true,
        joinClosesAt: true,
        status: true,
        meeting: { select: { title: true } },
      },
    })
  );
}
