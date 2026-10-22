import 'server-only';

import { PlatformSecurityError } from '@/lib/platform/security';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import {
  assertCanBackfillPharmacyCatalog,
  PLATFORM_RULE_SOURCES,
  type PlatformCatalogActor,
  type PlatformRuleSources,
} from './platform-authz';
import { catalogSeedPreview, loadBundledPharmacyCatalog, seedPharmacyCatalog } from './preload';

export type CatalogBackfillTarget = { organizationId: string } | { allPharmacy: true };

/**
 * Platform backfill of the bundled catalogue into existing pharmacy tenants.
 * The seed writes catalogue reference rows only: it never writes a branch price,
 * a branch setting or availability, which exist only behind the tenant writers
 * in ./commercial (and their branch-scoped RLS refuses a session with no user).
 */
export async function backfillPharmacyCatalog(
  actor: PlatformCatalogActor,
  target: CatalogBackfillTarget,
  apply: boolean,
  sources: PlatformRuleSources = PLATFORM_RULE_SOURCES
) {
  // Same central decision as the server action; nothing below runs without it.
  await assertCanBackfillPharmacyCatalog(actor, sources);
  const organizations = await withPlatformDb((db) =>
    db.organization.findMany({
      where:
        'organizationId' in target
          ? { id: target.organizationId, vertical: 'PHARMACY' }
          : { vertical: 'PHARMACY' },
      select: { id: true },
      orderBy: { id: 'asc' },
    })
  );
  // PlatformSecurityError has no 404; an unknown or non-pharmacy target is a bad request.
  if ('organizationId' in target && organizations.length === 0)
    throw new PlatformSecurityError('Pharmacy organization not found.', 400);
  const catalog = await loadBundledPharmacyCatalog();
  const results = [];
  for (const organization of organizations) {
    const preview = await withTenantDb(
      organization.id,
      (db) => catalogSeedPreview(db, organization.id, catalog),
      { userId: actor.id, timeout: 120_000 }
    );
    if (!apply) {
      results.push({ organizationId: organization.id, ...preview });
      continue;
    }
    const result = await withTenantDb(
      organization.id,
      (db) => seedPharmacyCatalog(db, organization.id, catalog, actor.id),
      { userId: actor.id, timeout: 120_000 }
    );
    await withPlatformDb((db) =>
      db.platformAuditLog.create({
        data: {
          organizationId: organization.id,
          actorPlatformUserId: actor.id,
          action: 'pharmacy.catalog.backfill',
          targetType: 'CatalogSeedRun',
          targetId: `${catalog.version}:${organization.id}`,
          metadata: {
            catalogVersion: catalog.version,
            wouldCreate: preview.wouldCreate,
            existing: preview.existing,
            result: result.status,
          },
        },
      })
    );
    results.push({ organizationId: organization.id, ...preview, status: result.status });
  }
  return { dryRun: !apply, catalogVersion: catalog.version, organizations: results };
}
