import type { Session } from 'next-auth';
import type { SupportIdentity } from '@/lib/tenancy/support-session';

export const SUPPORT_READ_ONLY_MESSAGE = 'Support sessions have read-only access.';
export const SUPPORT_EXPIRED_MESSAGE = 'Support access has ended. Open a new support session.';

type SupportContext = {
  session: Session | null;
  support: SupportIdentity | null;
};

/** Both representations must restrict access, including callers that omit support metadata. */
export function isSupportAccess(ctx: SupportContext): boolean {
  return Boolean(ctx.support || ctx.session?.user?.isSupportSession);
}

export function supportAccessDenial(
  ctx: SupportContext,
  operation: 'query' | 'mutation' | 'subscription'
): string | null {
  if (!isSupportAccess(ctx)) return null;
  const sessionExpiry = Date.parse(ctx.session?.expires ?? '');
  const supportExpiry = ctx.support?.expiresAt.getTime() ?? sessionExpiry;
  if (
    !Number.isFinite(sessionExpiry) ||
    !Number.isFinite(supportExpiry) ||
    Math.min(sessionExpiry, supportExpiry) <= Date.now()
  ) {
    return SUPPORT_EXPIRED_MESSAGE;
  }
  return operation === 'query' ? null : SUPPORT_READ_ONLY_MESSAGE;
}

/** HTTP adapters outside tRPC must never translate an impersonated ADMIN into write authority. */
export function supportRequestAllowed(request: Request): boolean {
  const path = new URL(request.url).pathname;
  // tRPC decides using the procedure type, including queries transported by POST.
  if (path.startsWith('/api/trpc/')) return true;
  // This GET mints publish/presence credentials with their own lifetime.
  if (path.replace(/\/$/, '') === '/api/ably-token') return false;
  return request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS';
}
