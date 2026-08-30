import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import type { RestaurantRegisteredDevice } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

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

/** Raw device secrets are prefixed so a malformed bearer token is rejected
 * before any hashing/lookup (mirrors the `df_` API-token convention). */
export const DEVICE_SECRET_PREFIX = 'rdk_';

/** Deterministic hash of a raw device secret, for storage and O(1) lookup. */
export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** True when a string is shaped like a device secret (cheap pre-lookup gate). */
export function isDeviceSecretFormat(token: string): boolean {
  return token.startsWith(DEVICE_SECRET_PREFIX) && token.length > DEVICE_SECRET_PREFIX.length;
}

/** Mint a new device secret: the raw value to deliver once, and the hash to store. */
export function generateDeviceSecret(): { secret: string; secretHash: string } {
  const secret = `${DEVICE_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { secret, secretHash: hashDeviceSecret(secret) };
}

// --- Trust / health predicates (pure) -------------------------------------

/** The minimal device state the per-call trust check reads (C5). */
export type DeviceTrustState = {
  status: 'ACTIVE' | 'REVOKED';
  revokedAt: Date | null;
};

/**
 * C5 device-side revalidation: a device is usable only while ACTIVE and not
 * revoked. Called with a FRESH database row on every terminal request — a
 * revoked device therefore cannot keep operating from a stale client cache.
 */
export function isDeviceUsable(device: DeviceTrustState): boolean {
  return device.status === 'ACTIVE' && device.revokedAt === null;
}

export type DeviceHealth = 'REVOKED' | 'NEVER_SEEN' | 'STALE' | 'HEALTHY';

/** Expected heartbeat cadence and the staleness floor (D-default, recorded in
 * BUILD-ASSUMPTIONS): a device that has missed five heartbeats reads as STALE. */
export const DEVICE_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEVICE_STALE_AFTER_MS = 5 * DEVICE_HEARTBEAT_INTERVAL_MS;

/**
 * Derive a device's operational health from its durable state and last check-in.
 * `now` is always a SERVER timestamp (client time is untrusted, C5). A revoked
 * device is REVOKED regardless of when it was last seen.
 */
export function deviceHealth(
  device: { status: 'ACTIVE' | 'REVOKED'; revokedAt: Date | null; lastSeenAt: Date | null },
  now: Date
): DeviceHealth {
  if (!isDeviceUsable(device)) return 'REVOKED';
  if (device.lastSeenAt === null) return 'NEVER_SEEN';
  return now.getTime() - device.lastSeenAt.getTime() > DEVICE_STALE_AFTER_MS ? 'STALE' : 'HEALTHY';
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
  input: { branchId: string; name: string; kind?: 'POS' | 'KDS'; stationId?: string | null }
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
  deviceId: string
): Promise<{ device: RestaurantRegisteredDevice; secret: string }> {
  const { secret, secretHash } = generateDeviceSecret();
  const device = await db.restaurantRegisteredDevice.update({
    where: { id: deviceId },
    data: { deviceSecretHash: secretHash },
  });
  return { device, secret };
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
