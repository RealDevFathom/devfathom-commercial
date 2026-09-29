/**
 * WHA-1623 — the outcome of a sign-in that was submitted before the page
 * hydrated.
 *
 * `/login/submit` redirects back to `/login?loginError=<key>` and the page turns
 * the key into the SAME sentence the hydrated form would have shown. Only these
 * keys are accepted, so the query string can never carry caller-authored text
 * onto the page.
 */
export const LOGIN_ERROR_MESSAGES = {
  invalid: 'Invalid email or password. Please try again.',
  suspended: 'Your account has been suspended. Please contact your workspace administrator.',
  'sso-required': 'Password sign-in is disabled. Use your organization identity provider.',
  '2fa-required': 'Enter the 6-digit code from your authenticator app.',
  '2fa-invalid': 'That code is incorrect or expired. Try again, or use a recovery code.',
  'rate-limited':
    'Too many sign-in attempts. Your password was not checked — wait a few minutes and try again.',
  // Shared host only: the password was accepted, but the next step (choosing a
  // workspace, SSO, or a second factor) needs the interactive form.
  continue:
    'Your password was accepted, but this sign-in needs one more step. Sign in again to continue.',
  unavailable: 'Unable to sign in right now. Please check your connection and try again.',
} as const;

export type LoginErrorKey = keyof typeof LOGIN_ERROR_MESSAGES;

export const LOGIN_ERROR_PARAM = 'loginError';

export function loginErrorKey(value: unknown): LoginErrorKey | undefined {
  return typeof value === 'string' && Object.hasOwn(LOGIN_ERROR_MESSAGES, value)
    ? (value as LoginErrorKey)
    : undefined;
}
