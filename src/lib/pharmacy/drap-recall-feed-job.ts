import 'server-only';

import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { workspaceToday } from '@/lib/timezone';

import { ingestDrapNotice } from './drap-monitoring';
import {
  DRAP_RECALL_FEED_ACTOR_ID,
  DrapWebNoticeSource,
  drapRecallFeedConfig,
  fetchDrapPage,
  type DrapFetch,
  type DrapRecallFeedConfig,
} from './drap-recall-feed';
import { PharmacyInventoryError } from './inventory';

const DAY = 86_400_000;
const FEED_ORGANIZATION_STATUSES = ['ONBOARDING', 'ACTIVE', 'GRACE'] as const;

/**
 * DEV-692 daily job, run from the platform cron. Off unless operations set
 * `PHARMACY_DRAP_RECALL_FEED_ENABLED=true`. Fetches the DRAP recall-alert page
 * once per run (only when some pharmacy organization has not been fed today)
 * and files every alert as a PENDING_REVIEW draft. It never recalls or
 * quarantines stock: a person confirms each draft on the review screen.
 */
export async function processDueDrapRecallFeed(
  now = new Date(),
  limit = 25,
  deps: { config?: DrapRecallFeedConfig; fetcher?: DrapFetch } = {}
) {
  const config = deps.config ?? drapRecallFeedConfig();
  if (!config.enabled) return { enabled: false as const };

  const due = await withPlatformDb(async (db) => {
    const branches = await db.pharmacyBranch.findMany({
      distinct: ['organizationId'],
      select: { organizationId: true },
    });
    if (!branches.length) return [];
    const [organizations, runs] = await Promise.all([
      db.organization.findMany({
        where: {
          id: { in: branches.map((branch) => branch.organizationId) },
          status: { in: [...FEED_ORGANIZATION_STATUSES] },
        },
        select: { id: true, timezone: true },
        orderBy: { id: 'asc' },
      }),
      db.pharmacyDrapRecallFeedRun.findMany({
        where: { businessDate: { gte: new Date(now.getTime() - 2 * DAY) } },
        select: { organizationId: true, businessDate: true },
      }),
    ]);
    const done = new Set(
      runs.map((run) => `${run.organizationId}:${run.businessDate.toISOString().slice(0, 10)}`)
    );
    return organizations
      .map((organization) => ({
        organizationId: organization.id,
        businessDate: workspaceToday(organization.timezone, now),
      }))
      .filter((item) => !done.has(`${item.organizationId}:${item.businessDate}`))
      .slice(0, Math.max(1, Math.min(100, Math.floor(limit))));
  });
  if (!due.length) return { enabled: true as const, organizations: 0, drafts: 0, failed: 0 };

  let notices;
  try {
    notices = await new DrapWebNoticeSource(config, deps.fetcher ?? fetchDrapPage).read();
  } catch (error) {
    console.error('[drap-recall-feed] fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    // No run rows are written, so the next cron tick retries the fetch.
    return { enabled: true as const, organizations: 0, drafts: 0, failed: due.length };
  }

  let organizations = 0;
  let drafts = 0;
  let failed = 0;
  for (const item of due) {
    try {
      const created = await withTenantDb(
        item.organizationId,
        async (db) => {
          const date = new Date(`${item.businessDate}T00:00:00.000Z`);
          const claim = await db.pharmacyDrapRecallFeedRun.createMany({
            data: [
              {
                organizationId: item.organizationId,
                businessDate: date,
                alertsSeen: notices.length,
                draftsCreated: 0,
                completedAt: now,
              },
            ],
            skipDuplicates: true,
          });
          if (claim.count !== 1) return null;
          const known = new Set(
            (
              await db.pharmacyDrapIngest.findMany({
                where: {
                  organizationId: item.organizationId,
                  kind: 'RECALL',
                  sourceReference: { in: notices.map((notice) => notice.sourceReference) },
                },
                select: { sourceReference: true },
              })
            ).map((row) => row.sourceReference)
          );
          let count = 0;
          for (const notice of notices) {
            if (known.has(notice.sourceReference)) continue;
            try {
              await ingestDrapNotice(
                db,
                { organizationId: item.organizationId, actorId: DRAP_RECALL_FEED_ACTOR_ID },
                'DRAP_WEB',
                notice
              );
              count += 1;
            } catch (error) {
              // A rejected notice is skipped before any write; keep the others.
              if (!(error instanceof PharmacyInventoryError)) throw error;
            }
          }
          await db.pharmacyDrapRecallFeedRun.updateMany({
            where: { organizationId: item.organizationId, businessDate: date },
            data: { draftsCreated: count, completedAt: new Date() },
          });
          return count;
        },
        { timeout: 120_000 }
      );
      if (created === null) continue;
      organizations += 1;
      drafts += created;
    } catch (error) {
      failed += 1;
      console.error('[drap-recall-feed] organization ingest failed', {
        organizationId: item.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { enabled: true as const, organizations, drafts, failed };
}
