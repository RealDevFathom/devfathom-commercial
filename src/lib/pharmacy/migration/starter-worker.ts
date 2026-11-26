import 'server-only';
import { setTimeout as wait } from 'node:timers/promises';
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
        async (db) => {
          // Read activity metadata only. Never collect SQL text or tenant request data.
          // Only one import writer runs at a time, including overlapping cron calls.
          const [slot] = await db.$queryRaw<{ available: boolean }[]>`
            SELECT NOT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname=current_database() AND usename=current_user AND pid<>pg_backend_pid()
                AND backend_type='client backend' AND xact_start IS NOT NULL
            ) AND pg_try_advisory_xact_lock(hashtextextended('pharmacy.starter.worker',0)) AS available`;
          return slot?.available ? loadStarterBatch(db, next.organizationId) : null;
        },
        { skipDrain: true }
      );
      if (processed === null) {
        await wait(100);
        continue;
      }
      result.processed += processed;
      if (!processed) deferred.add(next.organizationId);
      else {
        // Give foreground transactions time between writes, outside both the connection
        // and the tenant row lock. The committed cursor survives a worker timeout here.
        await wait(500);
      }
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
