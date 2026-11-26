import 'server-only';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { loadStarterBatch, starterProductCount } from './starter-loader';

export async function processStarterImports() {
  const result = { processed: 0, failed: 0 };
  if (!starterProductCount) return result;
  const deadline = Date.now() + 90_000;
  const deferred = new Set<string>();
  // One transaction per batch. Rotate by last progress so smaller pharmacies can finish too.
  while (Date.now() < deadline) {
    const next = await withPlatformDb((db) =>
      db.pharmacyStarterImport.findFirst({
        where: { completedAt: null, organizationId: { notIn: [...deferred] } },
        orderBy: [{ progressedAt: 'asc' }, { organizationId: 'asc' }],
        select: { organizationId: true },
      })
    );
    if (!next) break;
    try {
      const processed = await withTenantDb(
        next.organizationId,
        (db) => loadStarterBatch(db, next.organizationId),
        { skipDrain: true }
      );
      result.processed += processed;
      if (!processed) deferred.add(next.organizationId);
    } catch (error) {
      deferred.add(next.organizationId);
      result.failed++;
      // Do not log query arguments, connection strings or catalogue values.
      console.error('Starter catalogue batch rolled back', {
        organizationId: next.organizationId,
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
    }
  }
  return result;
}
