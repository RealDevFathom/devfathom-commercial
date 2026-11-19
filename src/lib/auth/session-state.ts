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
  | 'REVOKED'
  | 'DELETED'
  | 'ORGANIZATION_SUSPENDED'
  | 'REVALIDATION_FAILED'
  | 'DEMO_ACCESS_EXPIRED'
  | 'EXPIRED';

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

export const TEMPORARY_PASSWORD_MESSAGE = 'Change your temporary password before continuing.';

/** Authenticated calls a temporary password may still make. */
const TEMPORARY_PASSWORD_ALLOWED_PATHS = new Set(['team.changePassword', 'team.signOutEverywhere']);

export const CHANGE_PASSWORD_PATH = '/change-password';

export class PasswordChangeRequiredError extends Error {
  readonly status = 403 as const;
  readonly code = 'PASSWORD_CHANGE_REQUIRED' as const;

  constructor() {
    super('PASSWORD_CHANGE_REQUIRED');
    this.name = 'PasswordChangeRequiredError';
  }
}

const PASSWORD_CHANGE_API_PROCEDURES = new Set(['team.changePassword', 'team.signOutEverywhere']);

/** Change-password and sign-out requests stay available while the flag is set. */
export function isPasswordChangeApiExempt(request: Request): boolean {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/api/auth/signout') return true;
  if (path === '/api/login' && request.method === 'DELETE') return true;
  if (!path.startsWith('/api/trpc/')) return false;
  const procedures = decodeURIComponent(path.slice('/api/trpc/'.length)).split(',').filter(Boolean);
  return (
    procedures.length > 0 && procedures.every((name) => PASSWORD_CHANGE_API_PROCEDURES.has(name))
  );
}

/**
 * The JSON refusal for an account gate: a temporary password still to change (#164), or
 * (DEV-961) an approval authenticator still to set up. Null for any other error.
 */
export function responseForPasswordChange(error: unknown): Response | null {
  if (
    !(error instanceof PasswordChangeRequiredError) &&
    !(error instanceof ApprovalAuthenticatorSetupRequiredError)
  )
    return null;
  return Response.json({ code: error.code, error: error.message }, { status: error.status });
}

/** Signed-in app pages send a temporary password to the change-password screen. */
export function workspaceRedirectForPasswordChange(
  mustChangePassword: boolean | null | undefined
): string | null {
  return mustChangePassword === true ? CHANGE_PASSWORD_PATH : null;
}

export function temporaryPasswordBlocks(
  user: { mustChangePassword?: boolean | null } | null | undefined,
  path: string
): boolean {
  return user?.mustChangePassword === true && !TEMPORARY_PASSWORD_ALLOWED_PATHS.has(path);
}

/**
 * DEV-961 — authenticator by default. While the organization requires an authenticator for
 * approvals, a member who can approve anything and has not set one up cannot use their
 * account: every page sends them to the set-up screen and every API call, tRPC batch and
 * server action is refused, except the calls the set-up screen itself needs (and changing a
 * temporary password, which comes first, and signing out).
 */
export const APPROVAL_AUTHENTICATOR_SETUP_PATH = '/approval-authenticator-setup';

export const APPROVAL_AUTHENTICATOR_SETUP_MESSAGE =
  'Set up your authenticator app for approvals before continuing.';

const APPROVAL_AUTHENTICATOR_SETUP_PROCEDURES = new Set([
  'approvalAuthenticator.getStatus',
  'approvalAuthenticator.beginEnrollment',
  'approvalAuthenticator.confirmEnrollment',
  'team.changePassword',
  'team.signOutEverywhere',
]);

export class ApprovalAuthenticatorSetupRequiredError extends Error {
  readonly status = 403 as const;
  readonly code = 'APPROVAL_AUTHENTICATOR_SETUP_REQUIRED' as const;

  constructor() {
    super(APPROVAL_AUTHENTICATOR_SETUP_MESSAGE);
    this.name = 'ApprovalAuthenticatorSetupRequiredError';
  }
}

/** Whether a tRPC procedure is refused because the caller must set up an authenticator. */
export function approvalAuthenticatorSetupBlocks(
  user: { approvalAuthenticatorSetupRequired?: boolean | null } | null | undefined,
  path: string
): boolean {
  return (
    user?.approvalAuthenticatorSetupRequired === true &&
    !APPROVAL_AUTHENTICATOR_SETUP_PROCEDURES.has(path)
  );
}

/**
 * Sign-out and the set-up screen's own tRPC calls stay available while set-up is required.
 * A batch is exempt only when every procedure in it is, so a blocked call cannot ride along.
 */
export function isApprovalAuthenticatorSetupApiExempt(request: Request): boolean {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/api/auth/signout') return true;
  if (path === '/api/login' && request.method === 'DELETE') return true;
  if (!path.startsWith('/api/trpc/')) return false;
  let procedures: string[];
  try {
    procedures = decodeURIComponent(path.slice('/api/trpc/'.length)).split(',').filter(Boolean);
  } catch {
    return false;
  }
  return (
    procedures.length > 0 &&
    procedures.every((name) => APPROVAL_AUTHENTICATOR_SETUP_PROCEDURES.has(name))
  );
}

/** Signed-in app pages send a member who must set up an authenticator to the set-up screen. */
export function workspaceRedirectForApprovalAuthenticator(
  approvalAuthenticatorSetupRequired: boolean | null | undefined
): string | null {
  return approvalAuthenticatorSetupRequired === true ? APPROVAL_AUTHENTICATOR_SETUP_PATH : null;
}

/** Query string the login page reads to explain why the session ended. */
export function signInRedirectPath(kind: SessionDenialKind): string {
  return `/login?reason=${kind}`;
}
