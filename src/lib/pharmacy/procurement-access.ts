import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import { isPharmacyOwner } from './branch-assignment';
type CapabilityRule = { capability: string; effect: 'ALLOW' | 'DENY' };

const PROCUREMENT_ACTIONS = ['pharmacy.procurement', 'pharmacy:procurement'] as const;

function covers(rule: string, action: string): boolean {
  if (rule === '*' || rule === action) return true;
  if (rule.endsWith('.*') || rule.endsWith(':*')) return action.startsWith(rule.slice(0, -1));
  return false;
}

function matching(rules: readonly CapabilityRule[]) {
  return rules.filter((rule) =>
    PROCUREMENT_ACTIONS.some((action) => covers(rule.capability, action))
  );
}

/**
 * Goods-in is the procurement capability. A cashier grant such as
 * `pharmacy.counter` or `pharmacy:orders` does not cover it. DENY wins.
 */
export function procurementCapabilityGranted(input: {
  overrides: readonly CapabilityRule[];
  role: readonly CapabilityRule[];
}): boolean {
  const overrides = matching(input.overrides);
  if (overrides.some((rule) => rule.effect === 'DENY')) return false;
  if (overrides.some((rule) => rule.effect === 'ALLOW')) return true;
  const role = matching(input.role);
  if (role.some((rule) => rule.effect === 'DENY')) return false;
  return role.some((rule) => rule.effect === 'ALLOW');
}

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export async function actorCanProcure(db: ScopedDb, userId: string, now = new Date()) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      status: true,
      organizationId: true,
      organizationRole: {
        select: { key: true, permissions: { select: { capability: true, effect: true } } },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (!user) return false;
  const rules = [...user.permissionOverrides, ...(user.organizationRole?.permissions ?? [])];
  if (matching(rules).some((rule) => rule.effect === 'DENY')) return false;
  if (user.organizationId && ACTIVE_STATUSES.has(user.status) && isPharmacyOwner(user)) return true;
  return procurementCapabilityGranted({
    overrides: user.permissionOverrides,
    role: user.organizationRole?.permissions ?? [],
  });
}
