import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

/**
 * The RETAIL TERMINAL seam (PRD §11): enrolled-device trust primitives shared by
 * the Restaurant POS/KDS and the Pharmacy counter.
 *
 * This module is an EXTRACTION of the pure half of
 * `src/lib/restaurant/devices.ts`, which now delegates to it. Only the secret and
 * health primitives are here — they are byte-identical between the verticals
 * because the invariant is identical. Everything that touches a table stayed in
 * its vertical: the row shapes, the composite branch keys and the lifecycle
 * mutations are not shared and must not be.
 *
 * Hashing is deterministic SHA-256, NOT bcrypt. The secret is 256 bits of
 * randomness, so a fast hash is the right primitive (a slow salted hash only buys
 * anything for low-entropy secrets like a PIN). Determinism is also load-bearing:
 * the stored hash column is UNIQUE, and every terminal call must re-resolve the
 * device by its secret in one indexed lookup — no trust cache — which a per-row
 * salt would forbid.
 */

/** Raw device secrets are prefixed so a malformed bearer token is rejected before
 * any hashing or lookup (mirrors the `df_` API-token convention). Each vertical
 * owns its own prefix so a secret cannot be presented to the wrong transport. */
export type DeviceSecretPrefix = string;

/** Deterministic hash of a raw device secret, for storage and O(1) lookup. */
export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** True when a string is shaped like a device secret (cheap pre-lookup gate). */
export function isDeviceSecretFormat(token: string, prefix: DeviceSecretPrefix): boolean {
  return token.startsWith(prefix) && token.length > prefix.length;
}

/** Mint a new device secret: the raw value to deliver once, and the hash to store. */
export function generateDeviceSecret(prefix: DeviceSecretPrefix): {
  secret: string;
  secretHash: string;
} {
  const secret = `${prefix}${randomBytes(32).toString('base64url')}`;
  return { secret, secretHash: hashDeviceSecret(secret) };
}

/** The minimal device state the per-call trust check reads. */
export type DeviceTrustState = {
  status: 'ACTIVE' | 'REVOKED';
  revokedAt: Date | null;
};

/**
 * Device-side revalidation: a device is usable only while ACTIVE and not revoked.
 * Called with a FRESH database row on every terminal request — a revoked device
 * therefore cannot keep operating from a stale client cache.
 */
export function isDeviceUsable(device: DeviceTrustState): boolean {
  return device.status === 'ACTIVE' && device.revokedAt === null;
}

export type DeviceHealth = 'REVOKED' | 'NEVER_SEEN' | 'STALE' | 'HEALTHY';

/** Expected heartbeat cadence and the staleness floor: a device that has missed
 * five heartbeats reads as STALE. */
export const DEVICE_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEVICE_STALE_AFTER_MS = 5 * DEVICE_HEARTBEAT_INTERVAL_MS;

/**
 * Derive a device's operational health from its durable state and last check-in.
 * `now` is always a SERVER timestamp (client time is untrusted). A revoked device
 * is REVOKED regardless of when it was last seen.
 */
export function deviceHealth(
  device: { status: 'ACTIVE' | 'REVOKED'; revokedAt: Date | null; lastSeenAt: Date | null },
  now: Date
): DeviceHealth {
  if (!isDeviceUsable(device)) return 'REVOKED';
  if (device.lastSeenAt === null) return 'NEVER_SEEN';
  return now.getTime() - device.lastSeenAt.getTime() > DEVICE_STALE_AFTER_MS ? 'STALE' : 'HEALTHY';
}
