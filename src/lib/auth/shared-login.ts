import 'server-only';

import { compare } from 'bcryptjs';
import { DUMMY_PASSWORD_HASH, SIGNIN_ALLOWED_STATUSES } from '@/lib/auth/constants';
import { findLoginCandidates, type LoginCandidate } from '@/lib/auth/login-candidates';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { recordAuthAudit } from '@/server/audit';

/**
 * D7 — verify the password against EVERY candidate before revealing anything.
 *
 * Asking for the organization first would leak organization membership to anyone
 * who knows an address, which is exactly what
 * docs/admin-platform/security-threat-model.md forbids. So the shared host
 * resolves candidates, proves the password, and only then has anything to say.
 *
 * The uniform-null contract from the per-host provider is preserved exactly:
 * with zero candidates we still run one bcrypt compare against
 * DUMMY_PASSWORD_HASH, and "no such address", "wrong password" and "no eligible
 * organization" are indistinguishable to the caller.
 */

export type EligibleOrganization = {
  organizationId: string;
  userId: string;
  tokenVersion: number;
  slug: string;
  displayName: string;
  /** True when the organization enforces SSO, so no password path exists into it. */
  ssoEnforced: boolean;
};

export type SharedLoginResolution =
  | { outcome: 'failed' }
  | { outcome: 'eligible'; email: string; organizations: EligibleOrganization[] };

type AuditContext = { ip: string | null; userAgent: string | null };

/**
 * D17 — attribute a failure to the organizations that actually have a member at
 * this address. `recordAudit` routes a null organizationId to the PLATFORM
 * ledger, so on a shared host every pre-selection failure would otherwise land in
 * the seller's control-plane ledger instead of the customer's.
 *
 * A tenant administrator already sees failed logins for their own members on a
 * per-tenant host, so this adds no visibility they did not have — and a failure
 * with no candidates stays org-less rather than being guessed into a ledger.
 */
function auditFailure(
  candidates: Pick<LoginCandidate, 'organizationId' | 'userId'>[],
  email: string,
  reason: string,
  context: AuditContext
) {
  if (candidates.length === 0) {
    recordAuthAudit({ type: 'LOGIN_FAILED', email, reason, ...context });
    return;
  }
  for (const candidate of candidates) {
    recordAuthAudit({
      type: 'LOGIN_FAILED',
      organizationId: candidate.organizationId,
      userId: candidate.userId,
      email,
      reason,
      ...context,
    });
  }
}

/**
 * Which of the eligible organizations enforce SSO.
 *
 * D12: `enforceSso` is organization-wide and is evaluated only AFTER the password
 * is proven, preserving the existing ordering. An enforced organization is still
 * returned — a member has to be able to see the workspace and understand how to
 * reach it — but it is never selectable by password.
 */
async function ssoEnforcedFor(organizationId: string): Promise<boolean> {
  try {
    return await withTenantDb(organizationId, async (db) => {
      const connection = await db.organizationIdentityConnection.findFirst({
        where: { status: 'ACTIVE', enforceSso: true },
        select: { id: true },
      });
      return Boolean(connection);
    });
  } catch {
    // Fail closed: if we cannot prove SSO is NOT enforced, do not offer a
    // password path into the organization.
    return true;
  }
}

export async function resolveSharedLogin(input: {
  email: string;
  password: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<SharedLoginResolution> {
  const context: AuditContext = { ip: input.ip, userAgent: input.userAgent };
  const { candidates, capExceeded } = await findLoginCandidates(input.email);

  if (capExceeded) {
    // D6: beyond the cap, record the event and treat it as a failed login. The
    // candidate set was discarded, so there is no organization to attribute to.
    await compare(input.password, DUMMY_PASSWORD_HASH);
    recordAuthAudit({
      type: 'LOGIN_FAILED',
      email: input.email,
      reason: 'Login candidate cap exceeded',
      ...context,
    });
    return { outcome: 'failed' };
  }

  if (candidates.length === 0) {
    // The timing defence: one bcrypt compare happens whether or not the address
    // exists, so response time never reveals it.
    await compare(input.password, DUMMY_PASSWORD_HASH);
    auditFailure([], input.email, 'No such account', context);
    return { outcome: 'failed' };
  }

  const matched: LoginCandidate[] = [];
  for (const candidate of candidates) {
    // A member with no password (SSO-only) still costs one compare, so the
    // number of compares depends only on the candidate count.
    const valid = await compare(input.password, candidate.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (valid && candidate.passwordHash) matched.push(candidate);
  }

  if (matched.length === 0) {
    auditFailure(candidates, input.email, 'Incorrect password', context);
    return { outcome: 'failed' };
  }

  const eligible = matched.filter(
    (candidate) =>
      SIGNIN_ALLOWED_STATUSES.has(candidate.userStatus) &&
      isTenantLifecycleAccessible(candidate.organization.status)
  );

  if (eligible.length === 0) {
    // The password was right, but no organization can be entered. Reported as a
    // uniform failure so the response cannot be used to map which of a person's
    // workspaces are suspended or which accounts are deactivated.
    auditFailure(matched, input.email, 'No eligible organization', context);
    return { outcome: 'failed' };
  }

  const organizations: EligibleOrganization[] = [];
  for (const candidate of eligible) {
    organizations.push({
      organizationId: candidate.organizationId,
      userId: candidate.userId,
      tokenVersion: candidate.tokenVersion,
      slug: candidate.organization.slug,
      displayName: candidate.organization.displayName,
      ssoEnforced: await ssoEnforcedFor(candidate.organizationId),
    });
  }

  // Stable, name-ordered so the picker does not reshuffle between attempts.
  organizations.sort((left, right) => left.displayName.localeCompare(right.displayName));

  return { outcome: 'eligible', email: input.email, organizations };
}
