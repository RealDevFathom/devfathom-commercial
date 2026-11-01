import { monthlyCampaignSpend } from './spend';
import 'server-only';
import { z } from 'zod';
import { assertMarketingCopyAllowed } from './drug-guard';
import type { Campaign } from '@/generated/prisma/client';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  claimMessageLogInTransaction,
  sendClaimedMessage,
} from '@/lib/pharmacy/whatsapp/message-log';
import { canMessageCustomer } from '@/lib/pharmacy/whatsapp/messages';
import { lockCustomerConsent } from '@/lib/pharmacy/consent-writer';
import {
  createWhatsAppProvider,
  readWhatsAppConfig,
  type WhatsAppProvider,
} from '@/lib/pharmacy/whatsapp/provider';
import { segmentInput, materializeSegment, sampleKey } from './segments';
import { campaignCode, discountFor, lockGrowth } from './codes';

export const campaignInput = z
  .object({
    kind: z.enum([
      'holiday',
      'slow_day',
      'birthday',
      'refill',
      'winback',
      'random',
      'manual',
      'review',
      'referral',
    ]),
    name: z.string().trim().min(1).max(160),
    rationale: z.string().max(2000).optional(),
    segment: segmentInput,
    sendAt: z.date(),
    templateId: z.string().min(1),
    discountType: z.enum(['none', 'percent', 'fixed']),
    discountValue: z.number().int().nonnegative().max(100000000),
    codeExpiresAt: z.date().optional(),
    budgetCapMinor: z.number().int().nonnegative().max(100000000),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (
      (c.discountType === 'percent' && c.discountValue > 100) ||
      (c.discountType === 'none' && c.discountValue !== 0) ||
      (c.discountType !== 'none' &&
        (!c.discountValue || !c.codeExpiresAt || c.codeExpiresAt <= c.sendAt))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid discount or expiry.' });
  });
/** No clinical content or drug promotion; utility refills contain no offer. */
export function assertCampaignPolicy(
  c: Pick<Campaign, 'kind' | 'segment' | 'discountType' | 'discountValue'>,
  body: string,
  key: string
) {
  const segment = segmentInput.parse(c.segment);
  if (c.kind === 'refill') {
    if (
      segment.type !== 'refill_due' ||
      key !== 'refill_reminder' ||
      c.discountType !== 'none' ||
      c.discountValue ||
      /discount|offer|sale|buy|free|save|\boff\b|%|\{\{(?:discount|code)\}\}/i.test(body)
    )
      throw new Error('Refill reminders must be utility messages without promotions.');
  } else if (
    segment.type === 'refill_due' ||
    /medicine|drug|\brx\b|prescription|clinical|\{\{product\}\}/i.test(body)
  )
    throw new Error('Drug and medicine promotions are prohibited.');
  if (!/\bSTOP\b/i.test(body)) throw new Error('Template requires STOP instructions.');
}
export function renderCampaign(body: string, values: Record<string, string>) {
  const rendered = body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`Missing template variable: ${key}`);
    return values[key];
  });
  if (rendered.includes('{{') || !/\bSTOP\b/i.test(rendered)) throw new Error('Invalid template.');
  return rendered;
}
export function affordableReach(
  reach: number,
  campaign: Pick<Campaign, 'discountType' | 'discountValue' | 'budgetCapMinor' | 'spentMinor'>,
  averageBasket: number,
  monthlyRemaining: number
) {
  const perRecipient =
    0.08 *
    (campaign.discountType === 'fixed'
      ? (campaign.discountValue ?? 0)
      : discountFor(campaign, averageBasket));
  if (!perRecipient) return campaign.discountType === 'none' ? reach : 0;
  return Math.max(
    0,
    Math.min(
      reach,
      Math.floor(
        Math.min(campaign.budgetCapMinor - campaign.spentMinor, monthlyRemaining) / perRecipient
      )
    )
  );
}
export async function createCampaign(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  raw: z.input<typeof campaignInput>
) {
  const input = campaignInput.parse(raw);
  const template = await db.messageTemplate.findFirstOrThrow({
    where: { organizationId, id: input.templateId },
  });
  assertCampaignPolicy(input, template.body, template.key);
  if (input.kind !== 'refill') await assertMarketingCopyAllowed(db, organizationId, template.body);
  return db.campaign.create({
    data: { ...input, organizationId, createdBy: actorId, status: 'proposed' },
  });
}
export async function transitionCampaign(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  id: string,
  action: 'approve' | 'cancel',
  now = new Date()
) {
  await lockGrowth(db, organizationId);
  const changed = await db.campaign.updateMany({
    where: {
      organizationId,
      id,
      ...(action === 'approve' ? { createdBy: { not: actorId } } : {}),
      status: {
        in: action === 'approve' ? ['proposed'] : ['proposed', 'approved', 'scheduled', 'sending'],
      },
    },
    data:
      action === 'approve'
        ? { status: 'approved', approvedBy: actorId, approvedAt: now }
        : { status: 'cancelled' },
  });
  if (changed.count !== 1) throw new Error('Invalid campaign transition.');
  if (action === 'cancel')
    await db.campaignRecipient.updateMany({
      where: { organizationId, campaignId: id, status: 'queued' },
      data: { status: 'skipped' },
    });
  return { ok: true };
}
/** One lifecycle stage per tick. All materialisation and spend changes share a tenant lock. */
export async function advanceCampaigns(db: ScopedDb, organizationId: string, now = new Date()) {
  await lockGrowth(db, organizationId);
  const settings = await db.growthSettings.findUnique({ where: { organizationId } });
  if (!settings) return;
  const organization = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const campaigns = await db.campaign.findMany({
    where: { organizationId, status: { in: ['approved', 'scheduled', 'sending'] } },
    include: { template: true },
    orderBy: { id: 'asc' },
    take: 50,
  });
  for (const campaign of campaigns) {
    await db.$executeRawUnsafe('SAVEPOINT growth_campaign');
    try {
      assertCampaignPolicy(campaign, campaign.template.body, campaign.template.key);
      if (campaign.kind !== 'refill')
        await assertMarketingCopyAllowed(db, organizationId, campaign.template.body);
      if (
        campaign.status === 'approved' &&
        campaign.sendAt.getTime() <= now.getTime() + 15 * 60000
      ) {
        const candidates = await materializeSegment(db, organizationId, campaign.segment, now);
        const metrics = await db.customerMetrics.aggregate({
          where: { organizationId },
          _sum: { spend90dMinor: true, orders90d: true },
        });
        const avg = Math.ceil(
          Number(metrics._sum.spend90dMinor ?? 0) / Math.max(1, metrics._sum.orders90d ?? 0)
        );
        const spent = await monthlyCampaignSpend(db, organizationId, now);
        // Reserve estimates of other active campaigns as well as actual monthly spend.
        const active = await db.campaign.findMany({
          where: {
            organizationId,
            id: { not: campaign.id },
            status: { in: ['scheduled', 'sending'] },
          },
        });
        const reserved = active.reduce(
          (s, c) =>
            s +
            Math.max(0, Math.ceil(c.estimatedReach * 0.08 * discountFor(c, avg)) - c.spentMinor),
          0
        );
        const reach = affordableReach(
          candidates.length,
          campaign,
          avg,
          settings.monthlyBudgetMinor - spent - reserved
        );
        const ids = candidates
          .sort((a, b) => sampleKey(a, campaign.id).localeCompare(sampleKey(b, campaign.id)))
          .slice(0, reach);
        if (ids.length)
          await db.campaignRecipient.createMany({
            data: ids.map((customerId) => ({
              organizationId,
              campaignId: campaign.id,
              customerId,
              code:
                campaign.discountType === 'none' ? null : campaignCode(organization.displayName),
              status: 'queued',
            })),
            skipDuplicates: false,
          });
        await db.campaign.update({
          where: { id: campaign.id },
          data: {
            status: ids.length ? 'scheduled' : 'sent',
            estimatedReach: ids.length,
            rationale: `${campaign.rationale ?? ''}${reach < candidates.length ? `\nBudget trimmed reach from ${candidates.length} to ${reach}.` : ''}`,
          },
        });
      } else if (campaign.status === 'scheduled' && campaign.sendAt <= now) {
        await db.campaign.update({ where: { id: campaign.id }, data: { status: 'sending' } });
      } else if (campaign.status === 'sending') {
        const pending = await db.campaignRecipient.count({
          where: { organizationId, campaignId: campaign.id, status: 'queued' },
        });
        if (!pending)
          await db.campaign.update({ where: { id: campaign.id }, data: { status: 'sent' } });
      }
      await db.$executeRawUnsafe('RELEASE SAVEPOINT growth_campaign');
    } catch (error) {
      await db.$executeRawUnsafe('ROLLBACK TO SAVEPOINT growth_campaign');
      await db.$executeRawUnsafe('RELEASE SAVEPOINT growth_campaign');
      await db.campaign.update({
        where: { organizationId, id: campaign.id },
        data: { status: 'blocked' },
      });
      console.error('Campaign tick failed', { organizationId, campaignId: campaign.id, error });
    }
  }
}
/** Bounded dispatcher uses the existing at-most-once outbox claim + provider seam. */
export async function dispatchCampaignMessage(
  organizationId: string,
  now = new Date(),
  provider: WhatsAppProvider = createWhatsAppProvider()
) {
  const config = readWhatsAppConfig();
  if (provider.name === 'meta' && config.organizationId !== organizationId) return;
  const claim = await withTenantDb(organizationId, async (db) => {
    await lockGrowth(db, organizationId);
    const settings = await db.growthSettings.findUnique({ where: { organizationId } });
    if (!settings) return null;
    const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: org.timezone,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(now)
    );
    const quiet =
      settings.quietHoursStart >= settings.quietHoursEnd
        ? hour >= settings.quietHoursStart || hour < settings.quietHoursEnd
        : hour >= settings.quietHoursStart && hour < settings.quietHoursEnd;
    if (quiet) return null;
    const recent = await db.pharmacyMessageLog.findMany({
      where: {
        organizationId,
        direction: 'OUTBOUND',
        createdAt: { gte: new Date(now.getTime() - 86400000) },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    // Conservative 24-hour cap and minimum 4 second spacing, including pending claims.
    if (
      recent.length >= Math.min(30, settings.maxMsgsPerDay) ||
      (recent[0] &&
        now.getTime() - recent[0].createdAt.getTime() <
          Math.max(4, settings.minSecondsBetweenMsgs) * 1000)
    )
      return null;
    const recipient = await db.campaignRecipient.findFirst({
      where: {
        organizationId,
        status: 'queued',
        campaign: { status: 'sending', sendAt: { lte: now } },
      },
      include: { campaign: { include: { template: true } } },
      orderBy: { id: 'asc' },
    });
    if (!recipient) return null;
    await lockCustomerConsent(db, organizationId, recipient.customerId);
    const customer = await db.pharmacyCustomer.findFirstOrThrow({
      where: { organizationId, id: recipient.customerId },
    });
    const c = recipient.campaign;
    assertCampaignPolicy(c, c.template.body, c.template.key);
    if (
      !canMessageCustomer(customer) ||
      !customer.whatsappE164 ||
      (c.codeExpiresAt && c.codeExpiresAt <= now) ||
      (c.discountType !== 'none' && c.spentMinor >= c.budgetCapMinor)
    ) {
      await db.campaignRecipient.update({
        where: { id: recipient.id },
        data: { status: 'skipped' },
      });
      return null;
    }
    const body = renderCampaign(c.template.body, {
      name: customer.displayName,
      business: org.displayName,
      discount:
        c.discountType === 'percent'
          ? `${c.discountValue}% on front-shop products only`
          : `Rs ${((c.discountValue ?? 0) / 100).toFixed(2)} on front-shop products only`,
      code: recipient.code ?? '',
      product: 'item',
      expires: c.codeExpiresAt?.toISOString().slice(0, 10) ?? '',
    });
    assertCampaignPolicy(c, body, c.template.key);
    if (c.kind !== 'refill') await assertMarketingCopyAllowed(db, organizationId, body);
    const entry = {
      organizationId,
      kind: c.kind === 'refill' ? ('REFILL_REMINDER' as const) : ('GROWTH_CAMPAIGN' as const),
      customerId: customer.id,
      dedupeKey: `growth:${recipient.id}`,
    };
    const logId = await claimMessageLogInTransaction(db, {
      ...entry,
      direction: 'OUTBOUND',
      status: 'PENDING',
    });
    if (!logId) return null;
    await db.pharmacyMessageLog.update({
      where: { id: logId },
      data: { body, campaignId: c.id, recipientId: recipient.id },
    });
    // A claimed recipient is terminal for scheduling; UNKNOWN stays visible in the log.
    await db.campaignRecipient.update({
      where: { id: recipient.id },
      data: { status: 'unknown', error: 'PROVIDER_OUTCOME_PENDING' },
    });
    return { entry, logId, recipientId: recipient.id, to: customer.whatsappE164, body };
  });
  if (!claim) return;
  const outcome = await sendClaimedMessage(claim.entry, claim.logId, () =>
    provider.sendText({ to: claim.to, body: claim.body })
  );
  await withTenantDb(organizationId, (db) =>
    db.campaignRecipient.update({
      where: { id: claim.recipientId },
      data:
        outcome === 'SENT'
          ? { status: 'sent', sentAt: now, error: null }
          : { status: outcome === 'UNKNOWN' ? 'unknown' : 'failed', error: outcome },
    })
  );
  return outcome;
}

/** Drain a small batch within the route time budget; rate gates also cover overlapping ticks. */
export async function dispatchCampaignMessages(organizationId: string) {
  const started = Date.now();
  for (let i = 0; i < 10 && Date.now() - started < 45000; i++) {
    if (!(await dispatchCampaignMessage(organizationId))) break;
    await new Promise((resolve) => setTimeout(resolve, 4000 + Math.floor(Math.random() * 3000)));
  }
}
