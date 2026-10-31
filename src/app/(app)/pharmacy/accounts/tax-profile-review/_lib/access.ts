import 'server-only';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext, type TRPCContext } from '@/server/trpc';

export async function reviewContext(request?: Request) {
  const actor = await resolveTenantActor(request ? { request } : undefined);
  if (!actor?.session?.user) return null;
  return createTRPCContext({
    req: request,
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

export async function canReview(ctx: TRPCContext) {
  if (
    ctx.session?.user?.role !== 'ADMIN' ||
    !ctx.organization?.id ||
    ctx.entitlements.organizationId !== ctx.organization.id ||
    !hasModule(ctx.entitlements, 'pharmacy-finance') ||
    !hasModule(ctx.entitlements, 'pharmacy-reports')
  )
    return false;
  for (const permission of ['reports:operational', 'reports:financial'] as const) {
    if (
      !(await can(subjectFromSession(ctx.session.user), permission, undefined, {
        db: ctx.db,
        source: 'TRPC',
        ip: ctx.requestMeta.ip,
      }))
    )
      return false;
  }
  return true;
}
