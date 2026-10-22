import 'server-only';

import type { PlatformRole } from '@/generated/prisma/client';
import { can } from '@/lib/abac';
import type { AuthzDb } from '@/lib/authz';
import { PLATFORM_ROLE_CAPABILITIES } from '@/lib/platform/capabilities';
import { PlatformSecurityError } from '@/lib/platform/security';

/**
 * CAT-SEC-02: the platform catalogue backfill is authorized by the central
 * `can()` decision, not by a local role compare.
 *
 * `can()` resolves a principal through `db.user.findUnique` and applies the
 * shared rules (wildcard and exact matching, explicit DENY, fail-closed on a
 * missing principal or a lookup error). A platform user is not a tenant user,
 * so this module models the authenticated platform actor as that principal.
 * Its rules come from two sources, the platform role's grants and per-actor
 * rules, and are presented to `can()` as ONE rule set, so an explicit DENY
 * from either source beats every ALLOW from both. Both sources are read inside
 * the principal lookup, so a source that fails denies (fail-closed).
 *
 * Both the server action and the service call `assertCanBackfillPharmacyCatalog`,
 * so every caller (HTTP, CLI, job) gets the same decision before any database access.
 */

export const CATALOG_BACKFILL_CAPABILITY = 'pharmacy:catalog-backfill' as const;

export type PlatformCatalogActor = {
  id: string;
  role: PlatformRole;
  /** A session that still has to enrol MFA may not act. */
  enrollmentOnly?: boolean;
  /** Set by callers that loaded the platform user (the CLI); a deactivated user may not act. */
  active?: boolean;
};

export type PlatformPermissionRule = { capability: string; effect: 'ALLOW' | 'DENY' };
type Rules = readonly PlatformPermissionRule[];

export type PlatformRuleSources = {
  roleRules(role: PlatformRole): Rules | Promise<Rules>;
  actorRules(actorId: string): Rules | Promise<Rules>;
};

export const PLATFORM_RULE_SOURCES: PlatformRuleSources = {
  roleRules: (role) =>
    PLATFORM_ROLE_CAPABILITIES[role].map((capability) => ({ capability, effect: 'ALLOW' })),
  // No per-actor platform rules are stored yet. The source is part of the model
  // so a rule store plugs into the same central decision.
  actorRules: () => [],
};

function platformPrincipalDb(actor: PlatformCatalogActor, sources: PlatformRuleSources): AuthzDb {
  return {
    user: {
      findUnique: async ({ where }: { where: { id?: string } }) => {
        if (where.id !== actor.id || actor.enrollmentOnly || actor.active === false) return null;
        const rules = [
          ...(await sources.roleRules(actor.role)),
          ...(await sources.actorRules(actor.id)),
        ];
        return { organizationRole: { permissions: rules }, permissionOverrides: [] };
      },
    },
  } as unknown as AuthzDb;
}

/** The central decision for one platform actor. Performs no database access. */
export async function canBackfillPharmacyCatalog(
  actor: PlatformCatalogActor,
  sources: PlatformRuleSources = PLATFORM_RULE_SOURCES
): Promise<boolean> {
  return can(
    { id: actor.id, role: actor.role, status: 'ACTIVE' },
    CATALOG_BACKFILL_CAPABILITY,
    { type: 'PharmacyCatalogBackfill' },
    { db: platformPrincipalDb(actor, sources), source: 'SYSTEM' }
  );
}

export async function assertCanBackfillPharmacyCatalog(
  actor: PlatformCatalogActor,
  sources: PlatformRuleSources = PLATFORM_RULE_SOURCES
): Promise<void> {
  if (!(await canBackfillPharmacyCatalog(actor, sources))) {
    throw new PlatformSecurityError('SuperAdmin access is required.', 403);
  }
}
