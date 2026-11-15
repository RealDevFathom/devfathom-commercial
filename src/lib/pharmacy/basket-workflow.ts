import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import { bundleProposalWhatsAppText, mineBundleProposals } from './basket-analysis';
import { growthPeriodInput, growthPeriods, type GrowthReviewRow } from './growth-insights';
import {
  approveMarketingTemplate,
  createMarketingDraft,
  MarketingWorkflowError,
  type MarketingScope,
} from './marketing-service';

// A distinct source in the existing immutable growth ledger; never sent to an AI provider.
const SOURCE = 'DETERMINISTIC_BASKET';
export const basketGenerateInput = growthPeriodInput
  .extend({
    config: z
      .object({
        minimumPairCount: z.number().int().min(1),
        minimumSupport: z.number().min(0).max(1),
        minimumConfidence: z.number().min(0).max(1),
        minimumLift: z.number().min(0),
        // The shared review ledger supports three recommendations per snapshot.
        maximumProposals: z.number().int().min(1).max(3),
      })
      .strict(),
  })
  .strict();
export const basketReviewInput = z
  .object({
    branchId: z.string().min(1).max(128),
    insightId: z.string().uuid(),
    recommendation: z.number().int().min(0).max(2),
    decision: z.enum(['APPROVE', 'REJECT']),
    pinCredential: z
      .string()
      .regex(/^\d{4,8}$/)
      .optional(),
    scheduledAt: z.date().optional(),
  })
  .strict();

type BasketSnapshot = {
  from: string;
  cutoff: string;
  config: z.infer<typeof basketGenerateInput>['config'];
};
type BasketInsight = {
  id: string;
  snapshot: BasketSnapshot;
  output: { recommendations: ReturnType<typeof mineBundleProposals> };
  createdAt: Date;
};

/** Caller supplies the current owner scope and one tenant transaction. No customer identifiers or patient records are read. */
export async function generateBasketInsights(
  db: ScopedDb,
  scope: MarketingScope,
  raw: z.infer<typeof basketGenerateInput>
) {
  const input = basketGenerateInput.parse(raw);
  if (input.branchId !== scope.branchId) throw new MarketingWorkflowError('Branch mismatch.');
  growthPeriods(input.from, input.cutoff, new Date(), scope.timezone);
  const sales = await db.pharmacySale.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'COMPLETED',
      receiptNumber: { not: null },
      completedAt: { gte: input.from, lt: input.cutoff },
    },
    select: { id: true, lines: { select: { medicineId: true } } },
    orderBy: { id: 'asc' },
    take: 5001,
  });
  if (sales.length > 5000)
    throw new MarketingWorkflowError('Narrow the period to at most 5000 receipts.');
  const medicines = await db.medicine.findMany({
    where: {
      organizationId: scope.organizationId,
      id: { in: [...new Set(sales.flatMap((sale) => sale.lines.map((line) => line.medicineId)))] },
      saleable: true,
    },
    select: {
      id: true,
      productName: true,
      productFamily: true,
      rx: true,
      otc: true,
      restricted: true,
      controlled: true,
    },
  });
  const recommendations = mineBundleProposals(
    sales.map((sale) => ({ id: sale.id, productIds: sale.lines.map((line) => line.medicineId) })),
    medicines.map(({ productName, ...medicine }) => ({ ...medicine, name: productName })),
    input.config
  );
  const snapshot: BasketSnapshot = {
    from: input.from.toISOString(),
    cutoff: input.cutoff.toISOString(),
    config: input.config,
  };
  const id = randomUUID();
  const output = { recommendations };
  const hash = createHash('sha256').update(JSON.stringify({ snapshot, output })).digest('hex');
  await db.$executeRaw(Prisma.sql`INSERT INTO growth_insights
    (id,"organizationId","branchId",vertical,"actorId","schemaVersion","inputHash",status,provider,model,snapshot,output)
    VALUES (${id},${scope.organizationId},${scope.branchId},'PHARMACY',${scope.actorId},1,${hash},'READY',${SOURCE},'v1',${JSON.stringify(snapshot)}::jsonb,${JSON.stringify(output)}::jsonb)`);
  return { id, count: recommendations.length };
}

export async function listBasketInsights(db: ScopedDb, scope: MarketingScope) {
  const insights = await db.$queryRaw<BasketInsight[]>(Prisma.sql`
    SELECT id,snapshot,output,"createdAt" FROM growth_insights
    WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId}
      AND vertical='PHARMACY' AND provider=${SOURCE} AND model='v1'
    ORDER BY "createdAt" DESC,id DESC LIMIT 20`);
  const reviews = insights.length
    ? await db.$queryRaw<GrowthReviewRow[]>(Prisma.sql`
    SELECT "insightId",recommendation,decision,settings,"campaignId","createdAt" FROM pharmacy_growth_reviews
    WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId}
      AND "insightId" IN (${Prisma.join(insights.map((insight) => insight.id))})
    ORDER BY "createdAt" DESC,id DESC`)
    : [];
  return { insights, reviews };
}

/** A sole owner may approve their own proposal, but must verify their own current PIN. */
async function ownerPin(db: ScopedDb, scope: MarketingScope, pin: string | undefined, now: Date) {
  if (!pin) return null;
  const profiles = await db.restaurantStaffProfile.findMany({
    where: { organizationId: scope.organizationId, userId: scope.actorId, status: 'ACTIVE' },
    select: { id: true },
    take: 2,
  });
  if (profiles.length !== 1) return null;
  const staffProfileId = profiles[0].id;
  await db.$queryRaw(Prisma.sql`SELECT id FROM restaurant_operator_credentials
    WHERE "organizationId"=${scope.organizationId} AND "staffProfileId"=${staffProfileId}
      AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`);
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: scope.organizationId,
      staffProfileId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
    },
  });
  if (!credential || isLockedOut(credential, now)) return null;
  if (!(await verifyOperatorCredential('PIN', pin, credential.credentialHash))) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return null;
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  return { staffProfileId, ownerPinReauthenticatedAt: now.toISOString() };
}

export async function reviewBasketInsight(
  db: ScopedDb,
  scope: MarketingScope,
  raw: z.infer<typeof basketReviewInput>,
  now = new Date()
) {
  const input = basketReviewInput.parse(raw);
  if (input.branchId !== scope.branchId) throw new MarketingWorkflowError('Branch mismatch.');
  const rows = await db.$queryRaw<BasketInsight[]>(Prisma.sql`
    SELECT id,snapshot,output,"createdAt" FROM growth_insights
    WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${input.insightId}
      AND vertical='PHARMACY' AND provider=${SOURCE} AND model='v1' AND status='READY' FOR UPDATE`);
  const insight = rows[0];
  const proposal = insight?.output.recommendations[input.recommendation];
  if (!proposal) throw new MarketingWorkflowError('Bundle proposal not found in this branch.');
  const prior = await db.$queryRaw<GrowthReviewRow[]>(Prisma.sql`
    SELECT decision,"campaignId",settings FROM pharmacy_growth_reviews
    WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId}
      AND "insightId"=${input.insightId} AND recommendation=${input.recommendation} AND decision IN ('APPROVE','REJECT')`);
  if (prior.length) {
    if (
      prior[0].decision !== input.decision ||
      (input.decision === 'APPROVE' &&
        prior[0].settings?.scheduledAt !== input.scheduledAt?.toISOString())
    )
      throw new MarketingWorkflowError('Bundle proposal already resolved with different settings.');
    return { campaignId: prior[0].campaignId, replay: true };
  }
  let campaignId: string | null = null;
  let settings: Prisma.InputJsonValue | null = null;
  if (input.decision === 'APPROVE') {
    if (
      !input.scheduledAt ||
      input.scheduledAt < now ||
      now.getTime() - insight.createdAt.getTime() > 7 * 86400000
    )
      throw new MarketingWorkflowError(
        'Provide a future schedule and regenerate proposals older than seven days.'
      );
    // Recheck the live safety flags; a formerly eligible item may now be regulated.
    const current = await db.medicine.findMany({
      where: {
        organizationId: scope.organizationId,
        id: { in: proposal.productIds },
        saleable: true,
        rx: false,
        restricted: false,
        controlled: false,
        OR: [{ otc: true }, { productFamily: 'FRONT_SHOP' }],
      },
      select: { id: true },
    });
    if (current.length !== 2)
      throw new MarketingWorkflowError(
        'Bundle products are no longer eligible. Regenerate proposals.'
      );
    const proof = await ownerPin(db, scope, input.pinCredential, now);
    // Return refusal so failed-attempt counters commit with the tenant request transaction.
    if (!proof)
      return {
        blocked:
          'Enter your current owner PIN. Repeated failures lock the PIN for fifteen minutes.',
      };
    const template = await approveMarketingTemplate(
      db,
      scope,
      {
        branchId: scope.branchId,
        name: 'Reviewed bundle retail notice',
        body: bundleProposalWhatsAppText(),
        reviewed: true,
      },
      now
    );
    const campaign = await createMarketingDraft(db, scope, {
      branchId: scope.branchId,
      name: 'Basket bundle retail offer',
      templateId: template.id,
      scheduledAt: input.scheduledAt,
      definition: { version: 1, all: [{ field: 'receiptCount', operator: 'gte', value: 1 }] },
      quietHours: { startHour: 22, endHour: 8 },
      frequencyCap: { max: 1, windowDays: 7 },
      promotesRegulatedItem: false,
    });
    campaignId = campaign.id;
    settings = {
      ...proof,
      name: campaign.name,
      templateId: template.id,
      scheduledAt: input.scheduledAt.toISOString(),
    };
  }
  await db.$executeRaw(Prisma.sql`INSERT INTO pharmacy_growth_reviews
    (id,"organizationId","branchId","insightId",recommendation,decision,"actorId",settings,"campaignId")
    VALUES (${randomUUID()},${scope.organizationId},${scope.branchId},${input.insightId},${input.recommendation},${input.decision},${scope.actorId},${settings ? JSON.stringify(settings) : null}::jsonb,${campaignId})`);
  return { campaignId, replay: false };
}
