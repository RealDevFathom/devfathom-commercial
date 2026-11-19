/**
 * DEV-957 phase 1: the browser half of offline snapshot verification.
 *
 * The server signs each snapshot ENVELOPE with Ed25519 (offline-snapshots.ts):
 * the signature covers `envelopeSigningInput(envelope)` as UTF-8, the envelope
 * carries the SHA-256 of the canonical payload, and the counter holds only the
 * raw 32-byte public key (base64url). This module is the WebCrypto
 * `SnapshotVerifier` the runtime injects, plus the payload hash the runtime's
 * key-free envelope check compares.
 *
 * A browser without Ed25519 in SubtleCrypto cannot verify, so it does not run
 * offline at all (`ed25519Supported`); verification is never skipped.
 * Client-safe: no Node imports.
 */
import type { SnapshotVerifier } from './counter-offline-runtime';
import { canonicalJson, envelopeSigningInput } from './offline-snapshot-envelope';

function subtleCrypto(subtle?: SubtleCrypto): SubtleCrypto | null {
  return subtle ?? globalThis.crypto?.subtle ?? null;
}

function bytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

/** base64url (no padding) → bytes; null for anything malformed. */
export function base64UrlBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** An all-zero test key is enough to learn whether Ed25519 import works here. */
export async function ed25519Supported(subtle?: SubtleCrypto): Promise<boolean> {
  const crypto = subtleCrypto(subtle);
  if (!crypto) return false;
  try {
    await crypto.importKey('raw', new Uint8Array(32), { name: 'Ed25519' }, false, ['verify']);
    return true;
  } catch {
    return false;
  }
}

/** Lowercase hex SHA-256 of the canonical payload, as `snapshotPayloadHash`. */
export async function browserSnapshotPayloadHash(
  payload: unknown,
  subtle?: SubtleCrypto
): Promise<string> {
  const crypto = subtleCrypto(subtle);
  if (!crypto) throw new Error('This browser cannot check the signed price list.');
  const digest = await crypto.digest(
    'SHA-256',
    bytes(new TextEncoder().encode(canonicalJson(payload)))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

/**
 * Verifies with WebCrypto Ed25519. A bad key, a bad signature or a browser that
 * refuses the algorithm all answer false: an unverifiable snapshot is refused,
 * never installed.
 */
export function webCryptoSnapshotVerifier(subtle?: SubtleCrypto): SnapshotVerifier {
  const keys = new Map<string, Promise<CryptoKey | null>>();
  return {
    async verify({ envelope, signature, publicKey }) {
      const crypto = subtleCrypto(subtle);
      if (!crypto) return false;
      const raw = base64UrlBytes(publicKey);
      const signed = base64UrlBytes(signature);
      if (!raw || raw.length !== 32 || !signed || signed.length !== 64) return false;
      let key = keys.get(publicKey);
      if (!key) {
        key = crypto
          .importKey('raw', bytes(raw), { name: 'Ed25519' }, false, ['verify'])
          .catch(() => null);
        keys.set(publicKey, key);
      }
      const imported = await key;
      if (!imported) return false;
      try {
        return await crypto.verify(
          { name: 'Ed25519' },
          imported,
          bytes(signed),
          bytes(new TextEncoder().encode(envelopeSigningInput(envelope)))
        );
      } catch {
        return false;
      }
    },
  };
}
