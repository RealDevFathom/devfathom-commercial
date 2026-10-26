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

function secret(): string {
  const value = process.env.AUTH_SECRET?.trim();
  if (!value) throw new Error('AUTH_SECRET is required for POS composer proofs.');
  return value;
}

function signature(payload: string): Buffer {
  return createHmac('sha256', secret()).update(`${VERSION}.${payload}`).digest();
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
  const [version, payload, supplied] = proof.split('.');
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
    claims.expiresAt >= now.getTime() &&
    claims.organizationId === expected.organizationId &&
    claims.branchId === expected.branchId &&
    claims.deviceId === expected.deviceId &&
    claims.sessionId === expected.sessionId &&
    claims.staffProfileId === expected.staffProfileId
  );
}
