import { can, subjectFromSession } from '@/lib/abac';
import { capabilityMatches } from '@/lib/abac/capabilities';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// DEV-295: accept canonical colon-delimited grants beside legacy dotted grants so migrated
// Cashier roles and un-migrated roles pass the same counter/receipt gate.
export const RECEIPT_READ_CAPABILITIES = [
  'pharmacy:dispense',
  'pharmacy.dispense',
  'pharmacy:receipt',
  'pharmacy.receipt',
  'pharmacy:counter',
  'pharmacy.counter',
] as const;

function capabilityCovers(rule: string, action: string): boolean {
  // Dispensing is regulated: only its canonical, exact ALLOW can grant it. The
  // central matcher still lets wildcard DENYs revoke that exact grant.
  if (action === 'pharmacy:dispense') return capabilityMatches(rule, action, 'ALLOW');
  if (rule === '*' || rule === action) return true;
  if (rule.endsWith(':*') || rule.endsWith('.*')) return action.startsWith(rule.slice(0, -1));
  return false;
}

/** One deny-wins decision across a capability family (user overrides and role rules). */
export function counterCapabilityDecision(
  rules: { capability: string; effect: string }[],
  capabilities: readonly string[] = RECEIPT_READ_CAPABILITIES
): 'ALLOW' | 'DENY' | null {
  const matched = rules.filter((rule) =>
    capabilities.some((action) =>
      action === 'pharmacy:dispense' && rule.effect === 'DENY'
        ? capabilityMatches(rule.capability, action, 'DENY')
        : capabilityCovers(rule.capability, action)
    )
  );
  if (matched.some((rule) => rule.effect === 'DENY')) return 'DENY';
  if (matched.some((rule) => rule.effect === 'ALLOW')) return 'ALLOW';
  return null;
}

type CounterOperator = Parameters<typeof subjectFromSession>[0];

/**
 * DEV-831: the offline counter's operator gate is the online counter's. The
 * actor needs the canonical `pharmacy:counter` grant, an active membership of
 * this organization with a deny-wins ALLOW in the counter family, and an
 * active assignment to the counter's branch (or the session ADMIN exception).
 * It is evaluated live on every request, so a revoked grant or assignment
 * stops an enrolled terminal at once. Returns null when allowed, else a reason.
 */
export async function counterOperatorDenial(
  db: ScopedDb,
  user: CounterOperator,
  organizationId: string,
  branchId: string,
  options: { source: 'REST' | 'TRPC'; ip?: string }
): Promise<'forbidden' | 'branch_forbidden' | null> {
  if (!(await can(subjectFromSession(user), 'pharmacy:counter', undefined, { db, ...options })))
    return 'forbidden';
  const member = await db.user.findUnique({
    where: { id: user.id },
    select: {
      status: true,
      organizationId: true,
      organizationRole: {
        select: { permissions: { select: { capability: true, effect: true } } },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (
    !member ||
    member.organizationId !== organizationId ||
    !member.status ||
    !ACTIVE_STATUSES.has(member.status)
  )
    return 'forbidden';
  const rules = [...member.permissionOverrides, ...(member.organizationRole?.permissions ?? [])];
  if (counterCapabilityDecision(rules) !== 'ALLOW') return 'forbidden';
  if (user.role === 'ADMIN') return null;
  const assignment = await db.pharmacyBranchAssignment.findFirst({
    where: {
      organizationId,
      userId: user.id,
      branchId,
      active: true,
      branch: { organizationId, active: true },
    },
    select: { branchId: true },
  });
  return assignment ? null : 'branch_forbidden';
}

const DRAWER_MANAGER_CAPABILITIES = ['pharmacy:manage', 'pharmacy.manage'] as const;

/**
 * DEV-821: whether the actor may put cash into, or take it out of, any open drawer
 * of the branch rather than only a till they run. It is the counter's drawer-manager
 * gate as a decision: the canonical `pharmacy:manage` grant, an active membership of
 * this organization whose rules give a manager ALLOW with no DENY in the counter
 * family (an explicit DENY wins), and an active assignment to the branch (or the
 * session ADMIN exception). Evaluated live, so a revoked grant counts at once.
 */
export async function actorManagesBranchDrawers(
  db: ScopedDb,
  user: CounterOperator,
  organizationId: string,
  branchId: string,
  options: { source: 'REST' | 'TRPC'; ip?: string }
): Promise<boolean> {
  if (!(await can(subjectFromSession(user), 'pharmacy:manage', undefined, { db, ...options })))
    return false;
  const member = await db.user.findUnique({
    where: { id: user.id },
    select: {
      status: true,
      organizationId: true,
      organizationRole: {
        select: { permissions: { select: { capability: true, effect: true } } },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (
    !member ||
    member.organizationId !== organizationId ||
    !member.status ||
    !ACTIVE_STATUSES.has(member.status)
  )
    return false;
  const rules = [...member.permissionOverrides, ...(member.organizationRole?.permissions ?? [])];
  if (
    counterCapabilityDecision(rules, DRAWER_MANAGER_CAPABILITIES) !== 'ALLOW' ||
    counterCapabilityDecision(rules) === 'DENY'
  )
    return false;
  // The member is already confirmed to belong to this organization above.
  if (user.role === 'ADMIN') return true;
  const assignment = await db.pharmacyBranchAssignment.findFirst({
    where: {
      organizationId,
      userId: user.id,
      branchId,
      active: true,
      branch: { organizationId, active: true },
    },
    select: { branchId: true },
  });
  return Boolean(assignment);
}
