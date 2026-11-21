import { TRPCError } from '@trpc/server';
import type { TRPCContext } from '@/server/trpc';
import { can, subjectFromSession, type CanOptions } from '@/lib/abac';

/** Finance decisions in pharmacy accounts come from the tenant's live grants, overrides and system Owner identity. */
export function canReadPharmacyFinance(
  user: Parameters<typeof subjectFromSession>[0],
  options: CanOptions
) {
  return can(subjectFromSession(user), 'finance:read', undefined, {
    ...options,
    ownerOnlyFallback: true,
  });
}

export async function requirePharmacyFinance(
  ctx: Pick<TRPCContext, 'db' | 'requestMeta'> & {
    session: NonNullable<TRPCContext['session']>;
  }
) {
  if (
    !(await canReadPharmacyFinance(ctx.session.user, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta?.ip ?? null,
    }))
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Finance permission is required.' });
}
