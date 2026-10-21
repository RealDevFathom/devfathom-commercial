import { redirect } from 'next/navigation';

import { can, subjectFromSession } from '@/lib/abac';
import { isGrowthEnabled } from '@/lib/growth';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { growthRouter } from '@/server/routers/growth';
import { createTRPCContext, type TRPCContext } from '@/server/trpc';

export type GrowthAccess =
  | {
      ok: true;
      ctx: TRPCContext;
      caller: ReturnType<typeof growthRouter.createCaller>;
    }
  | { ok: false; reason: 'flag' | 'permission' };

export async function loadGrowthAccess(): Promise<GrowthAccess> {
  const actor = await resolveTenantActor();
  if (!actor?.session.user) redirect('/login');
  const ctx = await createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
  if (!(await isGrowthEnabled(actor.organization.id))) return { ok: false, reason: 'flag' };
  const allowed = await can(subjectFromSession(actor.session.user), 'growth.manage', undefined, {
    db: ctx.db,
    source: 'TRPC',
  });
  if (!allowed) return { ok: false, reason: 'permission' };
  return { ok: true, ctx, caller: growthRouter.createCaller(ctx) };
}
