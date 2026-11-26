/**
 * Which tRPC procedures may run with no session at all, and how a request for
 * one is routed to a tenant.
 *
 * Background — the outage this closes. `/api/trpc` resolved a tenant actor and
 * returned 401 before any router ran, and it is the only tRPC transport in the
 * app. Every recovery flow calls it from the client:
 *
 *   - `invite/[token]/accept-invite-form.tsx`  → invitations.get / invitations.accept
 *   - `reset-password/[token]/reset-password-form.tsx` → passwordReset.validate / .reset
 *   - `forgot-password/forgot-password-form.tsx` → passwordReset.request
 *
 * So nobody could accept an invitation, check a reset link, or complete a reset,
 * and `forgot-password-form.tsx` swallows the failure and shows its neutral
 * confirmation regardless — a user was told to check an inbox that would never
 * receive anything.
 *
 * The rule here is an EXACT allowlist of procedure paths, never "any
 * publicProcedure". `publicProcedure` is also the base every protected, admin,
 * HR and capability procedure is built on, and new public procedures get added
 * for reasons that have nothing to do with anonymous reachability. Reachability
 * is therefore an explicit, reviewable list rather than a property inferred from
 * how a procedure happens to be constructed.
 */

/** Procedures that carry a token which, by itself, names exactly one tenant. */
export const ANONYMOUS_TOKEN_PROCEDURES = new Set([
  'invitations.get',
  'invitations.accept',
  'passwordReset.validate',
  'passwordReset.reset',
  'pharmacySupplierLinks.get',
  'pharmacySupplierLinks.submit',
]);

export const SUPPLIER_LINK_GENERIC_MESSAGE = 'This supplier link is invalid, expired, or revoked.';

/**
 * Procedures that carry no token and must be routed by host instead. Only
 * `passwordReset.request` — it takes an email address, and an address is not a
 * tenant: on a shared host the same address can exist in several organizations.
 */
export const ANONYMOUS_HOST_PROCEDURES = new Set(['passwordReset.request']);

export const ANONYMOUS_PROCEDURES = new Set([
  ...ANONYMOUS_TOKEN_PROCEDURES,
  ...ANONYMOUS_HOST_PROCEDURES,
]);

/**
 * Generic, outcome-independent copy. Shared by the real routers and by the
 * fallback router the transport uses when a request cannot be routed to a
 * tenant at all, so a caller cannot tell "no such token anywhere" from "a real
 * token that has expired" — the two must be indistinguishable.
 */
export const INVITATION_GENERIC_MESSAGE =
  'This invitation is invalid, has expired, or has already been used.';
export const RESET_GENERIC_MESSAGE =
  'This reset link is invalid or has expired. Please request a new one.';

/** The procedure paths in this request. tRPC batches them comma-separated. */
export function requestedProcedures(request: Request): string[] {
  const { pathname } = new URL(request.url);
  const path = decodeURIComponent(pathname.replace(/^\/api\/trpc\/?/, ''));
  return path ? path.split(',').filter(Boolean) : [];
}

export type AnonymousRouting =
  /** Every requested procedure is token-routed. */
  | { kind: 'token'; procedures: string[] }
  /** Every requested procedure is host-routed. */
  | { kind: 'host'; procedures: string[] }
  /** Not reachable anonymously; the caller gets the same 401 as before. */
  | { kind: 'denied' };

/**
 * Decide how — or whether — a session-less request may be routed.
 *
 * A batch is admitted only if EVERY procedure in it is allowlisted, so mixing an
 * allowlisted procedure with a protected one rejects the whole batch rather than
 * running part of it. The two routing strategies are also not mixed within one
 * batch: they derive the tenant from different evidence, and a batch that
 * claimed both would have to pick one. Real clients never batch across these
 * flows — they live on different pages.
 */
export function classifyAnonymousRequest(request: Request): AnonymousRouting {
  const procedures = requestedProcedures(request);
  if (procedures.length === 0) return { kind: 'denied' };
  if (!procedures.every((name) => ANONYMOUS_PROCEDURES.has(name))) return { kind: 'denied' };

  if (procedures.every((name) => ANONYMOUS_TOKEN_PROCEDURES.has(name))) {
    return { kind: 'token', procedures };
  }
  if (procedures.every((name) => ANONYMOUS_HOST_PROCEDURES.has(name))) {
    return { kind: 'host', procedures };
  }
  return { kind: 'denied' };
}

/**
 * Pull a `token` field out of a tRPC input payload, batched or not.
 *
 * Used ONLY to choose a tenant scope. The procedure re-validates the token
 * itself inside that scope, so a token that routes somewhere it should not still
 * fails on its own merits.
 */
export function tokenFromInput(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  for (const entry of Object.values(payload as Record<string, unknown>)) {
    const value =
      entry && typeof entry === 'object' && 'json' in (entry as Record<string, unknown>)
        ? (entry as { json?: unknown }).json
        : entry;
    if (value && typeof value === 'object') {
      const token = (value as Record<string, unknown>).token;
      if (typeof token === 'string' && token) return token;
    }
  }
  return null;
}

/** The token carried by an anonymous request, from the query string or body. */
export async function anonymousToken(request: Request): Promise<string | null> {
  const queryInput = new URL(request.url).searchParams.get('input');
  if (queryInput) {
    try {
      return tokenFromInput(JSON.parse(queryInput));
    } catch {
      return null;
    }
  }
  if (request.method !== 'POST') return null;
  try {
    // Clone so the tRPC adapter still receives an unread body.
    return tokenFromInput(await request.clone().json());
  } catch {
    return null;
  }
}
