import 'server-only';

import type { PharmacyRegisteredDevice } from '@/generated/prisma/client';
import {
  generateDeviceSecret,
  hashDeviceSecret,
  isDeviceSecretFormat,
  isDeviceUsable,
} from '@/lib/retail-terminal/device-secret';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { pharmacyDeviceSecretExpired, pharmacyDeviceSecretExpiry } from './device-secret-expiry';

/**
 * PH-OFF / OFF-01 — pharmacy counter enrollment.
 *
 * The secret primitives and the trust/health predicates are the neutral
 * retail-terminal seam (PRD §11): the invariant is identical to the Restaurant
 * POS, so there is one implementation and this module supplies only what is NOT
 * identical — the pharmacy prefix, the pharmacy row shape, and the composite
 * `(organizationId, branchId)` keying that the pharmacy branch aggregate uses.
 * Nothing here is a Restaurant router with renamed nouns.
 *
 * Only the SHA-256 hash of the secret is stored; the raw value is returned ONCE
 * and must never be persisted or logged. Revocation is a durable state, re-read
 * from the database on every call, so a revoked counter is refused on its very
 * next request rather than when some cache expires.
 */

export const PHARMACY_DEVICE_SECRET_PREFIX = 'pcd_';

export {
  PHARMACY_DEVICE_SECRET_LIFETIME_DAYS,
  PHARMACY_DEVICE_SECRET_RENEW_WITHIN_DAYS,
  pharmacyDeviceSecretDueForRenewal,
  pharmacyDeviceSecretExpired,
  pharmacyDeviceSecretExpiry,
} from './device-secret-expiry';

export class PharmacyDeviceError extends Error {
  constructor(
    readonly reason: 'NOT_FOUND' | 'REVOKED' | 'STALE_ROTATION' | 'INVALID_NAME' | 'EXPIRED'
  ) {
    super(reason);
    this.name = 'PharmacyDeviceError';
  }
}

export function isPharmacyDeviceSecret(token: string): boolean {
  return isDeviceSecretFormat(token, PHARMACY_DEVICE_SECRET_PREFIX);
}

export type PharmacyDeviceScope = {
  organizationId: string;
  branchId: string;
  actorId: string;
};

/**
 * Enroll a counter. `organizationId` is supplied by the database RLS default
 * from the tenant transaction, so it can never be forged by the caller; the
 * branch is written explicitly because a branch is a scope INSIDE the tenant
 * boundary that row level security cannot separate, and the composite foreign
 * key refuses a branch belonging to another tenant.
 */
export async function enrollPharmacyCounter(
  db: ScopedDb,
  scope: PharmacyDeviceScope,
  input: { name: string }
): Promise<{ device: PharmacyRegisteredDevice; secret: string }> {
  const name = input.name.trim();
  if (name.length === 0) throw new PharmacyDeviceError('INVALID_NAME');

  const { secret, secretHash } = generateDeviceSecret(PHARMACY_DEVICE_SECRET_PREFIX);
  const device = await db.pharmacyRegisteredDevice.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      name,
      kind: 'PHARMACY_COUNTER',
      deviceSecretHash: secretHash,
      enrolledByActorId: scope.actorId,
    },
  });
  return { device, secret };
}

/**
 * Rotate a counter's secret. The lock and the replacement share one transaction,
 * so two simultaneous rotations serialize: the second observes the already
 * rotated row and cannot reveal a secret that is no longer valid.
 */
export async function rotatePharmacyCounterSecret(
  db: ScopedDb,
  scope: PharmacyDeviceScope,
  deviceId: string,
  expectedSecretHash: string,
  options: { now?: Date; requireUnexpired?: boolean } = {}
): Promise<{ device: PharmacyRegisteredDevice; secret: string }> {
  const now = options.now ?? new Date();
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        status: 'ACTIVE' | 'REVOKED';
        revokedAt: Date | null;
        deviceSecretHash: string;
        secretExpiresAt: Date;
      }>
    >`
      SELECT id, status, "revokedAt", "deviceSecretHash", "secretExpiresAt"
      FROM pharmacy_registered_devices
      WHERE id = ${deviceId}
        AND "organizationId" = ${scope.organizationId}
        AND "branchId" = ${scope.branchId}
      FOR UPDATE
    `;
    const current = rows[0];
    if (!current) throw new PharmacyDeviceError('NOT_FOUND');
    if (!isDeviceUsable(current)) throw new PharmacyDeviceError('REVOKED');
    if (current.deviceSecretHash !== expectedSecretHash) {
      throw new PharmacyDeviceError('STALE_ROTATION');
    }
    // DEV-957 phase 2: a counter renewing its own secret must still hold a valid one; an
    // expired counter is rotated by a manager in Settings, Counter computers.
    if (options.requireUnexpired && pharmacyDeviceSecretExpired(current, now)) {
      throw new PharmacyDeviceError('EXPIRED');
    }

    const { secret, secretHash } = generateDeviceSecret(PHARMACY_DEVICE_SECRET_PREFIX);
    const device = await tx.pharmacyRegisteredDevice.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: deviceId } },
      data: { deviceSecretHash: secretHash, secretExpiresAt: pharmacyDeviceSecretExpiry(now) },
    });
    return { device, secret };
  });
}

/**
 * Revoke a counter with a SERVER `now`. The row is kept: what it sold during an
 * outage stays auditable, and its queued commands are refused on replay rather
 * than vanishing with the device.
 */
export async function revokePharmacyCounter(
  db: ScopedDb,
  scope: PharmacyDeviceScope,
  deviceId: string,
  now: Date
): Promise<PharmacyRegisteredDevice> {
  const device = await db.pharmacyRegisteredDevice.findFirst({
    where: { id: deviceId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: { id: true },
  });
  if (!device) throw new PharmacyDeviceError('NOT_FOUND');
  // DEV-957: only the first revoke stamps the time. A second (or concurrent) revoke
  // matches no row here and returns the counter as the first one left it.
  await db.pharmacyRegisteredDevice.updateMany({
    where: { id: deviceId, organizationId: scope.organizationId, revokedAt: null },
    data: { status: 'REVOKED', revokedAt: now },
  });
  return db.pharmacyRegisteredDevice.findFirstOrThrow({
    where: { id: deviceId, organizationId: scope.organizationId },
  });
}

/** Record a counter health check-in. Best-effort; SERVER `now`. */
export async function touchPharmacyCounter(
  db: ScopedDb,
  scope: Pick<PharmacyDeviceScope, 'organizationId'>,
  deviceId: string,
  now: Date
): Promise<void> {
  await db.pharmacyRegisteredDevice.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: deviceId } },
    data: { lastSeenAt: now },
  });
}

/**
 * Resolve a counter by its raw secret via the globally unique hash index.
 * Returns the row of ANY status, so the caller can distinguish a revoked device
 * from an unknown secret without a second query, and applies `isDeviceUsable`
 * itself. A token that is not shaped like a pharmacy device secret is rejected
 * before any lookup.
 */
export async function resolvePharmacyCounterBySecret(
  db: ScopedDb,
  secret: string
): Promise<PharmacyRegisteredDevice | null> {
  if (!isPharmacyDeviceSecret(secret)) return null;
  return db.pharmacyRegisteredDevice.findUnique({
    where: { deviceSecretHash: hashDeviceSecret(secret) },
  });
}
