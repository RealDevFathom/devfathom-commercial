import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { MarketingScope } from './marketing-service';

/** Internal rows only: identifiers never cross the model gateway. Zero-valued legs need no journal line. */
export function growthReceiptMoney(cutoff: Date) {
  return Prisma.sql`
    SELECT COUNT(*) > 0 AND BOOL_AND(COALESCE(
      posted.entries > 0 AND posted.gross = l."grossMinor"::bigint
      AND posted.discount = l."discountMinor" AND posted.cost = allocated.cost
      AND allocated.units = l."canonicalUnits"
      AND NOT EXISTS (
        SELECT 1 FROM pharmacy_sale_return_lines r
        WHERE r."organizationId"=l."organizationId" AND r."branchId"=l."branchId" AND r."saleLineId"=l.id
          AND r."createdAt" < ${cutoff} AND NOT EXISTS (
            SELECT 1 FROM finance_journal_entries e WHERE e."organizationId"=r."organizationId"
              AND e."sourceKind"='PHARMACY_SALE_RETURN_LINE' AND e."sourceId"=r.id AND e."occurredAt" < ${cutoff}
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM pharmacy_unidentified_return_holds h
        WHERE h."organizationId"=l."organizationId" AND h."branchId"=l."branchId" AND h."saleLineId"=l.id
          AND h."createdAt" < ${cutoff} AND NOT EXISTS (
            SELECT 1 FROM finance_journal_entries e WHERE e."organizationId"=h."organizationId"
              AND e."sourceKind"='PHARMACY_UNIDENTIFIED_RETURN_HOLD' AND e."sourceId"=h.id AND e."occurredAt" < ${cutoff}
          )
      )
    ,false)) AS complete, COALESCE(SUM(posted.sales),0) AS sales, COALESCE(SUM(posted.margin),0) AS margin
    FROM pharmacy_sale_lines l
    LEFT JOIN LATERAL (
      SELECT SUM(a."canonicalUnits") AS units, SUM(a."canonicalUnits"::bigint * lot."unitCostMinor") AS cost
      FROM pharmacy_sale_line_allocations a JOIN pharmacy_inventory_lots lot
        ON lot."organizationId"=a."organizationId" AND lot."branchId"=a."branchId" AND lot.id=a."inventoryLotId"
      WHERE a."organizationId"=l."organizationId" AND a."branchId"=l."branchId" AND a."saleLineId"=l.id
    ) allocated ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT e.id) FILTER (WHERE e."sourceKind"='PHARMACY_SALE_LINE') AS entries,
        COALESCE(SUM(j."amountMinor") FILTER (WHERE e."sourceKind"='PHARMACY_SALE_LINE' AND j."accountCode"='SALES_REVENUE' AND j.side='CREDIT'),0) AS gross,
        COALESCE(SUM(j."amountMinor") FILTER (WHERE e."sourceKind"='PHARMACY_SALE_LINE' AND j."accountCode"='SALES_DISCOUNT' AND j.side='DEBIT'),0) AS discount,
        COALESCE(SUM(j."amountMinor") FILTER (WHERE e."sourceKind"='PHARMACY_SALE_LINE' AND j."accountCode"='COST_OF_GOODS_SOLD' AND j.side='DEBIT'),0) AS cost,
        COALESCE(SUM(CASE WHEN j."accountCode" IN ('SALES_REVENUE','SALES_DISCOUNT') THEN CASE WHEN j.side='CREDIT' THEN j."amountMinor" ELSE -j."amountMinor" END ELSE 0 END),0) AS sales,
        COALESCE(SUM(CASE WHEN j.side='CREDIT' THEN j."amountMinor" ELSE -j."amountMinor" END),0) AS margin
      FROM finance_journal_entries e JOIN finance_journal_lines j ON j."organizationId"=e."organizationId" AND j."entryId"=e.id
      WHERE j."organizationId"=l."organizationId" AND j."branchId"=l."branchId" AND j."sourceLineId"=l.id
        AND e."occurredAt" < ${cutoff} AND j."accountCode" IN ('SALES_REVENUE','SALES_DISCOUNT','COST_OF_GOODS_SOLD')
        AND (e."sourceKind"='PHARMACY_SALE_LINE' AND e."sourceId"=l.id OR e."sourceKind"='PHARMACY_SALE_RETURN_LINE' AND EXISTS (
          SELECT 1 FROM pharmacy_sale_return_lines r WHERE r."organizationId"=l."organizationId" AND r."branchId"=l."branchId" AND r."saleLineId"=l.id AND r.id=e."sourceId" AND r."createdAt" < ${cutoff})
          OR e."sourceKind"='PHARMACY_UNIDENTIFIED_RETURN_HOLD' AND EXISTS (
          SELECT 1 FROM pharmacy_unidentified_return_holds h WHERE h."organizationId"=l."organizationId" AND h."branchId"=l."branchId" AND h."saleLineId"=l.id AND h.id=e."sourceId" AND h."createdAt" < ${cutoff}))
    ) posted ON true
    WHERE l."organizationId"=s."organizationId" AND l."branchId"=s."branchId" AND l."saleId"=s.id
  `;
}

/** TEST-only diagnostic over persisted sandbox delivery + synthetic receipt/Finance rows.
 * No attribution writes, provider input, Meta totals, or causal claim. Dedicated admitted local DB only.
 */
export async function readGrowthSandboxDiagnostic(
  db: ScopedDb,
  scope: MarketingScope,
  insightId: string,
  cutoff: Date
) {
  const url = process.env.PHARMACY_MARKETING_TEST_RUNTIME_DATABASE_URL;
  if (
    process.env.PHARMACY_MARKETING_DB_ADMITTED !== 'true' ||
    !url ||
    new URL(url).hostname !== '127.0.0.1' ||
    new URL(url).port !== '55625'
  )
    throw new Error('Synthetic DB55625 admission required.');
  const identity = await db.$queryRaw<Array<{ port: number; database: string }>>(
    Prisma.sql`SELECT inet_server_port() AS port, current_database() AS database`
  );
  if (identity[0]?.port !== 55625 || identity[0]?.database !== new URL(url).pathname.slice(1))
    throw new Error('Synthetic database mismatch.');
  const rows = await db.$queryRaw<
    Array<{
      receiptId: string;
      campaignId: string;
      captureId: string;
      salesMinor: string;
      marginMinor: string;
    }>
  >(Prisma.sql`
    SELECT s.id AS "receiptId", chosen."campaignId", chosen.id AS "captureId", money.sales::text AS "salesMinor", money.margin::text AS "marginMinor"
    FROM pharmacy_sales s
    JOIN LATERAL (
      SELECT c.id,c."campaignId" FROM pharmacy_growth_reviews review
      JOIN pharmacy_campaign_captures c ON c."organizationId"=review."organizationId" AND c."branchId"=review."branchId" AND c."campaignId"=review."campaignId"
      JOIN pharmacy_campaign_dispatch_attempts a ON a."organizationId"=c."organizationId" AND a."captureId"=c.id AND a.provider='sandbox'
      JOIN pharmacy_campaign_delivery_events e ON e."organizationId"=a."organizationId" AND e."attemptId"=a.id AND e.state='DELIVERED'
      WHERE review."organizationId"=s."organizationId" AND review."branchId"=s."branchId" AND review."insightId"=${insightId} AND review.decision='APPROVE'
        AND c."customerId"=s."customerId" AND c."capturedAt"<=e."occurredAt" AND e."occurredAt"<=s."completedAt"
        AND e."occurredAt">=s."completedAt"-interval '7 days' AND e."recordedAt"<${cutoff}
        AND NOT EXISTS (SELECT 1 FROM pharmacy_campaign_delivery_events conflict WHERE conflict."organizationId"=a."organizationId" AND conflict."attemptId"=a.id AND conflict.state IN ('FAILED','UNKNOWN','SUPPRESSED') AND conflict."recordedAt"<${cutoff})
      ORDER BY e."occurredAt" DESC,c.id LIMIT 1
    ) chosen ON true
    JOIN LATERAL (${growthReceiptMoney(cutoff)}) money ON money.complete
    WHERE s."organizationId"=${scope.organizationId} AND s."branchId"=${scope.branchId} AND s.status='COMPLETED' AND s."receiptNumber" IS NOT NULL AND s."completedAt"<${cutoff}
    ORDER BY s.id LIMIT 5001
  `);
  if (rows.length > 5000) throw new Error('Narrow diagnostic scope.');
  return {
    environment: 'TEST_SANDBOX' as const,
    method: 'SYNTHETIC_SANDBOX_RECEIPT_FINANCE_V1' as const,
    observational: true,
    messageCostMinor: null,
    rows,
  };
}
