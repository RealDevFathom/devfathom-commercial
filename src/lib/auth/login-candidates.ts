import 'server-only';

import type { OrganizationStatus, UserStatus } from '@/generated/prisma/client';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

/**
 * D6 — the one cross-tenant read this change adds.
 *
 * A shared-host login knows an email and nothing else: no host organization, no
 * session, no tenant scope to open. Discovery therefore has to run in the
 * explicitly privileged platform scope, exactly as REST token authentication
 * already does (`src/lib/api-auth.ts`: "discovery runs in the explicitly
 * privileged platform scope … every subsequent operation is returned to the
 * token's tenant scope").
 *
 * `withPlatformDb` DOES bypass the users RLS policy — its first disjunct is
 * `is_platform_admin = 'true'` — so this helper is the one new cross-tenant read
 * surface in the change and is deliberately constrained:
 *
 *  - exactly ONE transaction, and nothing else runs inside it;
 *  - the ONLY predicate is the normalized email; nothing else is caller-supplied,
 *    so there is no attacker-controlled filter;
 *  - the select list is a hard whitelist — no full user row ever leaves;
 *  - it returns immediately, and every subsequent operation uses
 *    `withTenantDb(organizationId, …)`.
 *
 * It answers "which rows share this address", not "does this address exist" —
 * the caller must run its uniform-null contract over the result so the answer is
 * never observable to someone who has not proven the password.
 */
export const LOGIN_CANDIDATE_CAP = 10;

export type LoginCandidate = {
  userId: string;
  organizationId: string;
  passwordHash: string | null;
  tokenVersion: number;
  userStatus: UserStatus;
  organization: {
    id: string;
    slug: string;
    displayName: string;
    status: OrganizationStatus;
  };
};

export type LoginCandidateResult = {
  candidates: LoginCandidate[];
  /** True when more rows exist than the cap allows. Treated as a failed login. */
  capExceeded: boolean;
};

export async function findLoginCandidates(normalizedEmail: string): Promise<LoginCandidateResult> {
  if (!normalizedEmail) return { candidates: [], capExceeded: false };

  const rows = await withPlatformDb((platformDb) =>
    platformDb.user.findMany({
      where: { email: normalizedEmail, organization: { isDemo: false } },
      // Fetch one past the cap so "too many" is distinguishable from "exactly
      // the cap" without a second query.
      take: LOGIN_CANDIDATE_CAP + 1,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        organizationId: true,
        password: true,
        tokenVersion: true,
        status: true,
        organization: {
          select: { id: true, slug: true, displayName: true, status: true },
        },
      },
    })
  );

  if (rows.length > LOGIN_CANDIDATE_CAP) {
    return { candidates: [], capExceeded: true };
  }

  return {
    capExceeded: false,
    candidates: rows.map((row) => ({
      userId: row.id,
      organizationId: row.organizationId,
      passwordHash: row.password,
      tokenVersion: row.tokenVersion,
      userStatus: row.status,
      organization: {
        id: row.organization.id,
        slug: row.organization.slug,
        displayName: row.organization.displayName,
        status: row.organization.status,
      },
    })),
  };
}
