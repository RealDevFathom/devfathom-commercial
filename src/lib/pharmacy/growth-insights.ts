import 'server-only';
import { growthReceiptMoney } from './growth-evidence';
import { readPharmacyMarketingReportWindow } from './marketing-report';
import { localCalendarDays, localDayStart, shiftDay } from './marketing-dates';
import { workspaceToday } from '@/lib/timezone';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  PHARMACY_GROWTH_ACTION_KINDS,
  growthInputSchema,
  prepareGrowthInput,
  validateGrowthOutput,
  type GrowthInput,
  type GrowthResult,
} from '@/lib/ai/growth-recommendations';
import {
  createMarketingDraft,
  marketingDraftInput,
  MarketingWorkflowError,
  type MarketingScope,
} from './marketing-service';

export const growthPeriodInput = z
  .object({ branchId: z.string().min(1).max(128), from: z.date(), cutoff: z.date() })
  .strict();
export const growthReviewInput = z
  .object({
    branchId: z.string().min(1).max(128),
    insightId: z.string().uuid(),
    recommendation: z.number().int().min(0).max(2),
    decision: z.enum(['EDIT', 'REJECT', 'APPROVE']),
    // Only human-reviewed presentation/scheduling settings may change. Segment/caps remain server-owned.
    edit: z
      .object({
        name: z.string().trim().min(1).max(100),
        templateId: z.string().min(1).max(128),
        scheduledAt: z.date(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type GrowthInsightRow = {
  id: string;
  status: GrowthResult['status'];
  failureCode: GrowthResult['failureCode'];
  provider: string | null;
  model: string | null;
  inputHash: string;
  schemaVersion: number;
  snapshot: GrowthInput;
  output: GrowthResult['output'];
  createdAt: Date;
};
export type GrowthReviewRow = {
  insightId: string;
  recommendation: number;
  decision: 'EDIT' | 'REJECT' | 'APPROVE';
  settings: { name: string; templateId: string; scheduledAt: string } | null;
  campaignId: string | null;
  createdAt: Date;
};
export function growthPeriods(from: Date, cutoff: Date, now = new Date(), timeZone?: string) {
  const duration = cutoff.getTime() - from.getTime();
  // Local-midnight bounds count calendar days, so a day or range crossing a daylight-saving
  // change is still the one to ninety days the owner chose; other bounds keep elapsed time.
  const days = timeZone ? localCalendarDays(from, cutoff, timeZone) : null;
  const bounded =
    days === null ? duration >= 86400000 && duration <= 90 * 86400000 : days >= 1 && days <= 90;
  if (!Number.isFinite(duration) || !bounded || cutoff > now)
    throw new MarketingWorkflowError('Use a completed period of one to ninety days.');
  const comparisonFrom =
    days === null
      ? new Date(from.getTime() - duration)
      : localDayStart(shiftDay(workspaceToday(timeZone, from), -days), timeZone!);
  return {
    current: { from: from.toISOString(), cutoff: cutoff.toISOString() },
    comparison: { from: comparisonFrom.toISOString(), cutoff: from.toISOString() },
  };
}
/** Aggregate only. Exact signed Finance amounts; no customer/item/clinical fields leave this function. */
export async function buildPharmacyGrowthInput(
  db: ScopedDb,
  scope: MarketingScope,
  from: Date,
  cutoff: Date,
  now = new Date()
): Promise<GrowthInput> {
  const periods = growthPeriods(from, cutoff, now, scope.timezone);
  const facts: GrowthInput['facts'] = [];
  for (const [label, p] of [
    ['CURRENT', periods.current],
    ['COMPARISON', periods.comparison],
  ] as const) {
    const rows = await db.$queryRaw<
      Array<{ receipts: number; cohort: number; posted: number; sales: string; margin: string }>
    >(Prisma.sql`
      SELECT COUNT(*)::integer AS receipts, COUNT(DISTINCT s."customerId")::integer AS cohort,
        COUNT(*) FILTER (WHERE money.complete)::integer AS posted,
        COALESCE(SUM(money.sales),0)::text AS sales, COALESCE(SUM(money.margin),0)::text AS margin
      FROM pharmacy_sales s
      LEFT JOIN LATERAL (${growthReceiptMoney(new Date(p.cutoff))}) money ON true
      WHERE s."organizationId"=${scope.organizationId} AND s."branchId"=${scope.branchId} AND s.status='COMPLETED'
        AND s."receiptNumber" IS NOT NULL AND s."customerId" IS NOT NULL AND s."completedAt">=${new Date(p.from)} AND s."completedAt"<${new Date(p.cutoff)}
    `);
    const row = rows[0];
    if (row && row.cohort >= 10) {
      facts.push({
        ref: `e${facts.length + 1}`,
        metric: 'receipt_count',
        value: String(row.receipts),
        period: label,
        cohortSize: row.cohort,
        coverage: 'COMPLETE',
        freshAt: now.toISOString(),
      });
      // Missing posting coverage must not expose money from an unsuppressed small subcohort.
      if (row.posted === row.receipts)
        for (const [metric, value] of [
          ['settled_sales_minor', row.sales],
          ['posted_margin_minor', row.margin],
        ] as const)
          facts.push({
            ref: `e${facts.length + 1}`,
            metric,
            value,
            period: label,
            cohortSize: row.cohort,
            coverage: 'COMPLETE',
            freshAt: now.toISOString(),
          });
    }
    // Audience is current consent among this period's customer-linked receipt cohort, not historical permission.
    const audience = await db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::integer AS count FROM pharmacy_customers c
      JOIN LATERAL (SELECT granted,"revokedAt","recordedAt" FROM pharmacy_patient_consents p
        WHERE p."organizationId"=c."organizationId" AND p."patientId"=c."patientId" AND p.purpose='MARKETING' AND p.channel='WHATSAPP'
        ORDER BY p.version DESC,p.id ASC LIMIT 1) consent ON true
      WHERE c."organizationId"=${scope.organizationId} AND c.active AND c."whatsappOptIn"=true
        AND consent.granted AND consent."revokedAt" IS NULL AND consent."recordedAt"<=${now}
        AND EXISTS (SELECT 1 FROM pharmacy_sales s WHERE s."organizationId"=c."organizationId" AND s."branchId"=${scope.branchId}
          AND s."customerId"=c.id AND s.status='COMPLETED' AND s."receiptNumber" IS NOT NULL AND s."completedAt">=${new Date(p.from)} AND s."completedAt"<${new Date(p.cutoff)})
    `);
    if ((audience[0]?.count ?? 0) >= 10)
      facts.push({
        ref: `e${facts.length + 1}`,
        metric: 'consent_eligible_retail_count',
        value: String(audience[0].count),
        period: label,
        cohortSize: audience[0].count,
        coverage: 'COMPLETE',
        freshAt: now.toISOString(),
      });
    // Whole UTC or workspace-local days read the report over exactly this window; never
    // silently widen sub-day periods.
    if (
      (p.from.endsWith('T00:00:00.000Z') && p.cutoff.endsWith('T00:00:00.000Z')) ||
      localCalendarDays(new Date(p.from), new Date(p.cutoff), scope.timezone) !== null
    ) {
      const report = await readPharmacyMarketingReportWindow(
        db,
        scope.organizationId,
        [scope.branchId],
        {
          gte: new Date(p.from),
          lt: new Date(p.cutoff),
        }
      );
      const cohorts = await db.$queryRaw<Array<{ delivered: number }>>(Prisma.sql`
        SELECT COUNT(DISTINCT c."customerId")::integer AS delivered
        FROM pharmacy_campaign_captures c
        WHERE c."organizationId"=${scope.organizationId} AND c."branchId"=${scope.branchId} AND c."capturedAt">=${new Date(p.from)} AND c."capturedAt"<${new Date(p.cutoff)}
          AND EXISTS (SELECT 1 FROM pharmacy_campaign_dispatch_attempts a JOIN pharmacy_campaign_delivery_events e ON e."organizationId"=a."organizationId" AND e."attemptId"=a.id
            WHERE a."organizationId"=c."organizationId" AND a."captureId"=c.id AND a.provider='meta' AND a."reservedAt"<${new Date(p.cutoff)} AND e.state='DELIVERED' AND e."recordedAt"<${new Date(p.cutoff)} AND e."occurredAt"<${new Date(p.cutoff)}
              AND NOT EXISTS (SELECT 1 FROM pharmacy_campaign_delivery_events conflict WHERE conflict."organizationId"=a."organizationId" AND conflict."attemptId"=a.id AND conflict.state IN ('FAILED','UNKNOWN','SUPPRESSED') AND conflict."recordedAt"<${new Date(p.cutoff)}))
      `);
      if (cohorts[0]?.delivered >= 10 && report.contradictory === 0)
        facts.push({
          ref: `e${facts.length + 1}`,
          metric: 'meta_delivered_count',
          value: String(report.delivered),
          period: label,
          cohortSize: cohorts[0].delivered,
          coverage: 'COMPLETE',
          freshAt: now.toISOString(),
        });
      const linked = await db.$queryRaw<Array<{ cohort: number; complete: boolean }>>(Prisma.sql`
        SELECT COUNT(DISTINCT s."customerId")::integer AS cohort, BOOL_AND(money.complete) AS complete
        FROM pharmacy_campaign_attributions x
        JOIN pharmacy_sales s ON s."organizationId"=x."organizationId" AND s."branchId"=x."branchId" AND s.id=x."receiptId"
        JOIN LATERAL (${growthReceiptMoney(new Date(p.cutoff))}) money ON true
        WHERE x."organizationId"=${scope.organizationId} AND x."branchId"=${scope.branchId}
          AND x."attributedAt">=${new Date(p.from)} AND x."attributedAt"<${new Date(p.cutoff)}
      `);
      // Every stored link must verify in the existing Meta report; every linked receipt needs full Finance coverage.
      if (
        linked[0]?.cohort >= 10 &&
        linked[0].complete &&
        report.attribution.excludedUnverifiedLinks === 0
      )
        facts.push({
          ref: `e${facts.length + 1}`,
          metric: 'meta_attributed_sales_minor',
          value: String(report.attribution.recoveredSalesMinor),
          period: label,
          cohortSize: linked[0].cohort,
          coverage: 'PARTIAL',
          freshAt: now.toISOString(),
        });
    }
    facts.push(...(await pharmacyLoyaltyAndInventoryFacts(db, scope, label, p, now, facts.length)));
  }
  // RETAIL_REVIEW stays a1 for history compatibility. Loyalty and inventory-cost reviews are
  // offered only when grounded, unsuppressed evidence for them exists in this snapshot.
  const actions: GrowthInput['actions'] = [{ ref: 'a1', kind: 'RETAIL_REVIEW' }];
  if (facts.some((f) => f.metric === 'loyalty_eligible_count'))
    actions.push({ ref: `a${actions.length + 1}`, kind: 'LOYALTY_REVIEW' });
  if (facts.some((f) => f.metric === 'wastage_minor' || f.metric === 'inventory_value_minor'))
    actions.push({ ref: `a${actions.length + 1}`, kind: 'INVENTORY_COST_REVIEW' });
  // Pharmacy Finance is PKR minor units; no client-supplied currency or values.
  return prepareGrowthInput({
    vertical: 'PHARMACY',
    ...periods,
    currency: 'PKR',
    facts,
    actions,
  });
}
/**
 * Aggregate loyalty and inventory-cost evidence for one period. Counts and branch totals only:
 * no customer, patient, product, lot or clinical field leaves this function.
 */
export async function pharmacyLoyaltyAndInventoryFacts(
  db: ScopedDb,
  scope: MarketingScope,
  label: 'CURRENT' | 'COMPARISON',
  p: { from: string; cutoff: string },
  now: Date,
  offset: number
): Promise<GrowthInput['facts']> {
  const facts: GrowthInput['facts'] = [];
  const from = new Date(p.from);
  const cutoff = new Date(p.cutoff);
  const fact = (
    metric: GrowthInput['facts'][number]['metric'],
    value: string,
    cohortSize: number,
    coverage: GrowthInput['facts'][number]['coverage']
  ) =>
    facts.push({
      ref: `e${offset + facts.length + 1}`,
      metric,
      value,
      period: label,
      cohortSize,
      coverage,
      freshAt: now.toISOString(),
    });
  // Loyalty cohort: active customers who earned points in this branch during the period and whose
  // latest LOYALTY consent is currently granted. Current consent, not historical permission.
  const loyalty = await db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(DISTINCT c.id)::integer AS count FROM pharmacy_customers c
    JOIN LATERAL (SELECT granted,"revokedAt","recordedAt" FROM pharmacy_patient_consents pc
      WHERE pc."organizationId"=c."organizationId" AND pc."patientId"=c."patientId" AND pc.purpose='LOYALTY'
      ORDER BY pc.version DESC,pc."recordedAt" DESC,pc.id ASC LIMIT 1) consent ON true
    WHERE c."organizationId"=${scope.organizationId} AND c.active
      AND consent.granted AND consent."revokedAt" IS NULL AND consent."recordedAt"<=${now}
      AND EXISTS (SELECT 1 FROM pharmacy_loyalty_points_entries l WHERE l."organizationId"=c."organizationId"
        AND l."branchId"=${scope.branchId} AND l."customerId"=c.id AND l.kind IN ('EARN','KHATA_EARN')
        AND l."occurredAt">=${from} AND l."occurredAt"<${cutoff})
  `);
  const eligible = loyalty[0]?.count ?? 0;
  if (eligible >= 10) fact('loyalty_eligible_count', String(eligible), eligible, 'COMPLETE');
  // Wastage: exact posted INVENTORY_WRITE_OFF cost for this period's original write-off movements.
  // Any unposted or reversed write-off withholds the money rather than understating it.
  const wastage = await db.$queryRaw<
    Array<{ movements: number; posted: number; reversed: number; amount: string }>
  >(Prisma.sql`
    SELECT COUNT(*)::integer AS movements,
      COUNT(*) FILTER (WHERE posting.entries > 0)::integer AS posted,
      COUNT(*) FILTER (WHERE reversal.found)::integer AS reversed,
      COALESCE(SUM(posting.amount),0)::text AS amount
    FROM pharmacy_stock_movements m
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT e.id) AS entries,
        COALESCE(SUM(CASE WHEN j.side='DEBIT' THEN j."amountMinor" ELSE -j."amountMinor" END),0) AS amount
      FROM finance_journal_entries e JOIN finance_journal_lines j ON j."organizationId"=e."organizationId" AND j."entryId"=e.id
      WHERE e."organizationId"=m."organizationId" AND e."sourceKind"='PHARMACY_STOCK_WRITE_OFF' AND e."sourceId"=m.id
        AND e."occurredAt"<${cutoff} AND j."accountCode"='INVENTORY_WRITE_OFF' AND j."branchId"=m."branchId"
    ) posting ON true
    LEFT JOIN LATERAL (
      SELECT EXISTS (SELECT 1 FROM pharmacy_stock_movements r WHERE r."organizationId"=m."organizationId"
        AND r."reversesMovementId"=m.id AND r."occurredAt"<${cutoff}) AS found
    ) reversal ON true
    WHERE m."organizationId"=${scope.organizationId} AND m."branchId"=${scope.branchId} AND m.kind='WRITE_OFF'
      AND m."reversesMovementId" IS NULL AND m."occurredAt">=${from} AND m."occurredAt"<${cutoff}
  `);
  const w = wastage[0];
  if (w && w.movements >= 10 && w.posted === w.movements && w.reversed === 0)
    fact('wastage_minor', w.amount, w.movements, 'COMPLETE');
  // Valuation: eligible AVAILABLE ledger units at cutoff times frozen lot receipt cost.
  // Batch safety state is current (there is no versioned batch-state history), so recalled or
  // quarantined batches are conservatively excluded even for earlier cutoffs. Receipt and expiry
  // eligibility use the cutoff and the same stored exclusive expiry boundary as the allocator.
  // This is a stock-ledger estimate, not the posted Finance inventory balance: always ESTIMATED.
  const valuation = await db.$queryRaw<Array<{ lots: number; value: string }>>(Prisma.sql`
    SELECT COUNT(*)::integer AS lots, COALESCE(SUM(held.units * held.cost),0)::text AS value FROM (
      SELECT m."inventoryLotId", SUM(m."quantityUnits")::bigint AS units, MAX(lot."unitCostMinor")::bigint AS cost
      FROM pharmacy_stock_movements m JOIN pharmacy_inventory_lots lot
        ON lot."organizationId"=m."organizationId" AND lot."branchId"=m."branchId" AND lot.id=m."inventoryLotId"
      JOIN pharmacy_manufacturing_batches batch
        ON batch."organizationId"=lot."organizationId" AND batch.id=lot."manufacturingBatchId"
      WHERE m."organizationId"=${scope.organizationId} AND m."branchId"=${scope.branchId}
        AND m.disposition='AVAILABLE' AND m."occurredAt"<${cutoff}
        AND lot."receivedAt" IS NOT NULL AND lot."receivedAt"<=${cutoff}
        AND batch.state='ACTIVE'
        AND batch."expiresAt">${cutoff}
      GROUP BY m."inventoryLotId" HAVING SUM(m."quantityUnits")>0
    ) held
  `);
  const v = valuation[0];
  if (v && v.lots >= 10) fact('inventory_value_minor', v.value, v.lots, 'ESTIMATED');
  return facts;
}
export async function saveGrowthInsight(db: ScopedDb, scope: MarketingScope, result: GrowthResult) {
  const id = randomUUID();
  await db.$executeRaw(Prisma.sql`INSERT INTO growth_insights
    (id,"organizationId","branchId",vertical,"actorId","schemaVersion","inputHash",status,"failureCode",provider,model,snapshot,output)
    VALUES (${id},${scope.organizationId},${scope.branchId},'PHARMACY',${scope.actorId},${result.schemaVersion},${result.inputHash},${result.status},${result.failureCode},${result.provider},${result.model},${JSON.stringify(result.input)}::jsonb,${result.output ? JSON.stringify(result.output) : null}::jsonb)`);
  return { id, status: result.status, failureCode: result.failureCode };
}
export async function listGrowthInsights(db: ScopedDb, scope: MarketingScope) {
  const insights = await db.$queryRaw<GrowthInsightRow[]>(
    Prisma.sql`SELECT id,status,"failureCode",provider,model,"inputHash","schemaVersion",snapshot,output,"createdAt" FROM growth_insights WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND vertical='PHARMACY' AND provider IS DISTINCT FROM 'DETERMINISTIC_BASKET' ORDER BY "createdAt" DESC,id DESC LIMIT 20`
  );
  const reviews = insights.length
    ? await db.$queryRaw<GrowthReviewRow[]>(
        Prisma.sql`SELECT "insightId",recommendation,decision,settings,"campaignId","createdAt" FROM pharmacy_growth_reviews WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND "insightId" IN (${Prisma.join(insights.map((i) => i.id))}) ORDER BY "createdAt" DESC,id DESC`
      )
    : [];
  return { insights, reviews };
}
/** Caller rechecks current owner/package/branch in the SAME transaction. Row lock serializes review replay. */
export async function reviewGrowthInsight(
  db: ScopedDb,
  scope: MarketingScope,
  raw: z.infer<typeof growthReviewInput>,
  now = new Date()
) {
  const input = growthReviewInput.parse(raw);
  if (input.branchId !== scope.branchId) throw new MarketingWorkflowError('Branch mismatch.');
  const rows = await db.$queryRaw<GrowthInsightRow[]>(
    Prisma.sql`SELECT * FROM growth_insights WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${input.insightId} AND vertical='PHARMACY' FOR UPDATE`
  );
  const insight = rows[0];
  if (!insight || insight.status !== 'READY')
    throw new MarketingWorkflowError('Ready insight not found in this branch.');
  const snapshot = growthInputSchema.parse(insight.snapshot);
  const output = validateGrowthOutput(insight.output, snapshot);
  const rec = output.recommendations[input.recommendation];
  const kind = rec && snapshot.actions.find((a) => a.ref === rec.actionRef)?.kind;
  if (!kind || !(PHARMACY_GROWTH_ACTION_KINDS as readonly string[]).includes(kind))
    throw new MarketingWorkflowError('Unsupported recommendation.');
  // Loyalty and inventory-cost reviews never create campaigns, recipients, stock or price changes.
  // A human may only dismiss them here; the work itself happens in the linked workspace.
  if (kind !== 'RETAIL_REVIEW' && input.decision !== 'REJECT')
    throw new MarketingWorkflowError(
      'Loyalty and inventory reviews are review-only. Open the linked workspace or reject the insight.'
    );
  const prior = await db.$queryRaw<
    Array<{ decision: string; campaignId: string | null; settings: GrowthReviewRow['settings'] }>
  >(
    Prisma.sql`SELECT decision,"campaignId",settings FROM pharmacy_growth_reviews WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND "insightId"=${input.insightId} AND recommendation=${input.recommendation} AND decision IN ('APPROVE','REJECT')`
  );
  if (prior.length) {
    if (prior[0].decision !== input.decision)
      throw new MarketingWorkflowError('Recommendation already resolved.');
    if (
      input.decision === 'APPROVE' &&
      (!input.edit ||
        prior[0].settings?.name !== input.edit.name ||
        prior[0].settings?.templateId !== input.edit.templateId ||
        prior[0].settings?.scheduledAt !== input.edit.scheduledAt.toISOString())
    )
      throw new MarketingWorkflowError('Approval replay settings conflict with saved draft.');
    return { decision: prior[0].decision, campaignId: prior[0].campaignId, replay: true };
  }
  if (
    input.decision !== 'REJECT' &&
    (!input.edit ||
      input.edit.scheduledAt < now ||
      now.getTime() - insight.createdAt.getTime() > 7 * 86400000)
  )
    throw new MarketingWorkflowError(
      'Provide reviewed draft settings and a future schedule; regenerate insights older than seven days.'
    );
  let campaignId: string | null = null;
  if (input.decision === 'APPROVE') {
    const campaign = await createMarketingDraft(
      db,
      scope,
      marketingDraftInput.parse({
        ...input.edit,
        branchId: scope.branchId,
        definition: { version: 1, all: [{ field: 'receiptCount', operator: 'gte', value: 1 }] },
        quietHours: { startHour: 22, endHour: 8 },
        frequencyCap: { max: 1, windowDays: 7 },
        promotesRegulatedItem: false,
      })
    );
    campaignId = campaign.id;
  }
  await db.$executeRaw(
    Prisma.sql`INSERT INTO pharmacy_growth_reviews (id,"organizationId","branchId","insightId",recommendation,decision,"actorId",settings,"campaignId") VALUES (${randomUUID()},${scope.organizationId},${scope.branchId},${input.insightId},${input.recommendation},${input.decision},${scope.actorId},${input.edit ? JSON.stringify(input.edit) : null}::jsonb,${campaignId})`
  );
  return { decision: input.decision, campaignId, replay: false };
}
