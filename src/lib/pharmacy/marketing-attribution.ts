import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { MarketingScope } from './marketing-service';

export const ATTRIBUTION_METHOD = 'LAST_META_DELIVERED_CAPTURE_BEFORE_RECEIPT_V1';
const WINDOW_DAYS = 7;
export type EligibleReceipt = {
  receiptId: string;
  campaignId: string;
  captureId: string;
  completedAt: Date;
  salesMinor: number;
  marginMinor: number;
};

/** Receipt is the observed retail visit; no independent visit identity is invented.
 * Only a bound live delivery qualifies. Latest delivery wins, then capture id.
 * Reads aggregate money/units, never medicine names or patient details.
 */
export async function eligibleMarketingReceipts(
  db: ScopedDb,
  organizationId: string,
  branchIds: string[],
  from: Date,
  cutoff: Date
) {
  if (!branchIds.length) return [];
  return db.$queryRaw<EligibleReceipt[]>(Prisma.sql`
    SELECT s.id AS "receiptId", chosen."campaignId", chosen.id AS "captureId", s."completedAt",
      money.sales::integer AS "salesMinor", money.margin::integer AS "marginMinor"
    FROM pharmacy_sales s
    JOIN LATERAL (
      SELECT c.id, c."campaignId" FROM pharmacy_campaign_captures c
      JOIN pharmacy_campaign_dispatch_attempts a ON a."organizationId" = c."organizationId" AND a."captureId" = c.id AND a.provider = 'meta'
      JOIN pharmacy_campaign_delivery_events e ON e."organizationId" = a."organizationId" AND e."attemptId" = a.id AND e.state = 'DELIVERED'
      WHERE c."organizationId" = s."organizationId" AND c."branchId" = s."branchId" AND c."customerId" = s."customerId"
        AND c."capturedAt" <= e."occurredAt" AND e."occurredAt" <= s."completedAt"
        AND e."occurredAt" >= s."completedAt" - interval '7 days' AND e."recordedAt" < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM pharmacy_campaign_delivery_events conflict
          WHERE conflict."organizationId" = a."organizationId" AND conflict."attemptId" = a.id
            AND conflict.state IN ('FAILED','UNKNOWN','SUPPRESSED') AND conflict."recordedAt" < ${cutoff})
      ORDER BY e."occurredAt" DESC, c.id ASC LIMIT 1
    ) chosen ON true
    JOIN LATERAL (
      SELECT COALESCE(SUM(CASE WHEN j."accountCode" IN ('SALES_REVENUE','SALES_DISCOUNT')
        THEN CASE WHEN j.side = 'CREDIT' THEN j."amountMinor" ELSE -j."amountMinor" END ELSE 0 END),0) AS sales,
        COALESCE(SUM(CASE WHEN j.side = 'CREDIT' THEN j."amountMinor" ELSE -j."amountMinor" END),0) AS margin
      FROM pharmacy_sale_lines l
      JOIN finance_journal_lines j ON j."organizationId" = l."organizationId"
        AND j."branchId" = l."branchId" AND j."sourceLineId" = l.id
      JOIN finance_journal_entries entry ON entry."organizationId" = j."organizationId" AND entry.id = j."entryId"
      WHERE l."organizationId" = s."organizationId" AND l."branchId" = s."branchId" AND l."saleId" = s.id
        AND j."accountCode" IN ('SALES_REVENUE','SALES_DISCOUNT','COST_OF_GOODS_SOLD')
        AND entry."occurredAt" < ${cutoff}
        AND (entry."sourceKind" = 'PHARMACY_SALE_LINE' AND entry."sourceId" = l.id
          OR entry."sourceKind" = 'PHARMACY_SALE_RETURN_LINE' AND EXISTS (
            SELECT 1 FROM pharmacy_sale_return_lines r WHERE r."organizationId" = l."organizationId"
              AND r."branchId" = l."branchId" AND r."saleLineId" = l.id AND r.id = entry."sourceId"
              AND r."createdAt" < ${cutoff})
          OR entry."sourceKind" = 'PHARMACY_UNIDENTIFIED_RETURN_HOLD' AND EXISTS (
            SELECT 1 FROM pharmacy_unidentified_return_holds h WHERE h."organizationId" = l."organizationId"
              AND h."branchId" = l."branchId" AND h."saleLineId" = l.id AND h.id = entry."sourceId"
              AND h."createdAt" < ${cutoff}))
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_sale_return_lines r
          WHERE r."organizationId"=l."organizationId" AND r."branchId"=l."branchId" AND r."saleLineId"=l.id
            AND r."createdAt" < ${cutoff} AND NOT EXISTS (
              SELECT 1 FROM finance_journal_entries e WHERE e."organizationId"=r."organizationId"
                AND e."sourceKind"='PHARMACY_SALE_RETURN_LINE' AND e."sourceId"=r.id AND e."occurredAt" < ${cutoff}))
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_unidentified_return_holds h
          WHERE h."organizationId"=l."organizationId" AND h."branchId"=l."branchId" AND h."saleLineId"=l.id
            AND h."createdAt" < ${cutoff} AND NOT EXISTS (
              SELECT 1 FROM finance_journal_entries e WHERE e."organizationId"=h."organizationId"
                AND e."sourceKind"='PHARMACY_UNIDENTIFIED_RETURN_HOLD' AND e."sourceId"=h.id AND e."occurredAt" < ${cutoff}))
      HAVING COUNT(*) FILTER (WHERE entry."sourceKind" = 'PHARMACY_SALE_LINE') > 0
    ) money ON true
    WHERE s."organizationId" = ${organizationId} AND s."branchId" IN (${Prisma.join(branchIds)})
      AND s.status = 'COMPLETED' AND s."customerId" IS NOT NULL AND s."receiptNumber" IS NOT NULL
      AND s."completedAt" >= ${from} AND s."completedAt" < ${cutoff}
    ORDER BY s."completedAt", s.id LIMIT 5001
  `);
}

export async function generateMarketingAttribution(
  db: ScopedDb,
  scope: MarketingScope,
  from: Date,
  cutoff: Date
) {
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(cutoff.getTime()) ||
    from >= cutoff ||
    cutoff.getTime() - from.getTime() > 90 * 86400000
  )
    throw new Error('Attribution requires a bounded window of at most 90 days.');
  const receipts = await eligibleMarketingReceipts(
    db,
    scope.organizationId,
    [scope.branchId],
    from,
    cutoff
  );
  if (receipts.length > 5000) throw new Error('Narrow the attribution window.');
  let created = 0;
  for (const receipt of receipts) {
    const result = await db.pharmacyCampaignAttribution.createMany({
      skipDuplicates: true,
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        campaignId: receipt.campaignId,
        visitId: `receipt:${receipt.receiptId}`,
        receiptId: receipt.receiptId,
        method: ATTRIBUTION_METHOD,
        windowDays: WINDOW_DAYS,
        confidence: 'ESTIMATED',
        exclusions: {
          captureId: receipt.captureId,
          cutoff: cutoff.toISOString(),
          returns: 'POSTED_FINANCE_AMOUNTS',
          visitDefinition: 'COMPLETED_RECEIPT',
        },
        recoveredSalesMinor: receipt.salesMinor,
        recoveredMarginMinor: receipt.marginMinor,
        messageCostMinor: 0,
        attributedAt: receipt.completedAt,
      },
    });
    created += result.count;
  }
  return { created, eligible: receipts.length, estimated: true, messageCostKnown: false };
}
