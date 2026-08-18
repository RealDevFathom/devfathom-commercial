import { describe, expect, it } from 'vitest';

import {
  DEVICE_SECRET_PREFIX,
  DEVICE_STALE_AFTER_MS,
  deviceHealth,
  generateDeviceSecret,
  hashDeviceSecret,
  isDeviceSecretFormat,
  isDeviceUsable,
} from './devices';

describe('device secret primitives', () => {
  it('hashes deterministically (so a device is resolvable by one indexed lookup)', () => {
    expect(hashDeviceSecret('rdk_abc')).toBe(hashDeviceSecret('rdk_abc'));
    expect(hashDeviceSecret('rdk_abc')).not.toBe(hashDeviceSecret('rdk_abd'));
    // SHA-256 hex is 64 chars.
    expect(hashDeviceSecret('rdk_abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints a prefixed, high-entropy secret whose stored hash matches', () => {
    const { secret, secretHash } = generateDeviceSecret();
    expect(secret.startsWith(DEVICE_SECRET_PREFIX)).toBe(true);
    expect(secret.length).toBeGreaterThan(DEVICE_SECRET_PREFIX.length + 32);
    expect(secretHash).toBe(hashDeviceSecret(secret));
  });

  it('mints a distinct secret each time', () => {
    const a = generateDeviceSecret();
    const b = generateDeviceSecret();
    expect(a.secret).not.toBe(b.secret);
    expect(a.secretHash).not.toBe(b.secretHash);
  });

  it('accepts only well-formed device tokens (cheap pre-lookup gate)', () => {
    expect(isDeviceSecretFormat(generateDeviceSecret().secret)).toBe(true);
    expect(isDeviceSecretFormat('df_something')).toBe(false);
    expect(isDeviceSecretFormat(DEVICE_SECRET_PREFIX)).toBe(false); // prefix only, no body
    expect(isDeviceSecretFormat('')).toBe(false);
  });
});

describe('isDeviceUsable (C5 device-side revalidation)', () => {
  it('is true only for an ACTIVE, non-revoked device', () => {
    expect(isDeviceUsable({ status: 'ACTIVE', revokedAt: null })).toBe(true);
  });

  it('is false once the device is revoked, by status or timestamp', () => {
    const now = new Date('2026-08-18T12:00:00.000Z');
    expect(isDeviceUsable({ status: 'REVOKED', revokedAt: now })).toBe(false);
    // Defense in depth: a stamped revokedAt disqualifies even if status lagged.
    expect(isDeviceUsable({ status: 'ACTIVE', revokedAt: now })).toBe(false);
  });
});

describe('deviceHealth', () => {
  const now = new Date('2026-08-18T12:00:00.000Z');

  it('reports REVOKED regardless of last check-in', () => {
    expect(deviceHealth({ status: 'REVOKED', revokedAt: now, lastSeenAt: now }, now)).toBe(
      'REVOKED'
    );
  });

  it('reports NEVER_SEEN for an enrolled device that has not checked in', () => {
    expect(deviceHealth({ status: 'ACTIVE', revokedAt: null, lastSeenAt: null }, now)).toBe(
      'NEVER_SEEN'
    );
  });

  it('reports HEALTHY within the staleness window and STALE beyond it', () => {
    const justSeen = new Date(now.getTime() - DEVICE_STALE_AFTER_MS + 1_000);
    const longAgo = new Date(now.getTime() - DEVICE_STALE_AFTER_MS - 1_000);
    expect(deviceHealth({ status: 'ACTIVE', revokedAt: null, lastSeenAt: justSeen }, now)).toBe(
      'HEALTHY'
    );
    expect(deviceHealth({ status: 'ACTIVE', revokedAt: null, lastSeenAt: longAgo }, now)).toBe(
      'STALE'
    );
  });
});
