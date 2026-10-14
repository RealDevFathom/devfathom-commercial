/**
 * Session usability — the single decision point for "may this session act?".
 *
 * Issue #16: revocation used to be written into `status`, the same field that
 * carries the tenant `UserStatus` enum (ACTIVE | INACTIVE | ON_LEAVE | INVITED).
 * Overloading one field with two orthogonal facts meant a revoked *session* was
 * reported as a deactivated *account* — opposite remedies, wrong message — and
 * left the door open for a guard to read one fact while another guard read the
 * other. Session revocation now travels as its own claim.
 *
 * Two invariants this module exists to keep:
 *
 *  1. FAIL CLOSED. A session that cannot be proven active is rejected. The old
 *     `if (user.status && ...)` guard silently admitted every session whose
 *     status was missing — the only way the QA report's revoked token could have
 *     read and written tenant data.
 *  2. ONE VERDICT. tRPC middleware, the `/(app)` page guard, and any future
 *     consumer call `evaluateSessionUser` rather than re-deriving the rule, so
 *     they cannot disagree about the same session.
 */
/**
 * Statuses that count as an active member of the company (may use the app).
 * Defined here rather than in the ABAC catalogue so this module stays free of
 * server-side imports and can be shared with the client bundle; `@/lib/abac`
 * re-exports it, so every existing call site is unchanged.
 */
export const ACTIVE_STATUSES = new Set(['ACTIVE', 'ON_LEAVE']);

/** Why a session is no longer usable. Never a `UserStatus` value. */
export type SessionInvalidReason =
  'REVOKED' | 'DELETED' | 'ORGANIZATION_SUSPENDED' | 'REVALIDATION_FAILED' | 'DEMO_ACCESS_EXPIRED';

export const SESSION_ENDED_MESSAGE = 'Your session has ended. Please sign in again.';
export const ACCOUNT_INACTIVE_MESSAGE =
  'Your account is no longer active. Contact your workspace administrator.';
export const WORKSPACE_UNAVAILABLE_MESSAGE = 'This workspace is not currently active.';

export type SessionUserState = {
  status?: string | null;
  sessionRevoked?: boolean | null;
  sessionInvalidReason?: SessionInvalidReason | string | null;
};

/**
 * `session-ended`         → sign in again (revoked, deleted, unverifiable).
 * `account-inactive`      → an administrator must reinstate the account.
 * `workspace-unavailable` → the organization itself is not accessible.
 */
export type SessionDenialKind = 'session-ended' | 'account-inactive' | 'workspace-unavailable';

export type SessionVerdict =
  { ok: true } | { ok: false; kind: SessionDenialKind; message: string; reason: string };

export function liveDemoAccessExpiry(value: unknown, now = Date.now()): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > now ? value : null;
}

const DENIAL_MESSAGES: Record<SessionDenialKind, string> = {
  'session-ended': SESSION_ENDED_MESSAGE,
  'account-inactive': ACCOUNT_INACTIVE_MESSAGE,
  'workspace-unavailable': WORKSPACE_UNAVAILABLE_MESSAGE,
};

function deny(kind: SessionDenialKind, reason: string): SessionVerdict {
  return { ok: false, kind, message: DENIAL_MESSAGES[kind], reason };
}

/**
 * A suspended organization is a workspace-level condition, not a bad session:
 * the remedy is the organization returning to an accessible lifecycle state,
 * not a fresh sign-in. Everything else that invalidates a token ends the
 * session and is recoverable only by signing in again.
 */
function kindForReason(reason: SessionInvalidReason | string): SessionDenialKind {
  return reason === 'ORGANIZATION_SUSPENDED' ? 'workspace-unavailable' : 'session-ended';
}

/**
 * Decide whether a session user may act. Order matters: session validity is
 * checked before account status, because a revoked session must never be
 * reported as a deactivated account.
 */
export function evaluateSessionUser(user: SessionUserState | null | undefined): SessionVerdict {
  if (!user) return deny('session-ended', 'NO_SESSION');

  if (user.sessionRevoked) {
    const reason = user.sessionInvalidReason || 'REVOKED';
    return deny(kindForReason(reason), String(reason));
  }

  // Legacy sentinels: tokens minted before this change wrote the reason into
  // `status`. Honour them so an in-flight revoked token is not admitted during
  // the rollout window.
  if (
    user.status === 'REVOKED' ||
    user.status === 'DELETED' ||
    user.status === 'ORGANIZATION_SUSPENDED' ||
    user.status === 'REVALIDATION_FAILED'
  ) {
    return deny(kindForReason(user.status), user.status);
  }

  // FAIL CLOSED. An absent status is not proof of an active account.
  if (!user.status) return deny('session-ended', 'UNVERIFIED_STATUS');

  if (!ACTIVE_STATUSES.has(user.status)) {
    return deny('account-inactive', user.status);
  }

  return { ok: true };
}

export function isSessionUsable(user: SessionUserState | null | undefined): boolean {
  return evaluateSessionUser(user).ok;
}

/** Query string the login page reads to explain why the session ended. */
export function signInRedirectPath(kind: SessionDenialKind): string {
  return `/login?reason=${kind}`;
}
