/**
 * DEV-959B — the member-edit paths of the tenant routers (organization page, team screen,
 * invitations) run their writes through the pharmacy access guard when the organization is a
 * pharmacy, so a role change there passes exactly the rules the tick boxes do. Other business
 * types are unchanged.
 */
import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { rethrowAccessChange, verifyAccessPin } from '@/lib/team/member-sub-role-edit';
import { guardPharmacyAccessChange } from '@/lib/team/pharmacy-access-guard';

type AccessContext = {
  entitlements: { vertical?: string | null };
  session: { user: { id: string; organizationId?: string; isSupportSession?: boolean } };
  support?: unknown;
};

export function isPharmacyContext(ctx: AccessContext): boolean {
  return ctx.entitlements.vertical === 'PHARMACY';
}

/** The editor's fresh PIN on the shared verifier, for a pharmacy; false when none was given. */
export async function verifyMemberEditPin(
  ctx: AccessContext,
  organizationId: string,
  pin: string | null | undefined,
  action: string
): Promise<boolean> {
  if (!isPharmacyContext(ctx) || !pin) return false;
  return verifyAccessPin({ organizationId, actorId: ctx.session.user.id, pin, action });
}

/**
 * Runs `write` in `tx`; in a pharmacy, inside the access guard, which refuses (and so rolls
 * back) any change the editor may not make.
 */
export async function guardMemberEdit<T>(
  ctx: AccessContext,
  tx: ScopedDb,
  input: {
    organizationId: string;
    targetId: string | null;
    pinVerified: boolean;
    action: string;
    describe: (name: string) => string;
  },
  write: () => Promise<{ targetId: string; value: T }>
): Promise<T> {
  if (!isPharmacyContext(ctx)) return (await write()).value;
  try {
    const { value } = await guardPharmacyAccessChange(
      tx,
      {
        organizationId: input.organizationId,
        actor: {
          kind: 'member',
          id: ctx.session.user.id,
          supportSession: Boolean(ctx.support || ctx.session.user.isSupportSession),
        },
        targetId: input.targetId,
        pinVerified: input.pinVerified,
        mode: 'role',
        action: input.action,
        describe: input.describe,
      },
      write
    );
    return value;
  } catch (error) {
    rethrowAccessChange(error);
  }
}
