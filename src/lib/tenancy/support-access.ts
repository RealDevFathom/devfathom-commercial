import type { Session } from 'next-auth';
import type { SupportIdentity } from '@/lib/tenancy/support-session';

export const SUPPORT_READ_ONLY_MESSAGE = 'Support access is read-only.';
export const SUPPORT_EXPIRED_MESSAGE = 'Support access has ended.';

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
  operation: 'query' | 'mutation' | 'subscription',
  path?: string
): string | null {
  if (!isSupportAccess(ctx)) return null;
  const sessionExpiry = Date.parse(ctx.session?.expires ?? '');
  const supportExpiry = ctx.support?.expiresAt.getTime() ?? sessionExpiry;
  if (
    (ctx.support?.organizationId !== undefined &&
      ctx.support.organizationId !== ctx.session?.user?.organizationId) ||
    (ctx.support?.tenantUserId !== undefined &&
      ctx.support.tenantUserId !== ctx.session?.user?.id) ||
    !Number.isFinite(sessionExpiry) ||
    !Number.isFinite(supportExpiry) ||
    Math.min(sessionExpiry, supportExpiry) <= Date.now()
  ) {
    return SUPPORT_EXPIRED_MESSAGE;
  }
  // These query handlers persist data: email hydrates message bodies; meetings
  // materializes occurrence and participant rows before reading them.
  const writesOnRead = path === 'email.getMessage' || path === 'meetings.getOccurrences';
  return operation === 'query' && !writesOnRead ? null : SUPPORT_READ_ONLY_MESSAGE;
}

/** Explicitly reviewed HTTP reads; GET token issuers are not inspection. */
export function supportHttpReadAllowed(request: Request): boolean {
  const path = new URL(request.url).pathname;
  // tRPC decides using the procedure type, including POST queries.
  if (path.startsWith('/api/trpc/')) return true;
  return (
    request.method === 'GET' &&
    (path.startsWith('/api/files/') || path === '/api/pharmacy/prescription-files')
  );
}

export const supportRequestAllowed = supportHttpReadAllowed;

export function liveSupportExpiry(value: Date | string | undefined): boolean {
  const time = value instanceof Date ? value.getTime() : Date.parse(value ?? '');
  return Number.isFinite(time) && time > Date.now();
}
