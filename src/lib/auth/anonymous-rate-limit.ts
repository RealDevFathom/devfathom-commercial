import { createHash } from 'crypto';

import { rateLimit, type RateLimitResult } from '@/lib/rate-limit';

/**
 * Throttling for the procedures this PR makes reachable without a session.
 *
 * Applied at the transport, before ANY database work, because the work an
 * anonymous request triggers is not free: a platform-scope token lookup, then a
 * tenant transaction, and for `invitations.accept` / `passwordReset.reset` a
 * bcrypt hash at cost 12. The existing per-account and per-IP limits inside
 * `passwordReset.request` stay exactly as they are — they defend a different
 * thing (inbox flooding and account probing) and run after this one.
 *
 * Two limits, deliberately:
 *
 *  - TOKEN FINGERPRINT. Keyed on a hash of the presented token, so repeated
 *    attempts against one token are capped no matter where they come from. It is
 *    keyed on the token rather than the caller because the token is the thing
 *    being attacked, and unlike a client address it cannot be rotated by the
 *    attacker. Requests that carry no token share one bucket, which bounds
 *    probing with junk payloads.
 *
 *  - COARSE GLOBAL. One bucket for all anonymous traffic through this transport.
 *    It is the backstop for a distributed flood, where no per-token or per-IP key
 *    repeats often enough to trip. It is set well above any plausible legitimate
 *    volume for these five procedures, so it should only ever fire under attack.
 *
 * The counter is the shared store behind `rateLimit` (Postgres outside tests).
 * `ip` must already be the address from `clientIp`, which ignores forwarded
 * headers unless a trusted proxy is configured. The token fingerprint does not
 * depend on that address.
 */

/** Per token, per window. Generous for a human retrying, useless for guessing. */
const TOKEN_LIMIT = 20;
const TOKEN_WINDOW_MS = 10 * 60_000;

/** Per address, per window — a cheap first cut before the global backstop. */
const IP_LIMIT = 60;
const IP_WINDOW_MS = 10 * 60_000;

/** All anonymous traffic through this transport, per window. */
const GLOBAL_LIMIT = 600;
const GLOBAL_WINDOW_MS = 60_000;

/**
 * A short, non-reversible fingerprint of the token. Not stored and never logged;
 * it only has to be stable within a window and not to be the token itself, so a
 * limiter key can never become a way to read a live token out of process memory.
 */
function tokenFingerprint(token: string | null): string {
  if (!token) return 'none';
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

export type AnonymousAdmission = { ok: true } | { ok: false; retryAfter: number };

export async function admitAnonymousRequest(input: {
  kind: 'token' | 'host' | 'supplier-upload';
  token: string | null;
  ip: string;
}): Promise<AnonymousAdmission> {
  const gates: RateLimitResult[] = [
    await rateLimit('anon:trpc:global', GLOBAL_LIMIT, GLOBAL_WINDOW_MS),
    await rateLimit(`anon:trpc:ip:${input.ip}`, IP_LIMIT, IP_WINDOW_MS),
  ];

  if (input.kind !== 'host') {
    gates.push(
      await rateLimit(
        `anon:trpc:token:${tokenFingerprint(input.token)}`,
        TOKEN_LIMIT,
        TOKEN_WINDOW_MS
      )
    );
  }

  if (input.kind === 'supplier-upload') {
    gates.push(
      await rateLimit(`supplier-upload:token:${tokenFingerprint(input.token)}`, 4, TOKEN_WINDOW_MS)
    );
    gates.push(await rateLimit(`supplier-upload:ip:${input.ip}`, 8, IP_WINDOW_MS));
  }
  const blocked = gates.find((gate) => !gate.ok);
  return blocked ? { ok: false, retryAfter: blocked.retryAfter } : { ok: true };
}
