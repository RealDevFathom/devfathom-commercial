// A 500-person office behind one source address should be able to start
// signing in within about two minutes. Both protocols share these budgets.
export const SSO_START_LIMITS = {
  windowMs: 60_000,
  source: 300,
  connection: 600,
  host: 900,
  business: 900,
  platform: 6_000,
} as const;

export const SSO_TRANSACTION_TTL_MS = 10 * 60_000;
export const SSO_PENDING_PER_SOURCE = 600;
// SAML needs two rows per start. Ten minutes can straddle eleven fixed
// windows; leave another window of headroom for starts already in flight.
export const SSO_PENDING_PER_CONNECTION =
  2 *
  SSO_START_LIMITS.connection *
  (Math.ceil(SSO_TRANSACTION_TTL_MS / SSO_START_LIMITS.windowMs) + 2);
