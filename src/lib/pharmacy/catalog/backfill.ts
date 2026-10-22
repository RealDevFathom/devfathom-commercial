import 'server-only';

import type { PlatformIdentity } from '@/lib/platform/auth';
import { PlatformSecurityError } from '@/lib/platform/security';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { catalogSeedPreview, loadBundledPharmacyCatalog, seedPharmacyCatalog } from './preload';
import { canPlatformRole } from '@/lib/platform/capabilities';

export type CatalogBackfillTarget = { organizationId: string } | { allPharmacy: true };

export async function backfillPharmacyCatalog(
  actor: Pick<PlatformIdentity, 'id' | 'role'>,
  target: CatalogBackfillTarget,
  apply: boolean
) {
  if (!canPlatformRole(actor.role, 'pharmacy:catalog-backfill'))
    throw new PlatformSecurityError('SuperAdmin access is required.', 403);
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
