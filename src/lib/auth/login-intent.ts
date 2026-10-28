import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

/**
 * D8 — the pending shared-host login.
 *
 * A submitted organization id is never authority on its own
 * (docs/admin-platform/api.md). Between "the password is proven" and "an
 * organization has been chosen" the server holds the answer, and the browser
 * holds only an opaque handle to it.
 *
 * This copies the `df_sso_ticket` pattern verbatim, because that pattern is
 * already correct: 32 random bytes, only the SHA-256 hash stored, single use via
 * a conditional `updateMany` guarded on `usedAt: null`, and a short TTL. Two
 * additions for the shared host:
 *
 *  - the minting HOST is recorded and re-checked on consumption, so an intent
 *    cannot be replayed on the admin host or on a tenant host;
 *  - the candidate SET is recorded, so selection can only ever choose an
 *    organization the server itself already decided this password unlocks.
 */
export const LOGIN_INTENT_COOKIE = 'df_login_intent';
export const LOGIN_INTENT_TTL_MS = 5 * 60_000;

export type LoginIntentCandidate = {
  organizationId: string;
  userId: string;
  demoAccessExpiresAt?: number;
  tokenVersion?: number;
};

export type ConsumedLoginIntent = {
  id: string;
  email: string;
  userId: string;
  organizationId: string;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createLoginIntent(input: {
  email: string;
  host: string;
  candidates: LoginIntentCandidate[];
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + LOGIN_INTENT_TTL_MS);

  await withPlatformDb((db) =>
    db.pendingLoginIntent.create({
      data: {
        tokenHash: hashToken(token),
        email: input.email,
        host: input.host,
        candidates: input.candidates,
        expiresAt,
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 500) ?? null,
      },
    })
  );

  return { token, expiresAt };
}

/**
 * Read an intent without consuming it, so the selection screen can render.
 * Returns null for a missing, expired, already-used, or wrong-host intent.
 */
export async function peekLoginIntent(
  token: string | null | undefined,
  host: string
): Promise<{ email: string; candidates: LoginIntentCandidate[] } | null> {
  if (!token || token.length < 32 || token.length > 128) return null;

  const intent = await withPlatformDb((db) =>
    db.pendingLoginIntent.findFirst({
      where: { tokenHash: hashToken(token), usedAt: null, expiresAt: { gt: new Date() } },
      select: { email: true, host: true, candidates: true },
    })
  );
  if (!intent || intent.host !== host) return null;

  return { email: intent.email, candidates: readCandidates(intent.candidates) };
}

/**
 * Consume the intent for one organization.
 *
 * The submitted `organizationId` is checked against the stored candidate set
 * BEFORE anything is marked used, so a forged id fails without burning a valid
 * intent. The update is conditional on `usedAt: null` and asserts it changed
 * exactly one row, which is what makes replay impossible under a race.
 */
export async function consumeLoginIntent(
  token: string | null | undefined,
  host: string,
  organizationId: string
): Promise<ConsumedLoginIntent | null> {
  if (!token || token.length < 32 || token.length > 128) return null;
  if (!organizationId) return null;

  return withPlatformDb(async (db) => {
    const intent = await db.pendingLoginIntent.findFirst({
      where: { tokenHash: hashToken(token), usedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, host: true, candidates: true },
    });
    if (!intent) return null;
    if (intent.host !== host) return null;

    const match = readCandidates(intent.candidates).find(
      (candidate) => candidate.organizationId === organizationId
    );
    if (!match) return null;

    const consumed = await db.pendingLoginIntent.updateMany({
      where: { id: intent.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) return null;

    return {
      id: intent.id,
      email: intent.email,
      userId: match.userId,
      organizationId: match.organizationId,
    };
  });
}

/** Best-effort invalidation, e.g. on sign-out (D-7 of the flow: state is cleared). */
export async function discardLoginIntent(token: string | null | undefined): Promise<void> {
  if (!token || token.length < 32 || token.length > 128) return;
  await withPlatformDb((db) =>
    db.pendingLoginIntent.updateMany({
      where: { tokenHash: hashToken(token), usedAt: null },
      data: { usedAt: new Date() },
    })
  ).catch(() => undefined);
}

export function loginIntentCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    // Deliberately NO domain attribute: host-only, exactly like df_sso_ticket and
    // the Auth.js cookies. A domain-scoped intent would be replayable across
    // every host under the base domain.
    expires: expiresAt,
  };
}

export function clearedLoginIntentCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
  };
}

function readCandidates(value: unknown): LoginIntentCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const organizationId = record.organizationId;
    const userId = record.userId;
    if (typeof organizationId !== 'string' || typeof userId !== 'string') return [];
    const demoAccessExpiresAt = record.demoAccessExpiresAt;
    return [
      {
        organizationId,
        userId,
        ...(typeof record.tokenVersion === 'number' && Number.isSafeInteger(record.tokenVersion)
          ? { tokenVersion: record.tokenVersion }
          : {}),
        ...(typeof demoAccessExpiresAt === 'number' && Number.isFinite(demoAccessExpiresAt)
          ? { demoAccessExpiresAt }
          : {}),
      },
    ];
  });
}
