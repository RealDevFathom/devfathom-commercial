import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import type { RestaurantTerminalSession } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { isDeviceUsable, type DeviceTrustState } from '@/lib/restaurant/devices';

/**
 * M2-L3 / §5 / C5 & C6 — terminal-session lifecycle and per-call revalidation.
 *
 * A terminal session is the device-authenticated channel established on a
 * registered device. Its bearer token is stored ONLY as a deterministic SHA-256
 * hash (`tokenHash`, globally unique) — the same high-entropy-bearer-token
 * pattern as the device secret and the invite token, and for the same reason
 * (fast, indexed, single-lookup revalidation on every call).
 *
 * The load-bearing security primitive here is `evaluateTerminalSession` (C5): it
 * is a PURE decision fed FRESH device and session rows on every request, so
 * validity is re-derived in the database each call — device revocation, session
 * end, and idle expiry are all caught immediately, with no trust cache, and
 * every time bound is computed from the SERVER `now` (client time is untrusted).
 *
 * The operator state machine (C6) is deliberately thin: unlocking or switching
 * the active operator BINDS the incoming operator (whose credential the
 * transport has just verified) as the acting identity. A manager
 * co-authorization is a SEPARATE, additive record — it names an approver and
 * never changes who is acting (see `co-authorization.ts`).
 */

// --- Session-token primitives (pure) --------------------------------------

export const TERMINAL_SESSION_TOKEN_PREFIX = 'rts_';

/** Deterministic hash of a raw session token, for storage and O(1) lookup. */
export function hashTerminalSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isTerminalSessionTokenFormat(token: string): boolean {
  return (
    token.startsWith(TERMINAL_SESSION_TOKEN_PREFIX) &&
    token.length > TERMINAL_SESSION_TOKEN_PREFIX.length
  );
}

/** Mint a new session token: the raw value to return once, and the hash to store. */
export function generateTerminalSessionToken(): { token: string; tokenHash: string } {
  const token = `${TERMINAL_SESSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashTerminalSessionToken(token) };
}

// --- State derivation + per-call revalidation (pure, C5/C6) ----------------

/** A session with no bound operator is LOCKED; with one, UNLOCKED. */
export type TerminalSessionState = 'LOCKED' | 'UNLOCKED';

/** The minimal session state the revalidation and state machine read. */
export type TerminalSessionSnapshot = {
  deviceId: string;
  activeStaffProfileId: string | null;
  endedAt: Date | null;
  lastActivityAt: Date;
};

export type TerminalInvalidReason =
  'DEVICE_MISMATCH' | 'DEVICE_REVOKED' | 'SESSION_ENDED' | 'SESSION_EXPIRED';

export type TerminalValidation =
  { ok: true; state: TerminalSessionState } | { ok: false; reason: TerminalInvalidReason };

/**
 * Idle-expiry floor (D-default, recorded in BUILD-ASSUMPTIONS). A session that
 * has seen no activity for a full operating shift must be re-established rather
 * than trusted indefinitely, so a leaked token cannot live forever. Computed
 * from server timestamps only.
 */
export const SESSION_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** Derive the lock state of a live (non-ended) session. */
export function terminalSessionState(session: {
  activeStaffProfileId: string | null;
}): TerminalSessionState {
  return session.activeStaffProfileId === null ? 'LOCKED' : 'UNLOCKED';
}

/**
 * C5 — re-derive whether a terminal session may act, from FRESH rows. Rejects a
 * session whose device was revoked, whose token belongs to a different device,
 * that has been ended, or that has idled past the timeout. Fails closed: any
 * doubt is a rejection, never a fallthrough to "valid".
 */
export function evaluateTerminalSession(
  session: TerminalSessionSnapshot,
  device: DeviceTrustState & { id: string },
  now: Date
): TerminalValidation {
  if (session.deviceId !== device.id) return { ok: false, reason: 'DEVICE_MISMATCH' };
  if (!isDeviceUsable(device)) return { ok: false, reason: 'DEVICE_REVOKED' };
  if (session.endedAt !== null) return { ok: false, reason: 'SESSION_ENDED' };
  if (now.getTime() - session.lastActivityAt.getTime() > SESSION_IDLE_TIMEOUT_MS) {
    return { ok: false, reason: 'SESSION_EXPIRED' };
  }
  return { ok: true, state: terminalSessionState(session) };
}

export class TerminalSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalSessionError';
  }
}

/**
 * C6 guard — an operator may only be bound (unlock) or switched on a live
 * session. A session that has ended cannot silently accept a new operator.
 * Throws `TerminalSessionError`; the transport translates it to a 409.
 */
export function assertOperatorBindable(session: { endedAt: Date | null }): void {
  if (session.endedAt !== null) {
    throw new TerminalSessionError('This terminal session has ended and must be re-established.');
  }
}

// --- Lifecycle helpers (tenant-scoped I/O) --------------------------------

/**
 * Establish a new terminal session on a device. The session starts LOCKED (no
 * operator bound); an operator is added later via `bindOperator` (unlock/switch)
 * after their credential is verified. Returns the raw session token ONCE.
 */
export async function establishSession(
  db: ScopedDb,
  deviceId: string,
  now: Date
): Promise<{ session: RestaurantTerminalSession; token: string }> {
  const { token, tokenHash } = generateTerminalSessionToken();
  const session = await db.restaurantTerminalSession.create({
    data: { deviceId, tokenHash, establishedAt: now, lastActivityAt: now },
  });
  return { session, token };
}

/** Resolve a session by its raw token via the unique hash index. */
export async function resolveSessionByToken(
  db: ScopedDb,
  token: string
): Promise<RestaurantTerminalSession | null> {
  return db.restaurantTerminalSession.findUnique({
    where: { tokenHash: hashTerminalSessionToken(token) },
  });
}

/**
 * Bind the acting operator (C6 unlock/switch). The caller must have verified the
 * incoming operator's credential first and revalidated the session
 * (`assertOperatorBindable`). Also refreshes `lastActivityAt` with the SERVER
 * `now`.
 */
export async function bindOperator(
  db: ScopedDb,
  sessionId: string,
  staffProfileId: string,
  now: Date
): Promise<RestaurantTerminalSession> {
  return db.restaurantTerminalSession.update({
    where: { id: sessionId },
    data: { activeStaffProfileId: staffProfileId, lastActivityAt: now },
  });
}

/** Lock a terminal — clear the active operator but keep the session established. */
export async function lockSession(
  db: ScopedDb,
  sessionId: string,
  now: Date
): Promise<RestaurantTerminalSession> {
  return db.restaurantTerminalSession.update({
    where: { id: sessionId },
    data: { activeStaffProfileId: null, lastActivityAt: now },
  });
}

/** An operator access refusal clears the binding without refreshing idle time. */
export async function lockDeniedOperator(db: ScopedDb, sessionId: string) {
  await db.restaurantTerminalSession.update({
    where: { id: sessionId },
    data: { activeStaffProfileId: null },
  });
}

/** End a terminal session — stamps `endedAt`; every later call fails C5. */
export async function endSession(
  db: ScopedDb,
  sessionId: string,
  now: Date
): Promise<RestaurantTerminalSession> {
  return db.restaurantTerminalSession.update({
    where: { id: sessionId },
    data: { endedAt: now, activeStaffProfileId: null, lastActivityAt: now },
  });
}

/** Record terminal activity (heartbeat); refreshes the idle-expiry clock. */
export async function touchSession(
  db: ScopedDb,
  sessionId: string,
  now: Date
): Promise<RestaurantTerminalSession> {
  return db.restaurantTerminalSession.update({
    where: { id: sessionId },
    data: { lastActivityAt: now },
  });
}
