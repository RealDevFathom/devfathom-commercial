/**
 * Shared-host sign-in budgets that are spent per network address (DEV-932).
 *
 * Several people often sit behind one address (a shop's connection, a mobile
 * carrier), so these are never CLEARED by a sign-in: a fully verified sign-in
 * refunds only the one unit it spent (`refundRateLimit`). Failures and
 * unfinished attempts from the address therefore keep counting, and staff who
 * sign in successfully do not use up each other's allowance.
 */

/**
 * Credential check (/api/login). The strictest per-address budget, so it is the
 * one that caps failed guesses from an address, on one account or sprayed
 * across many.
 */
export const LOGIN_INTENT_RATE_LIMIT = 20;
export const LOGIN_INTENT_RATE_WINDOW_MS = 5 * 60_000;

export function loginIntentRateLimitKey(ip: string | null | undefined): string {
  return `login:intent:${ip ?? 'unknown'}`;
}

/**
 * Never refunded: one credential cannot mint more than LOGIN_INTENT_RATE_LIMIT
 * intents from one address in the window, so a valid password still cannot be
 * used to fill the intent table.
 */
export function loginIntentAccountRateLimitKey(
  ip: string | null | undefined,
  email: string
): string {
  return `login:intent-account:${ip ?? 'unknown'}:${email}`;
}

/** Workspace selection (the `login-intent` provider). */
export const LOGIN_SELECT_RATE_LIMIT = 30;
export const LOGIN_SELECT_RATE_WINDOW_MS = 5 * 60_000;

export function loginSelectRateLimitKey(ip: string | null | undefined): string {
  return `login:select:${ip ?? 'unknown'}`;
}
