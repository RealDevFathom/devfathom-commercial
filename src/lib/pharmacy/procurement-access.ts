import { capabilityMatches } from '@/lib/abac/capabilities';

type CapabilityRule = { capability: string; effect: 'ALLOW' | 'DENY' };

const PROCUREMENT_ACTION = 'pharmacy:procurement';

function matching(rules: readonly CapabilityRule[]) {
  return rules.filter((rule) =>
    capabilityMatches(rule.capability, PROCUREMENT_ACTION, rule.effect)
  );
}

/**
 * Goods-in is the procurement capability. A cashier grant such as
 * `pharmacy.counter` or `pharmacy:orders` does not cover it. DENY wins.
 */
export function procurementCapabilityGranted(input: {
  overrides: readonly CapabilityRule[];
  role: readonly CapabilityRule[];
  rolelessAdmin?: boolean;
}): boolean {
  const overrides = matching(input.overrides);
  if (overrides.some((rule) => rule.effect === 'DENY')) return false;
  const role = matching(input.role);
  if (role.some((rule) => rule.effect === 'DENY')) return false;
  if (overrides.some((rule) => rule.effect === 'ALLOW')) return true;
  return role.some((rule) => rule.effect === 'ALLOW') || input.rolelessAdmin === true;
}

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export async function actorCanProcure(db: ScopedDb, userId: string, now = new Date()) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
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
    rolelessAdmin: !user.organizationRole && user.role === 'ADMIN',
    overrides: user.permissionOverrides,
    role: user.organizationRole?.permissions ?? [],
  });
}
