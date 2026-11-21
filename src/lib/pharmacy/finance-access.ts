import {
  PHARMACY_FINANCE_READ,
  PHARMACY_FINANCE_MANAGE,
  type PharmacyFinanceAction,
} from '@/lib/abac/pharmacy-finance-actions';
import { TRPCError } from '@trpc/server';
import type { TRPCContext } from '@/server/trpc';
import { can, subjectFromSession, type CanOptions } from '@/lib/abac';

/** Finance decisions in pharmacy accounts come from the tenant's live grants, overrides and system Owner identity. */
export function canAccessPharmacyFinance(
  user: Parameters<typeof subjectFromSession>[0],
  options: CanOptions,
  action: PharmacyFinanceAction = PHARMACY_FINANCE_READ
) {
  return can(subjectFromSession(user), action, undefined, {
    ...options,
    ownerOnlyFallback: true,
  });
}

type FinanceContext = Pick<TRPCContext, 'db' | 'requestMeta'> & {
  session: NonNullable<TRPCContext['session']>;
};

export function canManagePharmacyAccounts(ctx: FinanceContext) {
  return canAccessPharmacyFinance(
    ctx.session.user,
    { db: ctx.db, source: 'TRPC', ip: ctx.requestMeta?.ip ?? null },
    PHARMACY_FINANCE_MANAGE
  );
}

export async function requirePharmacyFinance(
  ctx: FinanceContext,
  action: PharmacyFinanceAction = PHARMACY_FINANCE_READ
) {
  if (
    !(await canAccessPharmacyFinance(
      ctx.session.user,
      {
        db: ctx.db,
        source: 'TRPC',
        ip: ctx.requestMeta?.ip ?? null,
      },
      action
    ))
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Finance permission is required.' });
}
