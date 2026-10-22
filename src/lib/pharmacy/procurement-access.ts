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
  const role = matching(input.role);

  // A broad deny still closes the pharmacy surface, but elevated pharmacy
  // operations are never acquired through a wildcard allow. Requiring the
  // named capability prevents a general tenant grant from silently expanding
  // into regulated procurement access.
  if ([...overrides, ...role].some((rule) => rule.effect === 'DENY')) return false;
  return [...input.overrides, ...input.role].some(
    (rule) =>
      rule.effect === 'ALLOW' &&
      PROCUREMENT_ACTIONS.some((action) => rule.capability === action)
  );
}

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export async function actorCanProcure(db: ScopedDb, userId: string, now = new Date()) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      organizationRole: {
        select: { permissions: { select: { capability: true, effect: true } } },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (!user) return false;
  return procurementCapabilityGranted({
    overrides: user.permissionOverrides,
    role: user.organizationRole?.permissions ?? [],
  });
}
