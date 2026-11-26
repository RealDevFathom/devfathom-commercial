import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { bindWhatsAppTenant, readWhatsAppConfig, type WhatsAppConfig } from './provider';

// Keep the scheduler response identical to a single run, including the nested SMS totals.
type Summary = Record<string, number | boolean | string[] | Record<string, number>> & {
  scanned: number;
};
function addSummary(total: Summary, part: Summary) {
  for (const [field, value] of Object.entries(part)) {
    const prior = total[field];
    if (typeof value === 'number') total[field] = (typeof prior === 'number' ? prior : 0) + value;
    else if (typeof value === 'boolean') total[field] = value || prior === true;
    else if (Array.isArray(value))
      total[field] = [...new Set([...(Array.isArray(prior) ? prior : []), ...value])];
    else {
      const counts = typeof prior === 'object' && !Array.isArray(prior) ? prior : {};
      for (const [key, count] of Object.entries(value)) counts[key] = (counts[key] ?? 0) + count;
      total[field] = counts;
    }
  }
}

// Discover organizations only. Session credentials are always read inside an individual tenant scope.
export async function runSenderJob(
  limit: number,
  job: (options: { limit: number; config?: WhatsAppConfig }) => Promise<Summary>
) {
  const config = readWhatsAppConfig();
  if (config.provider !== 'waha') return job({ limit });
  let remaining = Math.max(1, Math.min(500, Math.floor(limit)));
  let total: Summary | undefined;
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
    for (const { id } of page) {
      const part = await job({ limit: remaining, config: bindWhatsAppTenant(config, id) });
      remaining -= part.scanned;
      if (total) addSummary(total, part);
      else total = part;
      if (remaining <= 0) return total;
    }
    cursor = page.length === 100 ? page[99].id : undefined;
  } while (cursor);
  return total ?? job({ limit, config });
}
