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
import { isPharmacyOwner } from '@/lib/pharmacy/owner';
import { capabilityMatches, EXACT_GRANT_ONLY_ACTIONS } from './capabilities';
import type { AuthzDb } from '@/lib/authz';
import { ACTIVE_STATUSES, POLICIES, RESOURCE_POLICIES, type Action } from './policies';
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
  now: Date,
  organizationId?: string
): Promise<{ decision: boolean | null; subject: Subject; hasOrganizationRole: boolean }> {
  const user = await db.user.findUnique({
    where: { id: userId, ...(organizationId ? { organizationId } : {}) },
    select: {
      organizationId: true,
      role: true,
      status: true,
      organizationRole: {
        select: {
          key: true,
          organizationId: true,
          permissions: { select: { capability: true, effect: true } },
        },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  const hasOrganizationRole = user?.organizationRole != null;
  const subject: Subject = { id: userId, role: user?.role ?? 'EMPLOYEE', status: user?.status };
  if (
    !user ||
    (organizationId !== undefined && user.organizationId !== organizationId) ||
    (user.organizationRole &&
      user.organizationRole.organizationId !== undefined &&
      user.organizationRole.organizationId !== user.organizationId) ||
    !ACTIVE_STATUSES.has(user.status)
  )
    return { decision: false, subject, hasOrganizationRole };
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
      capabilityMatches(
        (candidate === 'pharmacy:receipt' || candidate === 'pharmacy:counter') &&
          rule.capability === candidate.replace(':', '.')
          ? candidate
          : rule.capability,
        candidate,
        rule.effect === 'DENY' ? 'DENY' : 'ALLOW'
      )
    )
  );
  if (matchingRules.some((rule) => rule.effect === 'DENY'))
    return { decision: false, subject, hasOrganizationRole };
  if (matchingRules.some((rule) => rule.effect === 'ALLOW'))
    return { decision: true, subject, hasOrganizationRole };
  // Only a proven sole active proprietor inherits all capabilities. This is an
  // entitlement, never an exemption from resource checks or PIN/audit approval.
  if (
    !EXACT_GRANT_ONLY_ACTIONS.has(action) &&
    user.status === 'ACTIVE' &&
    user.organizationRole?.key === 'owner' &&
    (await db.user.count({ where: { organizationId: user.organizationId, status: 'ACTIVE' } })) ===
      1 &&
    (await isPharmacyOwner(db as never, user.organizationId, userId))
  )
    return { decision: true, subject, hasOrganizationRole };
  return { decision: null, subject, hasOrganizationRole };
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
  let decision: boolean | null;
  try {
    const current = await customDecision(db, subject.id, action, env.now, subject.organizationId);
    decision = current.decision;
    subject = { ...subject, ...current.subject };
    if (decision === false) return false;
    // Resource restrictions apply equally to explicit grants and solo owners.
    for (const policy of RESOURCE_POLICIES[action] ?? []) {
      if (!(await policy({ subject, resource, env, db }))) return false;
    }
    if (decision === true) return true;
    // Assigned roles must explicitly grant procurement; legacy admins retain access.
    if (action === 'pharmacy:procurement' && current.hasOrganizationRole) return false;
  } catch (err) {
    console.error('[abac] permission evaluation threw:', action, err);
    return false;
  }
  for (const policy of POLICIES[action] ?? []) {
    try {
      if (await policy({ subject, resource, env, db })) return true;
    } catch (err) {
      // A policy that throws denies (fail-closed) but never crashes the request.
      console.error('[abac] policy threw:', action, err);
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
  organizationId?: string;
}): Subject {
  return {
    id: user.id,
    organizationId: user.organizationId,
    role: user.role ?? 'EMPLOYEE',
    department: user.department ?? null,
    status: user.status ?? null,
  };
}

export async function isPvOwner(db: AuthzDb, userId: string, organizationId: string) {
  return isPharmacyOwner(db as never, organizationId, userId);
}
