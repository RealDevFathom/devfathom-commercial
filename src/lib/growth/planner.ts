import 'server-only';
import { z } from 'zod';
import type { GrowthSettings, Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { generateCampaignPlan, plannerOutput } from '@/lib/ai/campaign-planner';
import { readAIAvailability } from '@/lib/ai/provider';
import { assertCampaignPolicy, campaignInput } from './campaigns';
import { segmentInput } from './segments';
import { lockGrowth } from './codes';
import { DAY, localDate, outsideQuietHours, weekStart } from './calendar';
import { plannerSignals } from './signals';
const templateKeys = new Set([
  'birthday_offer',
  'refill_reminder',
  'winback',
  'slow_day',
  'holiday',
  'review_request',
  'referral',
  'generic',
]);
function canonical(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return JSON.stringify(
      Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    );
  return JSON.stringify(value);
}
export function guardProposals(
  raw: unknown,
  settings: Pick<
    GrowthSettings,
    'quietHoursStart' | 'quietHoursEnd' | 'maxDiscountPct' | 'autoApproveUnderMinor'
  >,
  remaining: number,
  averageBasket: number,
  templates: Array<{ id: string; key: string; body: string }>,
  recent: Array<{ kind: string; segment: unknown; sendAt: Date }>,
  now: Date
) {
  const output = plannerOutput.parse(raw);
  const accepted: Array<z.infer<typeof campaignInput> & { status: string }> = [];
  for (const p of output.proposals) {
    const segment = segmentInput.safeParse(p.segment);
    const template = templates.find((t) => t.key === p.templateKey);
    const date = z.iso.datetime({ offset: true }).safeParse(p.sendAt);
    if (!segment.success || !templateKeys.has(p.templateKey) || !template || !date.success)
      continue;
    const sendAt = outsideQuietHours(
      new Date(date.data),
      settings.quietHoursStart,
      settings.quietHoursEnd
    );
    if (sendAt < now || sendAt.getTime() >= now.getTime() + 14 * DAY) continue;
    const cap = Math.min(25, settings.maxDiscountPct ?? 25);
    const discountValue =
      p.discountType === 'none'
        ? 0
        : Math.min(
            p.discountValue,
            p.discountType === 'percent' ? cap : Math.floor((averageBasket * cap) / 100)
          );
    const parsed = campaignInput.safeParse({
      kind: p.kind,
      name: p.name,
      rationale: p.rationale,
      segment: segment.data,
      sendAt,
      discountType: p.discountType,
      discountValue,
      budgetCapMinor: Math.min(p.budgetCapMinor, remaining),
      templateId: template.id,
      ...(p.discountType !== 'none' ? { codeExpiresAt: new Date(sendAt.getTime() + 7 * DAY) } : {}),
    });
    if (!parsed.success) continue;
    if (
      [...recent, ...accepted].some(
        (c) =>
          c.kind === p.kind &&
          canonical(c.segment) === canonical(segment.data) &&
          Math.abs(c.sendAt.getTime() - sendAt.getTime()) < 7 * DAY
      )
    )
      continue;
    try {
      assertCampaignPolicy(parsed.data, template.body, template.key);
    } catch {
      continue;
    }
    accepted.push({
      ...parsed.data,
      status:
        settings.autoApproveUnderMinor > 0 &&
        parsed.data.budgetCapMinor < settings.autoApproveUnderMinor
          ? 'approved'
          : 'proposed',
    });
    remaining -= parsed.data.budgetCapMinor;
  }
  return accepted;
}
/** Caller owns a tenant transaction; lock and marker make concurrent ticks idempotent. */
export async function runWeeklyPlanner(
  db: ScopedDb,
  organizationId: string,
  now = new Date(),
  generate: (signals: unknown) => Promise<unknown> = generateCampaignPlan
) {
  if (localDate(now).getUTCDay() !== 1) return 0;
  await lockGrowth(db, organizationId);
  const settings = await db.growthSettings.findUnique({ where: { organizationId } });
  if (!settings || (settings.lastPlanRunAt && settings.lastPlanRunAt >= weekStart(now))) return 0;
  const signals = await plannerSignals(db, organizationId, now, settings);
  const raw = await generate(signals);
  await db.auditLog.create({
    data: {
      organizationId,
      actorType: 'SYSTEM',
      source: 'SYSTEM',
      category: 'SYSTEM',
      action: 'growth.planner.output',
      result: JSON.parse(JSON.stringify(raw)) as Prisma.InputJsonValue,
    },
  });
  const templates = await db.messageTemplate.findMany({
    where: { organizationId },
    orderBy: { id: 'asc' },
  });
  const recent = await db.campaign.findMany({
    where: {
      organizationId,
      status: { not: 'cancelled' },
      sendAt: { gte: new Date(now.getTime() - 7 * DAY), lt: new Date(now.getTime() + 21 * DAY) },
    },
  });
  const proposals = guardProposals(
    raw,
    settings,
    signals.remainingBudgetMinor,
    signals.averageBasketMinor,
    templates,
    recent,
    now
  );
  for (const proposal of proposals)
    await db.campaign.create({
      data: {
        ...proposal,
        organizationId,
        createdBy: 'ai',
        ...(proposal.status === 'approved' ? { approvedBy: 'ai', approvedAt: now } : {}),
      },
    });
  await db.growthSettings.update({ where: { organizationId }, data: { lastPlanRunAt: now } });
  return proposals.length;
}
export function plannerAvailable() {
  return readAIAvailability().available;
}
