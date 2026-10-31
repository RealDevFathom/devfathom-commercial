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
  actions: readonly string[],
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
  const matchingRules = [
    ...user.permissionOverrides,
    ...(user.organizationRole?.permissions ?? []),
  ].filter((rule) =>
    actions.some((action) =>
      capabilityMatches(rule.capability, action, rule.effect === 'DENY' ? 'DENY' : 'ALLOW')
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

/** True iff some policy registered for `action` allows the subject + resource. */
export async function can(
  subject: Subject,
  action: Action,
  resource?: ResourceAttributes,
  opts: CanOptions = {}
): Promise<boolean> {
  return canAny(subject, [action], resource, opts);
}

/**
 * Authorize one workspace represented by capability aliases. A DENY matching
 * any alias wins before an ALLOW or static policy for another alias. This is
 * intentionally different from independently OR-ing multiple `can()` calls.
 */
export async function canAny(
  subject: Subject,
  actions: readonly Action[],
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
    console.error('[abac] no tenant-scoped database supplied for actions:', actions);
    return false;
  }
  let hasOrganizationRole: boolean;
  try {
    const custom = await customDecision(db, subject.id, actions, env.now);
    if (custom.decision !== null) return custom.decision;
    hasOrganizationRole = custom.hasOrganizationRole;
  } catch (err) {
    console.error('[abac] custom permission lookup threw for actions:', actions, err);
    return false;
  }
  for (const action of actions) {
    // Assigned roles bound procurement and prescription intake authority. Keep
    // the tenant-admin fallback only for legacy users without a role (#375).
    if (
      hasOrganizationRole &&
      (action === 'pharmacy:procurement' || action === 'pharmacy:prescriptions')
    ) {
      continue;
    }
    for (const policy of POLICIES[action] ?? []) {
      try {
        if (await policy({ subject, resource, env, db })) return true;
      } catch (err) {
        // A policy that throws denies (fail-closed) but never crashes the request.
        console.error('[abac] policy threw for action:', action, err);
      }
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
