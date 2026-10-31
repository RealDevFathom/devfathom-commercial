import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import { capabilityMatches } from '@/lib/abac/capabilities';
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
 * `pharmacy.counter` or `pharmacy:orders` does not cover it. DENY always wins.
 */
export function procurementCapabilityGranted(input: {
  overrides: readonly CapabilityRule[];
  role: readonly CapabilityRule[];
  tenantAdminWithoutRole?: boolean;
}): boolean {
  const rules = matching([...input.overrides, ...input.role]);
  if (rules.some((rule) => rule.effect === 'DENY')) return false;
  return rules.some((rule) => rule.effect === 'ALLOW') || input.tenantAdminWithoutRole === true;
}

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export async function actorCanProcure(db: ScopedDb, userId: string, now = new Date()) {
  const user = await db.user.findUnique({
    where: { id: userId, status: 'ACTIVE' },
    select: {
      role: true,
      status: true,
      organizationRole: {
        select: {
          key: true,
          isSystem: true,
          permissions: { select: { capability: true, effect: true } },
        },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (!user) return false;
  if (
    matching([...user.permissionOverrides, ...(user.organizationRole?.permissions ?? [])]).some(
      (rule) => rule.effect === 'DENY'
    )
  )
    return false;
  if (hasAllCapabilityAccess(user)) return true;
  return procurementCapabilityGranted({
    overrides: user.permissionOverrides,
    role: user.organizationRole?.permissions ?? [],
    // Match ABAC's legacy admin fallback (#375), without bypassing an assigned
    // role's capability boundary or an explicit DENY.
    tenantAdminWithoutRole: user.role === 'ADMIN' && user.organizationRole === null,
  });
}

/** A real installed Owner, or an ADMIN explicitly granted all capabilities. */
export async function actorIsPharmacyOwner(db: ScopedDb, organizationId: string, userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId, organizationId, status: 'ACTIVE' },
    select: {
      role: true,
      status: true,
      organizationRole: { select: { key: true, isSystem: true, permissions: true } },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (!user) return false;
  if (
    matching([...user.permissionOverrides, ...(user.organizationRole?.permissions ?? [])]).some(
      (rule) => rule.effect === 'DENY'
    )
  )
    return false;
  if (hasAllCapabilityAccess(user)) return true;
  const role = user.organizationRole;
  return Boolean(
    (role?.isSystem && ['owner', 'owner-operator'].includes(role.key)) ||
    (user.role === 'ADMIN' &&
      [...(role?.permissions ?? []), ...user.permissionOverrides].some(
        (rule) => rule.capability === '*' && rule.effect === 'ALLOW'
      ))
  );
}

/** Read-only goods-in access never authorizes a purchasing mutation. */
export async function actorCanReadPurchasing(db: ScopedDb, userId: string, now = new Date()) {
  const user = await db.user.findUnique({
    where: { id: userId, status: 'ACTIVE' },
    select: {
      role: true,
      status: true,
      organizationRole: {
        select: {
          key: true,
          isSystem: true,
          permissions: { select: { capability: true, effect: true } },
        },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (!user) return false;
  const allRules = [...user.permissionOverrides, ...(user.organizationRole?.permissions ?? [])];
  if (
    allRules.some(
      (rule) =>
        rule.effect === 'DENY' &&
        (PROCUREMENT_ACTIONS.some((action) => covers(rule.capability, action)) ||
          covers(rule.capability, 'pharmacy:receiving-view'))
    )
  )
    return false;
  if (hasAllCapabilityAccess(user)) return true;
  if (
    procurementCapabilityGranted({
      overrides: user.permissionOverrides,
      role: user.organizationRole?.permissions ?? [],
    })
  )
    return true;
  const rules = [...user.permissionOverrides, ...(user.organizationRole?.permissions ?? [])].filter(
    (rule) =>
      (rule.effect === 'DENY' && covers(rule.capability, 'pharmacy:receiving-view')) ||
      rule.capability === 'pharmacy:receiving-view'
  );
  return (
    !rules.some((rule) => rule.effect === 'DENY') && rules.some((rule) => rule.effect === 'ALLOW')
  );
}

/** Clinical staff retain witness selection without receiving access to purchasing data. */
export async function actorCanSelectPurchaseWitness(db: ScopedDb, userId: string) {
  if (await actorCanReadPurchasing(db, userId)) return true;
  const user = await db.user.findUnique({
    where: { id: userId, status: 'ACTIVE' },
    select: {
      organizationRole: { select: { permissions: { select: { capability: true, effect: true } } } },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (!user) return false;
  const rules = [...user.permissionOverrides, ...(user.organizationRole?.permissions ?? [])];
  return ['pharmacy:safety', 'pharmacy:dispense'].some((action) => {
    const matching = rules.filter((rule) =>
      capabilityMatches(rule.capability, action, rule.effect)
    );
    return (
      !matching.some((rule) => rule.effect === 'DENY') &&
      matching.some((rule) => rule.effect === 'ALLOW')
    );
  });
}
