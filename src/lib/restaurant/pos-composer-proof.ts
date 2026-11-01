import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type PosComposerClaims = {
  organizationId: string;
  branchId: string;
  deviceId: string;
  sessionId: string;
  staffProfileId: string;
  expiresAt: number;
};

const KEY_PURPOSE = 'devfathom:restaurant:pos-composer-proof:v1';

/** A purpose-bound subkey, so composer proofs never share a MAC key with other AUTH_SECRET uses. */
function proofKey(): Buffer {
  const value = process.env.AUTH_SECRET?.trim();
  if (!value) throw new Error('AUTH_SECRET is required for POS composer proofs.');
  return createHmac('sha256', value).update(KEY_PURPOSE).digest();
}

function signature(payload: string): Buffer {
  return createHmac('sha256', proofKey()).update(`${VERSION}.${payload}`).digest();
}

export function mintPosComposerProof(
  claims: Omit<PosComposerClaims, 'expiresAt'>,
  now = new Date()
): string {
  const payload = Buffer.from(
    JSON.stringify({ ...claims, expiresAt: now.getTime() + MAX_AGE_MS })
  ).toString('base64url');
  return `${VERSION}.${payload}.${signature(payload).toString('base64url')}`;
}

export function verifyPosComposerProof(
  proof: string,
  expected: Omit<PosComposerClaims, 'expiresAt'>,
  now = new Date()
): boolean {
  return verifyProof(proof, expected, now, true);
}

/** Verify signed device/operator continuity across expiry or session replacement. */
export function verifyPosComposerProofForRenewal(
  proof: string,
  expected: Omit<PosComposerClaims, 'expiresAt' | 'sessionId'>,
  now = new Date()
): boolean {
  return verifyProof(proof, expected, now, false);
}

function verifyProof(
  proof: string,
  expected: Omit<PosComposerClaims, 'expiresAt' | 'sessionId'> & { sessionId?: string },
  now: Date,
  enforceExpiry: boolean
): boolean {
  const parts = proof.split('.');
  if (parts.length !== 3) return false;
  const [version, payload, supplied] = parts;
  if (version !== VERSION || !payload || !supplied) return false;
  let actual: Buffer;
  let claims: PosComposerClaims;
  try {
    actual = Buffer.from(supplied, 'base64url');
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PosComposerClaims;
  } catch {
    return false;
  }
  const wanted = signature(payload);
  return (
    actual.length === wanted.length &&
    timingSafeEqual(actual, wanted) &&
    Number.isFinite(claims.expiresAt) &&
    (!enforceExpiry || claims.expiresAt >= now.getTime()) &&
    claims.organizationId === expected.organizationId &&
    claims.branchId === expected.branchId &&
    claims.deviceId === expected.deviceId &&
    (!enforceExpiry || claims.sessionId === expected.sessionId) &&
    claims.staffProfileId === expected.staffProfileId
  );
}
