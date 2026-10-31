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
import { POLICIES, type Action } from './policies';
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
      status: true,
      role: true,
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
  if (!user) return { decision: false, hasOrganizationRole: false };
  const matchingRules = [
    ...user.permissionOverrides,
    ...(user.organizationRole?.permissions ?? []),
  ].filter((rule) =>
    capabilityMatches(rule.capability, action, rule.effect === 'DENY' ? 'DENY' : 'ALLOW')
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

/** True iff some policy registered for `action` allows the subject + resource. */
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
    const { decision, hasOrganizationRole } = await customDecision(db, subject.id, action, env.now);
    if (decision === false) return false;
    // Capability grants cannot waive the resource restrictions below.
    if (action === 'resignation:review' || action === 'team:layoff') {
      return (
        await Promise.all(
          (POLICIES[action] ?? []).map((policy) => policy({ subject, resource, env, db }))
        )
      ).some(Boolean);
    }
    if (decision === true) return true;
    // Procurement's tenant-admin fallback exists only for legacy users who do
    // not yet have an organization role. Once a role is assigned, its
    // capabilities are the boundary: an omitted procurement grant must not
    // fall through to the coarse ADMIN policy.
    if (action === 'pharmacy:procurement' && hasOrganizationRole) return false;
  } catch (err) {
    console.error(`[abac] custom permission lookup for "${action}" threw:`, err);
    return false;
  }
  for (const policy of POLICIES[action] ?? []) {
    try {
      if (await policy({ subject, resource, env, db })) return true;
    } catch (err) {
      // A policy that throws denies (fail-closed) but never crashes the request.
      console.error(`[abac] policy for "${action}" threw:`, err);
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
