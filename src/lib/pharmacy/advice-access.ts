import 'server-only';

import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import type { createTRPCContext } from '@/server/trpc';

type AdviceContext = Awaited<ReturnType<typeof createTRPCContext>>;

export type PharmacyAdviceAccess = { reorder: boolean; expiry: boolean };

/**
 * DEV-594: which advisory reports to offer in context on Purchasing and
 * Inventory. Mirrors the gates the report pages enforce — Pharmacy Reports
 * licensed plus `reports:operational` for replenishment, and additionally an
 * owner with `reports:financial` for the expiry advisor — so a link is never a
 * dead end. Display only: every report procedure still checks access itself.
 * Any failure reads as no access.
 */
export async function readPharmacyAdviceAccess(
  ctx: AdviceContext | null | undefined
): Promise<PharmacyAdviceAccess> {
  const none = { reorder: false, expiry: false };
  const user = ctx?.session?.user;
  if (!ctx || !user) return none;
  try {
    if (!hasModule(ctx.entitlements, 'pharmacy-reports')) return none;
    const env = { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta?.ip ?? null };
    const subject = subjectFromSession(user);
    const reorder = await can(subject, 'reports:operational', undefined, env);
    const expiry =
      reorder && user.role === 'ADMIN' && (await can(subject, 'reports:financial', undefined, env));
    return { reorder, expiry };
  } catch {
    return none;
  }
}
