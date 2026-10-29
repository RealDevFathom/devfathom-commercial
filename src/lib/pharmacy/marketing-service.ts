import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';
import { z } from 'zod';
import { lockCustomerConsent } from './consent-writer';

const id = z.string().trim().min(1).max(128);
export const marketingScopeInput = z.object({ branchId: id }).strict();
export const marketingCampaignInput = marketingScopeInput.extend({ campaignId: id }).strict();
const rule = z
  .object({
    field: z.enum(['receiptCount', 'daysSinceLastReceipt']),
    operator: z.enum(['eq', 'gte', 'lte']),
    value: z.number().int().min(0).max(100000),
  })
  .strict();
const definition = z.object({ version: z.literal(1), all: z.array(rule).min(1).max(10) }).strict();
const quietHours = z
  .object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) })
  .strict();
const frequencyCap = z
  .object({ max: z.number().int().min(1).max(10), windowDays: z.number().int().min(1).max(90) })
  .strict();
export const VOUCHER_FOOTER = 'Medicines excluded / Adviyaat shamil nahin';
const eligibleCategoryAllowlist = z
  .array(z.literal('FRONT_SHOP'))
  .min(1)
  .max(1)
  .default(['FRONT_SHOP']);

export function renderMarketingBody(body: string, voucherEnabled: boolean) {
  if (!voucherEnabled || body.includes(VOUCHER_FOOTER)) return body;
  return `${body}\n\n${VOUCHER_FOOTER}`;
}
export const marketingDraftInput = marketingScopeInput
  .extend({
    name: z.string().trim().min(1).max(100),
    templateId: id,
    definition,
    scheduledAt: z.date(),
    quietHours,
    frequencyCap,
    promotesRegulatedItem: z.literal(false),
    voucherEnabled: z.boolean().default(false),
    eligibleCategoryAllowlist,
  })
  .strict();
export const marketingTemplateInput = marketingScopeInput
  .extend({
    name: z.string().trim().min(1).max(100),
    body: z.string().trim().min(1).max(1000),
    reviewed: z.literal(true),
  })
  .strict();
export type MarketingScope = {
  organizationId: string;
  branchId: string;
  actorId: string;
  timezone: string;
};

export class MarketingWorkflowError extends Error {}
const DAY = 86_400_000;

export function validateMarketingBody(body: string) {
  if (/prescription|condition|allerg|medicine|diagnos|patient|drug|\brx\b/i.test(body))
    throw new MarketingWorkflowError(
      'Use generic retail copy without clinical or medicine content.'
    );
  if (!body.toUpperCase().includes('STOP'))
    throw new MarketingWorkflowError('Include STOP opt-out instructions in the template.');
}
const whereScope = (scope: MarketingScope) => ({
  organizationId: scope.organizationId,
  branchId: scope.branchId,
});

/** Human-reviewed templates are immutable; AI assistance never calls this writer. */
export async function approveMarketingTemplate(
  db: ScopedDb,
  scope: MarketingScope,
  input: z.infer<typeof marketingTemplateInput>,
  now = new Date()
) {
  marketingTemplateInput.parse(input);
  validateMarketingBody(input.body);
  return db.pharmacyMarketingTemplate.create({
    data: {
      ...whereScope(scope),
      name: input.name,
      body: input.body,
      channel: 'WHATSAPP',
      approvedByUserId: scope.actorId,
      approvedAt: now,
    },
  });
}

async function templateFor(db: ScopedDb, scope: MarketingScope, templateId: string) {
  const template = await db.pharmacyMarketingTemplate.findFirst({
    where: { ...whereScope(scope), id: templateId, channel: 'WHATSAPP' },
  });
  if (!template || !template.approvedByUserId || !template.approvedAt)
    throw new MarketingWorkflowError('Select a reviewed template in this branch.');
  validateMarketingBody(template.body);
  return template;
}

/** Caller must supply one tenant transaction for every workflow mutation. */
export async function createMarketingDraft(
  db: ScopedDb,
  scope: MarketingScope,
  input: z.infer<typeof marketingDraftInput>
) {
  marketingDraftInput.parse(input);
  await templateFor(db, scope, input.templateId);
  const segment = await db.pharmacyMarketingSegment.create({
    data: {
      ...whereScope(scope),
      name: `${input.name}-${crypto.randomUUID()}`,
      definition: input.definition,
      createdByUserId: scope.actorId,
    },
  });
  return db.pharmacyCampaign.create({
    data: {
      ...whereScope(scope),
      name: input.name,
      segmentId: segment.id,
      templateId: input.templateId,
      scheduledAt: input.scheduledAt,
      quietHours: input.quietHours,
      frequencyCap: input.frequencyCap,
      promotesRegulatedItem: false,
      voucherEnabled: input.voucherEnabled,
      eligibleCategoryAllowlist: input.eligibleCategoryAllowlist,
      status: 'DRAFT',
    },
  });
}

export async function reviewMarketingCampaign(
  db: ScopedDb,
  scope: MarketingScope,
  campaignId: string
) {
  const campaign = await db.pharmacyCampaign.findFirst({
    where: { ...whereScope(scope), id: campaignId },
  });
  if (!campaign) throw new MarketingWorkflowError('Campaign not found in this branch.');
  const template = await templateFor(db, scope, campaign.templateId);
  const segment = await db.pharmacyMarketingSegment.findFirst({
    where: { ...whereScope(scope), id: campaign.segmentId },
  });
  if (!segment) throw new MarketingWorkflowError('Campaign segment is unavailable.');
  const rules = definition.parse(segment.definition);
  return {
    campaign,
    template,
    rules,
    quietHours: quietHours.parse(campaign.quietHours),
    frequencyCap: frequencyCap.parse(campaign.frequencyCap),
  };
}

export async function approveMarketingCampaign(
  db: ScopedDb,
  scope: MarketingScope,
  campaignId: string,
  now = new Date()
) {
  const { campaign } = await reviewMarketingCampaign(db, scope, campaignId);
  if (campaign.promotesRegulatedItem)
    throw new MarketingWorkflowError('Regulated outreach is unavailable.');
  quietHours.parse(campaign.quietHours);
  frequencyCap.parse(campaign.frequencyCap);
  const result = await db.pharmacyCampaign.updateMany({
    where: { ...whereScope(scope), id: campaignId, status: 'DRAFT' },
    data: { status: 'APPROVED', ownerApprovedByUserId: scope.actorId, ownerApprovedAt: now },
  });
  if (result.count !== 1) throw new MarketingWorkflowError('Only a draft can be approved.');
  return { status: 'APPROVED' as const };
}

export function requireCaptureWindow(
  campaign: Awaited<ReturnType<typeof reviewMarketingCampaign>>['campaign'],
  scope: MarketingScope,
  now: Date
) {
  if (
    !['APPROVED', 'CAPTURED'].includes(campaign.status) ||
    !campaign.ownerApprovedByUserId ||
    !campaign.ownerApprovedAt
  )
    throw new MarketingWorkflowError('Owner approval is required before capture.');
  if (campaign.promotesRegulatedItem)
    throw new MarketingWorkflowError('Regulated outreach is unavailable.');
  if (campaign.scheduledAt > now) throw new MarketingWorkflowError('The campaign is not due yet.');
  const hours = quietHours.parse(campaign.quietHours);
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: workspaceTimezone(scope.timezone),
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now)
  );
  if (
    hours.startHour === hours.endHour ||
    (hours.startHour > hours.endHour
      ? hour >= hours.startHour || hour < hours.endHour
      : hour >= hours.startHour && hour < hours.endHour)
  )
    throw new MarketingWorkflowError('The campaign is inside workspace quiet hours.');
}

export async function marketingConsent(
  db: ScopedDb,
  scope: MarketingScope,
  customerId: string,
  now: Date
) {
  const customer = await db.pharmacyCustomer.findFirst({
    where: { organizationId: scope.organizationId, id: customerId },
    select: { id: true, active: true, patientId: true, whatsappOptIn: true },
  });
  if (!customer?.active) return 'INACTIVE';
  if (customer.whatsappOptIn === false) return 'OPTED_OUT';
  if (customer.whatsappOptIn !== true) return 'NO_CONSENT';
  const consent = await db.patientConsent.findFirst({
    where: {
      organizationId: scope.organizationId,
      patientId: customer.patientId,
      purpose: 'MARKETING',
      channel: 'WHATSAPP',
    },
    orderBy: [{ version: 'desc' }, { id: 'asc' }],
    select: { granted: true, revokedAt: true, recordedAt: true },
  });
  if (!consent || consent.recordedAt > now) return 'NO_CONSENT';
  return consent.granted && !consent.revokedAt ? null : 'OPTED_OUT';
}

async function evaluateCampaign(
  db: ScopedDb,
  scope: MarketingScope,
  campaignId: string,
  now: Date,
  persist: boolean
) {
  if (persist)
    await db.$queryRaw(
      Prisma.sql`SELECT id FROM pharmacy_campaigns WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId} AND id = ${campaignId} FOR UPDATE`
    );
  const { campaign, template, rules } = await reviewMarketingCampaign(db, scope, campaignId);
  if (persist && campaign.status === 'CAPTURED')
    return {
      prepared: await db.pharmacyCampaignCapture.count({
        where: { ...whereScope(scope), campaignId },
      }),
      exclusions: {} as Record<string, number>,
      replay: true,
      body: renderMarketingBody(template.body, campaign.voucherEnabled),
    };
  requireCaptureWindow(campaign, scope, now);
  const cap = frequencyCap.parse(campaign.frequencyCap);
  // Only commercial receipt counts and recency. Never select names, phone,
  // medicine, line details, prescriptions, or clinical segmentation fields.
  const sales = await db.pharmacySale.groupBy({
    by: ['customerId'],
    where: {
      ...whereScope(scope),
      customerId: { not: null },
      status: 'COMPLETED',
      completedAt: { lte: now },
      returns: { none: {} },
    },
    _count: { _all: true },
    _max: { completedAt: true },
    orderBy: { customerId: 'asc' },
    take: 501,
  });
  if (sales.length > 500)
    throw new MarketingWorkflowError(
      'Audience exceeds the 500-customer sandbox limit. Narrow the branch audience before capture.'
    );
  let prepared = 0;
  const exclusions: Record<string, number> = {};
  for (const sale of sales) {
    if (!sale.customerId || !sale._max.completedAt) continue;
    const values = {
      receiptCount: sale._count._all,
      daysSinceLastReceipt: Math.floor((now.getTime() - sale._max.completedAt.getTime()) / DAY),
    };
    if (
      !rules.all.every((r) =>
        r.operator === 'eq'
          ? values[r.field] === r.value
          : r.operator === 'gte'
            ? values[r.field] >= r.value
            : values[r.field] <= r.value
      )
    )
      continue;
    // A shared row lock serializes captures across campaigns AND branches.
    // STOP updates this same row. Stable customer order avoids cap deadlocks.
    if (persist) await lockCustomerConsent(db, scope.organizationId, sale.customerId);
    let reason = await marketingConsent(db, scope, sale.customerId, now);
    if (!reason) {
      const prior = await db.pharmacyCampaignCapture.count({
        where: {
          organizationId: scope.organizationId,
          customerId: sale.customerId,
          channel: 'WHATSAPP',
          capturedAt: { gte: new Date(now.getTime() - cap.windowDays * DAY) },
        },
      });
      if (prior >= cap.max) reason = 'FREQUENCY_CAP';
    }
    if (reason) {
      exclusions[reason] = (exclusions[reason] ?? 0) + 1;
      if (persist)
        await db.pharmacyCampaignExclusion.create({
          data: {
            ...whereScope(scope),
            campaignId,
            customerId: sale.customerId,
            reason,
            evidence: { version: 1, evaluatedAt: now.toISOString() },
            evaluatedAt: now,
          },
        });
    } else {
      if (persist)
        await db.pharmacyCampaignCapture.create({
          data: {
            ...whereScope(scope),
            campaignId,
            customerId: sale.customerId,
            channel: 'WHATSAPP',
            idempotencyKey: `marketing:${campaignId}:${sale.customerId}:v1`,
            capturedAt: now,
          },
        });
      prepared++;
    }
  }
  if (persist)
    await db.pharmacyCampaign.update({ where: { id: campaignId }, data: { status: 'CAPTURED' } });
  return {
    prepared,
    exclusions,
    replay: false,
    body: renderMarketingBody(template.body, campaign.voucherEnabled),
  };
}

export const previewMarketingCampaign = (
  db: ScopedDb,
  scope: MarketingScope,
  campaignId: string,
  now = new Date()
) => evaluateCampaign(db, scope, campaignId, now, false);
export const captureMarketingCampaign = (
  db: ScopedDb,
  scope: MarketingScope,
  campaignId: string,
  now = new Date()
) => evaluateCampaign(db, scope, campaignId, now, true);

export async function marketingHistory(db: ScopedDb, scope: MarketingScope) {
  const [campaigns, templates] = await Promise.all([
    db.pharmacyCampaign.findMany({
      where: whereScope(scope),
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 50,
    }),
    db.pharmacyMarketingTemplate.findMany({
      where: { ...whereScope(scope), channel: 'WHATSAPP' },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 50,
    }),
  ]);
  return { campaigns, templates, timezone: scope.timezone, mode: 'SANDBOX' as const };
}
