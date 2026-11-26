import {
  PHARMACY_FINANCE_READ,
  PHARMACY_FINANCE_MANAGE,
  type PharmacyFinanceAction,
} from '@/lib/abac/pharmacy-finance-actions';
import { hasModule } from '@/lib/entitlements';
import { isSessionUsable } from '@/lib/auth/session-state';
import { assignedRegisterBranchIds } from './controlled-register';
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

/** Admission inside the tenant is independent of the finance grant. */
export async function requireFinanceBranchAssignment(
  ctx: Pick<TRPCContext, 'session' | 'db' | 'entitlements' | 'organization'>,
  branchId: string
) {
  const user = ctx.session?.user;
  const org = ctx.entitlements.organizationId;
  if (
    !user?.id ||
    !org ||
    org !== ctx.organization?.id ||
    (user.organizationId && user.organizationId !== org)
  )
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Organization is outside your finance scope.',
    });
  if (
    user.role !== 'ADMIN' &&
    !(await assignedRegisterBranchIds(ctx.db, org, user.id)).includes(branchId)
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your finance scope.' });
}

/** The old administrator view and the licensed member view use the same branch picker. */
export async function canOpenPharmacyFinance(
  ctx: Pick<TRPCContext, 'session' | 'db' | 'organization' | 'entitlements' | 'requestMeta'>
) {
  const user = ctx.session?.user;
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  return Boolean(
    user.id &&
    isSessionUsable(user) &&
    ctx.organization?.id === ctx.entitlements.organizationId &&
    (!user.organizationId || user.organizationId === ctx.organization?.id) &&
    hasModule(ctx.entitlements, 'pharmacy-finance') &&
    (await canAccessPharmacyFinance(user, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta?.ip ?? null,
    }))
  );
}

export function financeBranchWhere(
  organizationId: string,
  user: { role?: string | null; id: string }
) {
  return {
    organizationId,
    active: true,
    ...(user.role === 'ADMIN'
      ? {}
      : { branchAssignments: { some: { organizationId, userId: user.id, active: true } } }),
  };
}
