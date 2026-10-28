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
): Promise<boolean | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      status: true,
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
  if (
    user.status &&
    user.status !== 'ACTIVE' &&
    (user.role === 'ADMIN' || user.organizationRole?.key === 'owner')
  )
    return false;
  const matchingRules = [
    ...user.permissionOverrides,
    ...(user.organizationRole?.permissions ?? []),
  ].filter((rule) =>
    capabilityMatches(rule.capability, action, rule.effect === 'DENY' ? 'DENY' : 'ALLOW')
  );
  // Authority comes from the current tenant row, never a session/platform role.
  if (user.status === 'ACTIVE' && (user.role === 'ADMIN' || user.organizationRole?.key === 'owner'))
    return true;
  if (matchingRules.some((rule) => rule.effect === 'DENY')) return false;
  if (matchingRules.some((rule) => rule.effect === 'ALLOW')) return true;
  return null;
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
    const decision = await customDecision(db, subject.id, action, env.now);
    if (decision !== null) return decision;
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
