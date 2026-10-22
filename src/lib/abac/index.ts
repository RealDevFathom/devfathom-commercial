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
  /** Additional, already-scoped grants (for example restaurant staff job roles). */
  additionalRules?: readonly CustomPermissionRule[];
};

export type CustomPermissionRule = {
  capability: string;
  effect: 'ALLOW' | 'DENY';
};

/** Resolve matching user and role rules as one deny-overrides set. */
export function resolveCustomDecision(
  overrides: readonly CustomPermissionRule[],
  roleRules: readonly CustomPermissionRule[],
  action: string
): boolean | null {
  const matching = [...overrides, ...roleRules].filter((rule) =>
    capabilityMatches(rule.capability, action, rule.effect)
  );
  if (matching.some((rule) => rule.effect === 'DENY')) return false;
  if (matching.some((rule) => rule.effect === 'ALLOW')) return true;
  return null;
}

async function customDecision(
  db: AuthzDb,
  userId: string,
  action: string,
  now: Date,
  additionalRules: readonly CustomPermissionRule[] = []
): Promise<boolean | null> {
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
  if (!user) return resolveCustomDecision(additionalRules, [], action);
  return resolveCustomDecision(
    [...user.permissionOverrides, ...additionalRules],
    user.organizationRole?.permissions ?? [],
    action
  );
}

/** True iff some policy registered for `action` allows the subject + resource. */
export async function can(
  subject: Subject,
  action: Action | string,
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
    const decision = await customDecision(db, subject.id, action, env.now, opts.additionalRules);
    if (decision !== null) return decision;
  } catch (err) {
    console.error(`[abac] custom permission lookup for "${action}" threw:`, err);
    return false;
  }
  for (const policy of POLICIES[action as Action] ?? []) {
    try {
      if (await policy({ subject, resource, env, db })) return true;
    } catch (err) {
      // A policy that throws denies (fail-closed) but never crashes the request.
      console.error(`[abac] policy for "${action}" threw:`, err);
    }
  }
  return false;
}

/** Authorize one of several equivalent capabilities while preserving deny precedence
 * across the complete set. This is intended for compatibility gates that accept more
 * than one canonical capability. */
export async function canAny(
  subject: Subject,
  actions: readonly string[],
  opts: CanOptions = {}
): Promise<boolean> {
  const db = opts.db;
  if (!db || actions.length === 0) return false;
  const now = opts.now ?? new Date();
  try {
    const decisions = await Promise.all(
      actions.map((action) =>
        customDecision(db, subject.id, action, now, opts.additionalRules)
      )
    );
    if (decisions.some((decision) => decision === false)) return false;
    if (decisions.some((decision) => decision === true)) return true;
  } catch (err) {
    console.error('[abac] custom permission lookup for capability set threw:', err);
    return false;
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
