import { can, subjectFromSession, type Action } from '@/lib/abac';
import { capabilityMatches } from '@/lib/abac/capabilities';
import type { AuthzDb } from '@/lib/authz';

type SessionUser = {
  id: string;
  role?: string | null;
  department?: string | null;
  status?: string | null;
};

/**
 * Manager-or-owner gate for pharmacy actions a cashier must not take on their own
 * (approving and generating campaigns, closing drawers and the day). Default deny.
 *
 * Allowed when either:
 * - the user holds `pharmacy:manage` (Manager, Owner and Owner / Operator
 *   templates) or one of `alsoAccepted` through their organization role or a
 *   user override; or
 * - the user is a tenant ADMIN with no organization role (a solo owner, or a
 *   workspace that predates explicit roles) and at least one of those actions
 *   is not denied by a DENY override.
 *
 * A tenant ADMIN who has been assigned a role (for example the Cashier template)
 * is bounded by that role. Any lookup failure denies.
 */
export async function hasPharmacyManagerAccess(
  db: Pick<AuthzDb, 'user'>,
  user: SessionUser | null | undefined,
  alsoAccepted: readonly Action[] = [],
  ip: string | null = null
): Promise<boolean> {
  if (!user?.id) return false;
  const actions: Action[] = ['pharmacy:manage', ...alsoAccepted];
  const subject = subjectFromSession(user);
  // The pharmacy capabilities checked here resolve through the user's role and
  // overrides only (no static policy reads another model), so `user` suffices.
  const authzDb = db as AuthzDb;
  for (const action of actions)
    if (await can(subject, action, undefined, { db: authzDb, source: 'TRPC', ip })) return true;
  if (user.role !== 'ADMIN') return false;
  try {
    const now = new Date();
    const record = await db.user.findUnique({
      where: { id: user.id },
      select: {
        organizationRole: { select: { id: true } },
        permissionOverrides: {
          where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          select: { capability: true, effect: true },
        },
      },
    });
    if (!record || record.organizationRole) return false;
    // A role-less ADMIN implicitly holds every accepted action; a DENY override
    // removes only the action it matches, so access remains while at least one
    // accepted action is not denied (as for a role holder with any one grant).
    return actions.some(
      (action) =>
        !record.permissionOverrides.some(
          (rule) => rule.effect === 'DENY' && capabilityMatches(rule.capability, action, 'DENY')
        )
    );
  } catch (err) {
    console.error('[pharmacy] manager access lookup threw:', err);
    return false;
  }
}
