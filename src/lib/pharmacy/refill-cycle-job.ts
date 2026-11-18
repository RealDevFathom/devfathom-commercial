import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

import { activateBranchScope } from './customer-ordering';
import {
  DAY_MS,
  REFILL_SUBSCRIPTION_LIMITS,
  refillCycleOpensBy,
} from './refill-subscription-rules';
import { openRefillCycle, RefillSubscriptionError } from './refill-subscriptions';

/** The module that licenses refill subscriptions (`pharmacyOrdering` procedures). */
export const REFILL_CYCLE_JOB_MODULE = 'pharmacy-counter';

/** Organization lifecycles the job serves, as every tenant-facing surface does. */
const SERVED_ORGANIZATION_STATUSES = ['ONBOARDING', 'ACTIVE', 'GRACE'] as const;

/** Upper bound on candidates one run reads, however many pages that takes. */
const MAX_SCANNED_PER_RUN = 5_000;

type DueSubscriptionRow = {
  id: string;
  organizationId: string;
  branchId: string;
  nextDueAt: Date;
  reminderLeadDays: number;
  createdByUserId: string;
  timezone: string | null;
};

export type RefillCycleJobResult = {
  scanned: number;
  opened: number;
  /** Its opening day has not started yet in the organization's own time zone. */
  notDue: number;
  /** Another run (or a staff member) already opened this due date. */
  alreadyOpened: number;
  /** Refused by the cycle rules, e.g. not enough stock; tried again next run. */
  skipped: Record<string, number>;
  failed: number;
};

/**
 * DEV-73 scheduled job: open every refill subscription's due cycle on the
 * organization's own day (its workspace time zone).
 *
 * Opening is the "due order": it holds the stock and advances the schedule, through
 * the same `openRefillCycle` the counter uses, so a prescription-only cycle opens as
 * AWAITING_PHARMACIST and stays held until a valid prescription covers it and a
 * pharmacist signs. The job never approves anything.
 *
 * Idempotent: a subscription with a cycle still open is not scanned, each subscription
 * is opened in its own tenant transaction under a row lock, and that transaction
 * opens only the exact due date it was scanned for. Running it twice, or two runs at
 * once, opens one cycle. One subscriber's stock-out never undoes another's hold.
 */
export async function processDueRefillSubscriptionCycles(
  now = new Date(),
  limit = 25
): Promise<RefillCycleJobResult> {
  const pageSize = Math.max(1, Math.min(500, Math.floor(limit) * 4));
  // The widest opening window, plus a day so the shop's own calendar day is covered.
  const horizon = new Date(
    now.getTime() + (REFILL_SUBSCRIPTION_LIMITS.reminderLeadDays.max + 1) * DAY_MS
  );
  const scanPage = (after: Pick<DueSubscriptionRow, 'nextDueAt' | 'id'> | null) =>
    withPlatformDb((db) =>
      db.$queryRaw<DueSubscriptionRow[]>(Prisma.sql`
        SELECT subscription."id", subscription."organizationId", subscription."branchId",
               subscription."nextDueAt", subscription."reminderLeadDays",
               subscription."createdByUserId", organization."timezone"
        FROM "pharmacy_refill_subscriptions" subscription
        JOIN "organizations" organization ON organization."id" = subscription."organizationId"
        WHERE subscription."status" = 'ACTIVE'
          AND subscription."nextDueAt" <= ${horizon}
          AND organization."vertical" = 'PHARMACY'
          AND organization."status"::text IN (${Prisma.join([...SERVED_ORGANIZATION_STATUSES])})
          AND NOT EXISTS (
            SELECT 1 FROM "pharmacy_refill_subscription_cycles" cycle
            WHERE cycle."organizationId" = subscription."organizationId"
              AND cycle."subscriptionId" = subscription."id"
              AND cycle."status" IN ('AWAITING_PHARMACIST', 'RESERVED')
          )
          ${
            after
              ? Prisma.sql`AND (subscription."nextDueAt", subscription."id") > (${after.nextDueAt}, ${after.id})`
              : Prisma.empty
          }
        ORDER BY subscription."nextDueAt", subscription."id"
        LIMIT ${pageSize}
      `)
    );

  const result: RefillCycleJobResult = {
    scanned: 0,
    opened: 0,
    notDue: 0,
    alreadyOpened: 0,
    skipped: {},
    failed: 0,
  };
  const licensed = new Map<string, boolean>();
  const skip = (reason: string) => {
    result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
  };
  const handle = async (row: DueSubscriptionRow) => {
    result.scanned += 1;
    if (!refillCycleOpensBy(row, row.timezone, now)) {
      result.notDue += 1;
      return;
    }
    // A known-unlicensed organization costs no further transaction this run.
    if (licensed.get(row.organizationId) === false) return skip('UNLICENSED');
    try {
      const outcome = await withTenantDb(
        row.organizationId,
        async (db) => {
          if (!licensed.has(row.organizationId)) {
            licensed.set(
              row.organizationId,
              hasModule(
                await resolveOrganizationEntitlements(row.organizationId, db, now),
                REFILL_CYCLE_JOB_MODULE
              )
            );
          }
          if (!licensed.get(row.organizationId)) return 'unlicensed' as const;
          // The subscription's creator stands as the opener: the cycle and its stock
          // hold need a member of this organization, and the audit names the job.
          const scope = {
            organizationId: row.organizationId,
            branchId: row.branchId,
            actorId: row.createdByUserId,
          };
          await activateBranchScope(db, scope);
          const [current] = await db.$queryRaw<{ nextDueAt: Date; status: string }[]>(
            Prisma.sql`SELECT "nextDueAt", "status"::text AS "status" FROM "pharmacy_refill_subscriptions" WHERE "organizationId"=${row.organizationId} AND "branchId"=${row.branchId} AND "id"=${row.id} FOR UPDATE`
          );
          if (
            !current ||
            current.status !== 'ACTIVE' ||
            current.nextDueAt.getTime() !== row.nextDueAt.getTime()
          ) {
            return 'already-opened' as const;
          }
          const cycle = await openRefillCycle(db, scope, row.id);
          await db.auditLog.create({
            data: {
              organizationId: row.organizationId,
              actorType: 'SYSTEM',
              source: 'SYSTEM',
              category: 'PHARMACY_INVENTORY',
              operation: 'CREATE',
              action: 'pharmacy.refillCycle.scheduledOpen',
              targetType: 'PharmacyRefillSubscriptionCycle',
              targetId: cycle.id,
              metadata: {
                subscriptionId: row.id,
                branchId: row.branchId,
                dueAt: cycle.dueAt.toISOString(),
                status: cycle.status,
                requiresPharmacist: cycle.requiresPharmacist,
              },
            },
          });
          return 'opened' as const;
        },
        { userId: row.createdByUserId }
      );
      if (outcome === 'opened') result.opened += 1;
      else if (outcome === 'already-opened') result.alreadyOpened += 1;
      else skip('UNLICENSED');
    } catch (error) {
      if (error instanceof RefillSubscriptionError) return skip(error.reason);
      result.failed += 1;
      console.error('[pharmacy-refill-cycles] subscription open failed', {
        organizationId: row.organizationId,
        subscriptionId: row.id,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  };

  // Page through every candidate, so subscriptions that keep being skipped (a stock-out,
  // an unlicensed organization) can never hold back later ones that are due. Bounded
  // per run; the next run starts again from the earliest.
  let after: DueSubscriptionRow | null = null;
  while (result.scanned < MAX_SCANNED_PER_RUN && result.opened < pageSize) {
    const rows = await scanPage(after);
    for (const row of rows) await handle(row);
    if (rows.length < pageSize) break;
    after = rows[rows.length - 1]!;
  }
  return result;
}
