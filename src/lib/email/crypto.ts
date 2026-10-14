import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for OAuth refresh tokens at rest.
 *
 * SERVER-ONLY. The key comes from EMAIL_TOKEN_ENC_KEY. Tokens are stored
 * REVERSIBLY (we must decrypt them to call provider APIs) — never hashed — and
 * are never sent to the client. The ciphertext format is `iv:tag:data`, all
 * base64, with a random 96-bit IV per encryption and a GCM auth tag for
 * tamper-detection.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard

/**
 * Derive a stable 32-byte key from EMAIL_TOKEN_ENC_KEY via SHA-256, so any
 * sufficiently-random secret string works (hex, base64, or passphrase) without
 * the caller having to produce exactly 32 raw bytes.
 */
function getKey(): Buffer {
  const secret = process.env.EMAIL_TOKEN_ENC_KEY;
  if (!secret || secret.length < 16) {
    throw new Error(
      'EMAIL_TOKEN_ENC_KEY is missing or too short. Set a strong (32+ char) secret to encrypt mailbox credentials.'
    );
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Encrypt a plaintext secret (e.g. an OAuth refresh token). */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

/** Decrypt a ciphertext produced by {@link encryptToken}. Throws if tampered. */
export function decryptToken(ciphertext: string): string {
  const [ivB64, tagB64, dataB64] = ciphertext.split(':');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed mailbox credential ciphertext.');
  }
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** True when an encryption key is configured (used to surface clear UX errors). */
export function isEmailCryptoConfigured(): boolean {
  return !!process.env.EMAIL_TOKEN_ENC_KEY && process.env.EMAIL_TOKEN_ENC_KEY.length >= 16;
}
