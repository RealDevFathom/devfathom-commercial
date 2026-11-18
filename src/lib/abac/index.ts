/**
 * ABAC engine — the central authorization decision point.
 *
 * `can(subject, action, resource?, opts?)` evaluates the policies registered for
 * `action` and returns a boolean (default-deny). It is framework-agnostic, like
 * `@/lib/authz`, so it is reused from tRPC (throwing wrapper in `server/trpc`),
 * the REST `/api/v1`, the AI assistant, and the socket server.
 *
 * Usage:
 *   if (!(await can(subject, 'resignation:review', { type: 'Resignation', ... })))
 *     throw new TRPCError({ code: 'FORBIDDEN' });
 */
import { capabilityMatches } from './capabilities';
import type { AuthzDb } from '@/lib/authz';
import { POLICIES, RESOURCE_CONSTRAINTS, type Action } from './policies';
import type { Environment, ResourceAttributes, Subject } from './types';

export type { Action } from './policies';
export { ACTIVE_STATUSES } from './policies';
export type { Subject, ResourceAttributes, Environment, Policy, PolicyContext } from './types';

export type CanOptions = {
  now?: Date;
  source?: Environment['source'];
  ip?: string | null;
  db?: AuthzDb;
};

async function customDecision(
  db: AuthzDb,
  userId: string,
  action: string,
  now: Date
): Promise<{ decision: boolean | null; hasOrganizationRole: boolean }> {
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
  if (!user) return { decision: false, hasOrganizationRole: false };
  // Prescription capture is narrower than dispensing. Existing pharmacist
  // grants remain authoritative for it, including DENYs, without granting
  // tenant administrators the wider dispensing capability.
  const matchingActions =
    action === 'pharmacy:prescriptions' ? [action, 'pharmacy:dispense'] : [action];
  const matchingRules = [
    ...user.permissionOverrides,
    ...(user.organizationRole?.permissions ?? []),
  ].filter((rule) =>
    matchingActions.some((candidate) =>
      capabilityMatches(rule.capability, candidate, rule.effect === 'DENY' ? 'DENY' : 'ALLOW')
    )
  );
  const hasOrganizationRole = user.organizationRole !== null;
  if (matchingRules.some((rule) => rule.effect === 'DENY')) {
    return { decision: false, hasOrganizationRole };
  }
  if (matchingRules.some((rule) => rule.effect === 'ALLOW')) {
    return { decision: true, hasOrganizationRole };
  }
  return { decision: null, hasOrganizationRole };
}

/**
 * Actions whose tenant-admin fallback applies only to an administrator with no
 * organization role. An assigned role is the boundary for these.
 */
const ROLE_BOUNDED_ADMIN_ACTIONS: ReadonlySet<Action> = new Set([
  'pharmacy:procurement',
  'pharmacy:procurement-approve',
  'pharmacy:catalogue-edit',
]);

/** Grants require action eligibility and all mandatory resource constraints. */
export async function can(
  subject: Subject,
  action: Action,
  resource?: ResourceAttributes,
  opts: CanOptions = {}
): Promise<boolean> {
  const env: Environment = {
    now: opts.now ?? new Date(),
    source: opts.source,
    ip: opts.ip ?? null,
  };
  const db = opts.db;
  if (!db) {
    console.error(`[abac] no tenant-scoped database supplied for "${action}"`);
    return false;
  }
  try {
    const constraint = RESOURCE_CONSTRAINTS[action];
    if (constraint && !(await constraint({ subject, resource, env, db }))) return false;
  } catch (err) {
    console.error('[abac] resource constraint for "%s" threw:', action, err);
    return false;
  }
  try {
    const { decision, hasOrganizationRole } = await customDecision(db, subject.id, action, env.now);
    if (decision !== null) return decision;
    // Procurement's tenant-admin fallback exists only for legacy users who do
    // not yet have an organization role. Once a role is assigned, its
    // capabilities are the boundary: an omitted procurement grant must not
    // fall through to the coarse ADMIN policy.
    if (ROLE_BOUNDED_ADMIN_ACTIONS.has(action) && hasOrganizationRole) return false;
  } catch (err) {
    console.error('[abac] custom permission lookup for "%s" threw:', action, err);
    return false;
  }
  for (const policy of POLICIES[action] ?? []) {
    try {
      if (await policy({ subject, resource, env, db })) return true;
    } catch (err) {
      // A policy that throws denies (fail-closed) but never crashes the request.
      console.error('[abac] policy for "%s" threw:', action, err);
    }
  }
  return false;
}

/** Convenience: derive the ABAC Subject from a session user. */
export function subjectFromSession(user: {
  id: string;
  role?: string | null;
  department?: string | null;
  status?: string | null;
}): Subject {
  return {
    id: user.id,
    role: user.role ?? 'EMPLOYEE',
    department: user.department ?? null,
    status: user.status ?? null,
  };
}
