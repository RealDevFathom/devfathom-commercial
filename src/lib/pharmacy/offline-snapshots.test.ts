/**
 * PH-OFF / OFF-01 — the signed-snapshot envelope and its Ed25519 signature.
 *
 * These cases are about what a counter can PROVE about a snapshot with no
 * network: that the bytes it verified are the bytes it holds, that the snapshot
 * was addressed to it, and that its window has not closed. The cryptographic
 * cases deliberately tamper with one field at a time, because a signature that
 * only covers some of the envelope is worse than none — it reads as protection.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalJson, checkEnvelope, envelopeSigningInput } from './offline-snapshot-envelope';
import type { OfflineSnapshotEnvelope } from './offline-snapshot-envelope';

process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

type Signing = typeof import('./offline-snapshots');
let signing: Signing;

beforeAll(async () => {
  signing = await import('./offline-snapshots');
});

const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', deviceId: 'counter_1' };
const ISSUED_AT = '2026-09-02T09:00:00.000Z';
const EXPIRES_AT = '2026-09-02T21:00:00.000Z';
const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const SAFETY_LEASE = {
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
  recallVersion: 0,
  licenceVersion: 1,
  ruleVersion: 1,
  recalledBatchIds: [],
};

const PAYLOAD = { medicines: [{ id: 'med_1', priceMinor: 25_000 }], version: 4 };

function envelope(overrides: Partial<OfflineSnapshotEnvelope> = {}): OfflineSnapshotEnvelope {
  return {
    ...SCOPE,
    kind: 'PRICES',
    version: 3,
    payloadHash: signing.snapshotPayloadHash(PAYLOAD),
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    safetyLease: SAFETY_LEASE,
    signingKeyId: signing.SNAPSHOT_SIGNING_KEY_ID,
    ...overrides,
  };
}

describe('canonical serialization', () => {
  it('is stable under key order, so signer and verifier see the same bytes', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('drops undefined and preserves array order', () => {
    expect(canonicalJson({ a: undefined, b: [3, 1, 2] })).toBe('{"b":[3,1,2]}');
  });

  it('refuses a non-finite number rather than serializing it as null', () => {
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('projects the envelope onto exactly the signed fields', () => {
    const withExtra = { ...envelope(), notSigned: 'ignored' } as OfflineSnapshotEnvelope;
    expect(envelopeSigningInput(withExtra)).toBe(envelopeSigningInput(envelope()));
  });
});

describe('PH-OFF OFF-01 — snapshot signatures', () => {
  it('verifies a snapshot it just signed', () => {
    const value = envelope();
    expect(signing.verifySnapshotSignature(value, signing.signSnapshotEnvelope(value))).toBe(true);
  });

  it('the public half is not the private half: a counter can verify, not mint', () => {
    // 32 raw bytes, base64url — safe to hand to a device and to persist.
    expect(Buffer.from(signing.snapshotPublicKey(), 'base64url')).toHaveLength(32);
  });

  it.each([
    ['organizationId', { organizationId: 'org_b' }],
    ['branchId', { branchId: 'branch_b' }],
    ['deviceId', { deviceId: 'counter_2' }],
    ['kind', { kind: 'LICENCE' as const }],
    ['version', { version: 4 }],
    ['payloadHash', { payloadHash: 'f'.repeat(64) }],
    ['issuedAt', { issuedAt: '2026-09-01T09:00:00.000Z' }],
    ['expiresAt', { expiresAt: '2026-09-09T21:00:00.000Z' }],
    ['safetyLease', { safetyLease: { ...SAFETY_LEASE, recallVersion: 9 } }],
    ['signingKeyId', { signingKeyId: 'someone-elses-key' }],
  ])('refuses a signature after %s is tampered with', (_field, patch) => {
    const original = envelope();
    const signature = signing.signSnapshotEnvelope(original);
    const tampered = envelope(patch as Partial<OfflineSnapshotEnvelope>);
    expect(signing.verifySnapshotSignature(tampered, signature)).toBe(false);
  });

  it('refuses a signature made by a different key', () => {
    const value = envelope();
    const signature = signing.signSnapshotEnvelope(value);
    const strangerKey = Buffer.from(
      '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
      'hex'
    ).toString('base64url');
    expect(signing.verifySnapshotSignature(value, signature, strangerKey)).toBe(false);
  });

  it('returns false, rather than throwing, for a malformed signature', () => {
    expect(signing.verifySnapshotSignature(envelope(), 'not-a-signature')).toBe(false);
  });

  it('rejects a public key that is not an Ed25519 key at all', () => {
    expect(() =>
      signing.verifySnapshotSignature(envelope(), signing.signSnapshotEnvelope(envelope()), 'AAAA')
    ).toThrow(signing.PharmacySnapshotError);
  });

  it('changing the payload changes the hash the signature covers', () => {
    const first = signing.snapshotPayloadHash(PAYLOAD);
    const second = signing.snapshotPayloadHash({ ...PAYLOAD, version: 5 });
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('PH-OFF OFF-01 — envelope checks a counter can run without the key', () => {
  const hash = () => signing.snapshotPayloadHash(PAYLOAD);

  it('accepts a snapshot addressed to this counter, in window, not older', () => {
    expect(
      checkEnvelope({
        envelope: envelope(),
        scope: SCOPE,
        nowMs: NOW,
        heldVersion: 2,
        payloadHash: hash(),
      })
    ).toEqual({ ok: true });
  });

  it('accepts a re-delivery of the version already held', () => {
    expect(
      checkEnvelope({
        envelope: envelope(),
        scope: SCOPE,
        nowMs: NOW,
        heldVersion: 3,
        payloadHash: hash(),
      })
    ).toEqual({ ok: true });
  });

  it('refuses a snapshot minted for another counter', () => {
    expect(
      checkEnvelope({
        envelope: envelope({ deviceId: 'counter_2' }),
        scope: SCOPE,
        nowMs: NOW,
        heldVersion: null,
        payloadHash: hash(),
      })
    ).toMatchObject({ ok: false, reason: 'SCOPE_MISMATCH' });
  });

  it('refuses a snapshot minted for another tenant', () => {
    expect(
      checkEnvelope({
        envelope: envelope({ organizationId: 'org_b' }),
        scope: SCOPE,
        nowMs: NOW,
        heldVersion: null,
        payloadHash: hash(),
      })
    ).toMatchObject({ ok: false, reason: 'SCOPE_MISMATCH' });
  });

  it('refuses a payload that is not the one the envelope hashes', () => {
    expect(
      checkEnvelope({
        envelope: envelope(),
        scope: SCOPE,
        nowMs: NOW,
        heldVersion: null,
        payloadHash: signing.snapshotPayloadHash({ ...PAYLOAD, version: 99 }),
      })
    ).toMatchObject({ ok: false, reason: 'PAYLOAD_MISMATCH' });
  });

  it('refuses an expired snapshot', () => {
    expect(
      checkEnvelope({
        envelope: envelope(),
        scope: SCOPE,
        nowMs: Date.parse(EXPIRES_AT),
        heldVersion: null,
        payloadHash: hash(),
      })
    ).toMatchObject({ ok: false, reason: 'EXPIRED' });
  });

  it('refuses a snapshot from the future (a skewed counter clock)', () => {
    expect(
      checkEnvelope({
        envelope: envelope(),
        scope: SCOPE,
        nowMs: Date.parse(ISSUED_AT) - 1,
        heldVersion: null,
        payloadHash: hash(),
      })
    ).toMatchObject({ ok: false, reason: 'NOT_YET_VALID' });
  });

  it('does not let clock skew widen the safety lease at either boundary', () => {
    expect(
      checkEnvelope({
        envelope: envelope(),
        scope: SCOPE,
        nowMs: Date.parse(ISSUED_AT) - 1,
        heldVersion: null,
        payloadHash: hash(),
      })
    ).toMatchObject({ ok: false, reason: 'NOT_YET_VALID' });
    expect(
      checkEnvelope({
        envelope: envelope(),
        scope: SCOPE,
        nowMs: Date.parse(SAFETY_LEASE.expiresAt),
        heldVersion: null,
        payloadHash: hash(),
      })
    ).toMatchObject({ ok: false, reason: 'EXPIRED' });
  });

  it('refuses an older version, so a replayed envelope cannot roll prices back', () => {
    expect(
      checkEnvelope({
        envelope: envelope({ version: 2 }),
        scope: SCOPE,
        nowMs: NOW,
        heldVersion: 3,
        payloadHash: hash(),
      })
    ).toMatchObject({ ok: false, reason: 'STALE_VERSION' });
  });

  it('refuses a malformed envelope', () => {
    expect(
      checkEnvelope({
        envelope: envelope({ payloadHash: 'nope' }),
        scope: SCOPE,
        nowMs: NOW,
        heldVersion: null,
        payloadHash: 'nope',
      })
    ).toMatchObject({ ok: false, reason: 'MALFORMED' });
    expect(
      checkEnvelope({
        envelope: envelope({ expiresAt: ISSUED_AT }),
        scope: SCOPE,
        nowMs: NOW,
        heldVersion: null,
        payloadHash: hash(),
      })
    ).toMatchObject({ ok: false, reason: 'MALFORMED' });
  });
});
