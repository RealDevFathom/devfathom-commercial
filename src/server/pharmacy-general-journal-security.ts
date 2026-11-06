import { TRPCError } from '@trpc/server';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from './trpc';

/** Canonical authorization and tenant/active-branch resolution for every JV operation. */
export async function authorizePharmacyGeneralJournalCapability(ctx: TRPCContext) {
  const user = ctx.session?.user;
  const actorId = user?.id;
  const organizationId = ctx.organization?.id;
  if (!user || !actorId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (
    !organizationId ||
    ctx.entitlements.organizationId !== organizationId ||
    !hasModule(ctx.entitlements, 'pharmacy-finance')
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Pharmacy Finance access is required.' });
  }
  if (
    !(await can(subjectFromSession(user), 'reports:financial', undefined, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    }))
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Financial permission is required.' });
  }
  return { organizationId, actorId };
}

/**
 * Navigation-only capability probe: true when the actor could open the general
 * journal. It writes no admission audit and never throws, so a denied or
 * failing check simply hides the entry point; every operation still runs the
 * canonical authorization above.
 */
export async function canOpenPharmacyGeneralJournal(ctx: TRPCContext) {
  try {
    await authorizePharmacyGeneralJournalCapability(ctx);
    return true;
  } catch {
    return false;
  }
}

/** Authorize a collection read and persist admission before returning protected data. */
export async function authorizePharmacyGeneralJournalCollection(ctx: TRPCContext) {
  const scope = await authorizePharmacyGeneralJournalCapability(ctx);
  // Admission is durable even if the caller's business transaction rolls back.
  await withTenantDb(
    scope.organizationId,
    (auditDb) =>
      auditDb.auditLog.create({
        data: {
          organizationId: scope.organizationId,
          actorId: scope.actorId,
          source: 'TRPC',
          category: 'FINANCE',
          operation: 'OTHER',
          action: 'pharmacyGeneralJournal.collectionAdmission',
          targetType: 'Organization',
          targetId: scope.organizationId,
          result: { decision: 'ADMITTED' },
          outcome: 'SUCCESS',
        },
      }),
    { userId: scope.actorId, skipDrain: true }
  );
  return scope;
}

/** Canonical authorization and tenant/active-branch resolution for every JV operation. */
export async function authorizePharmacyGeneralJournal(ctx: TRPCContext, branchId: string) {
  const { organizationId, actorId } = await authorizePharmacyGeneralJournalCapability(ctx);
  const branch = await ctx.db.pharmacyBranch.findFirst({
    where: { organizationId, id: branchId, active: true },
    select: { id: true },
  });
  if (!branch) throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  await withTenantDb(
    organizationId,
    (auditDb) =>
      auditDb.auditLog.create({
        data: {
          organizationId,
          actorId,
          source: 'TRPC',
          category: 'FINANCE',
          operation: 'OTHER',
          action: 'pharmacyGeneralJournal.admission',
          targetType: 'PharmacyBranch',
          targetId: branch.id,
          result: { decision: 'ADMITTED' },
          outcome: 'SUCCESS',
        },
      }),
    { userId: actorId, skipDrain: true }
  );
  return { organizationId, branchId: branch.id, actorId };
}
