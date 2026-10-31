import 'server-only';
import { growthReceiptMoney } from './growth-evidence';
import { readPharmacyMarketingReport } from './marketing-report';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
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
export function growthPeriods(from: Date, cutoff: Date, now = new Date()) {
  const duration = cutoff.getTime() - from.getTime();
  if (!Number.isFinite(duration) || duration < 86400000 || duration > 90 * 86400000 || cutoff > now)
    throw new MarketingWorkflowError('Use a completed period of one to ninety days.');
  return {
    current: { from: from.toISOString(), cutoff: cutoff.toISOString() },
    comparison: {
      from: new Date(from.getTime() - duration).toISOString(),
      cutoff: from.toISOString(),
    },
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
  const periods = growthPeriods(from, cutoff, now);
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
    // Report's date interface is UTC-day bounded; never silently widen sub-day periods.
    if (p.from.endsWith('T00:00:00.000Z') && p.cutoff.endsWith('T00:00:00.000Z')) {
      const report = await readPharmacyMarketingReport(db, scope.organizationId, {
        branchIds: [scope.branchId],
        from: p.from.slice(0, 10),
        to: new Date(new Date(p.cutoff).getTime() - 86400000).toISOString().slice(0, 10),
      });
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
  }
  // Pharmacy Finance is PKR minor units; no client-supplied currency or values.
  return prepareGrowthInput({
    vertical: 'PHARMACY',
    ...periods,
    currency: 'PKR',
    facts,
    actions: [{ ref: 'a1', kind: 'RETAIL_REVIEW' }],
  });
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
  if (!rec || snapshot.actions.find((a) => a.ref === rec.actionRef)?.kind !== 'RETAIL_REVIEW')
    throw new MarketingWorkflowError('Unsupported recommendation.');
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
