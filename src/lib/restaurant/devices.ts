import 'server-only';

import type { RestaurantRegisteredDevice } from '@/generated/prisma/client';
import {
  generateDeviceSecret as mintDeviceSecret,
  hashDeviceSecret,
  isDeviceSecretFormat as hasDeviceSecretFormat,
} from '@/lib/retail-terminal/device-secret';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type DeviceLifecycleErrorReason = 'NOT_FOUND' | 'REVOKED' | 'STALE_ROTATION';

export class DeviceLifecycleError extends Error {
  constructor(
    message: string,
    readonly reason: DeviceLifecycleErrorReason
  ) {
    super(message);
    this.name = 'DeviceLifecycleError';
  }
}

/**
 * M2-L3 / §5 / C5 — registered-device trust primitives.
 *
 * A registered device is trusted to act as a POS/KDS terminal. Enrollment mints
 * a high-entropy device secret and stores ONLY its hash (`deviceSecretHash`);
 * the raw secret is delivered exactly once, exactly like the invite/reset token
 * (`src/lib/invite-token.ts`) and the API token (`src/lib/api-auth.ts`). There
 * is no separate enrollment-token table in the L1 schema, so enrollment issues
 * the device secret directly — that single delivery IS the "single-use
 * enrollment token" (BUILD-ASSUMPTIONS).
 *
 * Hashing is deterministic SHA-256, NOT bcrypt. The secret is 256 bits of
 * randomness, so a fast hash is the right primitive (a slow salted hash only
 * buys anything for low-entropy secrets like a PIN — those use bcrypt in
 * `operator-credentials.ts`). Determinism is also load-bearing: the
 * `deviceSecretHash` column is globally UNIQUE, and every terminal call must
 * re-resolve the device by its secret in one indexed lookup (C5 — re-check in
 * the DB every call, no trust cache), which a per-row salt would forbid.
 *
 * The pure primitives (generate/hash/format/health/usable) know nothing about
 * the database and are unit-testable on their own; the thin mutation helpers
 * take a tenant-scoped `ScopedDb` and are covered by the DB-gated integration
 * suite and the terminal-transport tests.
 */

// --- Secret primitives (pure) ---------------------------------------------
//
// The primitives themselves live in the neutral retail-terminal seam (PRD §11),
// shared with the Pharmacy counter, because the invariant is identical. Only the
// PREFIX is per-vertical: a `rdk_` secret is a restaurant device secret and
// nothing else. The wrappers below keep this module's public API unchanged.

/** Raw device secrets are prefixed so a malformed bearer token is rejected
 * before any hashing/lookup (mirrors the `df_` API-token convention). */
export const DEVICE_SECRET_PREFIX = 'rdk_';

export {
  hashDeviceSecret,
  isDeviceUsable,
  deviceHealth,
  DEVICE_HEARTBEAT_INTERVAL_MS,
  DEVICE_STALE_AFTER_MS,
} from '@/lib/retail-terminal/device-secret';
export type { DeviceTrustState, DeviceHealth } from '@/lib/retail-terminal/device-secret';

/** True when a string is shaped like a device secret (cheap pre-lookup gate). */
export function isDeviceSecretFormat(token: string): boolean {
  return hasDeviceSecretFormat(token, DEVICE_SECRET_PREFIX);
}

/** Mint a new device secret: the raw value to deliver once, and the hash to store. */
export function generateDeviceSecret(): { secret: string; secretHash: string } {
  return mintDeviceSecret(DEVICE_SECRET_PREFIX);
}

// --- Mutation / lookup helpers (tenant-scoped I/O) -------------------------

/**
 * Enroll a device to a branch. Mints the device secret, stores only its hash,
 * and returns the raw secret ONCE (the caller must surface it to the operator
 * and never persist it). `organizationId` is supplied by the database RLS
 * default from the tenant transaction, so it can never be forged by the caller.
 */
export async function enrollDevice(
  db: ScopedDb,
  input: {
    branchId: string;
    name: string;
    kind?: 'POS' | 'KDS' | 'PRINT_BRIDGE';
    stationId?: string | null;
  }
): Promise<{ device: RestaurantRegisteredDevice; secret: string }> {
  const { secret, secretHash } = generateDeviceSecret();
  const device = await db.restaurantRegisteredDevice.create({
    data: {
      branchId: input.branchId,
      name: input.name,
      deviceSecretHash: secretHash,
      kind: input.kind ?? 'POS',
      stationId: input.stationId ?? null,
    },
  });
  return { device, secret };
}

/**
 * Rotate a device's secret: mint a new one, replace the stored hash (which
 * invalidates the previous secret immediately, since only one hash is stored),
 * and return the new raw secret once. Does not change the device's status.
 */
export async function rotateDeviceSecret(
  db: ScopedDb,
  deviceId: string,
  expectedSecretHash: string
): Promise<{ device: RestaurantRegisteredDevice; secret: string }> {
  return db.$transaction(async (tx) => {
    // The lock and replacement must share one transaction. This makes two
    // simultaneous rotations serialize: the second request observes the
    // already-rotated row and cannot reveal a secret that is no longer valid.
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        status: 'ACTIVE' | 'REVOKED';
        revokedAt: Date | null;
        deviceSecretHash: string;
      }>
    >`
      SELECT id, status, "revokedAt", "deviceSecretHash"
      FROM restaurant_registered_devices
      WHERE id = ${deviceId}
      FOR UPDATE
    `;
    const current = rows[0];
    if (!current) throw new DeviceLifecycleError('Device not found.', 'NOT_FOUND');
    if (current.status !== 'ACTIVE' || current.revokedAt !== null) {
      throw new DeviceLifecycleError('A revoked device cannot be rotated.', 'REVOKED');
    }
    if (current.deviceSecretHash !== expectedSecretHash) {
      throw new DeviceLifecycleError(
        'This device secret was already rotated. Refresh and try again if another rotation is required.',
        'STALE_ROTATION'
      );
    }

    const { secret, secretHash } = generateDeviceSecret();
    const device = await tx.restaurantRegisteredDevice.update({
      where: { id: deviceId },
      data: { deviceSecretHash: secretHash },
    });
    return { device, secret };
  });
}

/**
 * Revoke a device. Flips the durable status to REVOKED and stamps `revokedAt`
 * with the SERVER `now`. Existing terminal sessions are NOT proactively ended:
 * C5 revalidation re-reads this row on every terminal call, so a revoked device
 * is rejected on its very next request without relying on a cache sweep.
 */
export async function revokeDevice(
  db: ScopedDb,
  deviceId: string,
  now: Date
): Promise<RestaurantRegisteredDevice> {
  return db.restaurantRegisteredDevice.update({
    where: { id: deviceId },
    data: { status: 'REVOKED', revokedAt: now },
  });
}

/** Record a device health check-in (`lastSeenAt`). Best-effort; SERVER `now`. */
export async function touchDeviceLastSeen(
  db: ScopedDb,
  deviceId: string,
  now: Date
): Promise<void> {
  await db.restaurantRegisteredDevice.update({
    where: { id: deviceId },
    data: { lastSeenAt: now },
  });
}

/**
 * Resolve a device by its raw secret via the unique hash index. Returns the row
 * (of any status) or null; the caller applies `isDeviceUsable` so that a revoked
 * device is distinguishable from an unknown secret without a second query. Safe
 * to run in the platform scope for tenant discovery (the transport does not know
 * the organization until the device is resolved).
 */
export async function resolveDeviceBySecret(
  db: ScopedDb,
  secret: string
): Promise<RestaurantRegisteredDevice | null> {
  return db.restaurantRegisteredDevice.findUnique({
    where: { deviceSecretHash: hashDeviceSecret(secret) },
  });
}
