import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { bindWhatsAppTenant, readWhatsAppConfig, type WhatsAppConfig } from './provider';

// Discover organizations only. Session credentials are always read inside an individual tenant scope.
export async function runSenderJob<T>(
  limit: number,
  job: (options: { limit: number; config?: WhatsAppConfig }) => Promise<T>
) {
  const config = readWhatsAppConfig();
  if (config.provider !== 'waha') return job({ limit });
  const results: T[] = [];
  let cursor: string | undefined;
  do {
    const page: { id: string }[] = await withPlatformDb((db) =>
      db.organization.findMany({
        where: { vertical: 'PHARMACY', isDemo: false, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        select: { id: true },
        take: 100,
      })
    );
    for (const { id } of page)
      results.push(await job({ limit, config: bindWhatsAppTenant(config, id) }));
    cursor = page.length === 100 ? page[99].id : undefined;
  } while (cursor);
  return { businesses: results };
}
