import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { z } from 'zod';

/**
 * DEV-24 — organization-wide marketing send policy.
 *
 * Defaults follow the growth research (max 2 marketing messages per customer per
 * month and 1 per week; no messages 22:00-09:00 workspace time). They are
 * configurable values stored per organization, never facts baked into the
 * workflow. The block-rate threshold is an estimate and equally configurable.
 */
export const MARKETING_SEND_POLICY_DEFAULTS = {
  weeklyMax: 1,
  monthlyMax: 2,
  quietStartHour: 22,
  quietEndHour: 9,
  blockRatePauseBps: 200,
  blockRateMinSample: 50,
} as const;

export const MARKETING_WEEK_DAYS = 7;
export const MARKETING_MONTH_DAYS = 30;
const DAY = 86_400_000;

export type MarketingSendPolicy = {
  weeklyMax: number;
  monthlyMax: number;
  quietStartHour: number;
  quietEndHour: number;
  blockRatePauseBps: number;
  blockRateMinSample: number;
  pausedAt: Date | null;
  pauseReason: string | null;
};

export const marketingSendPolicyShape = {
  weeklyMax: z.number().int().min(1).max(7),
  monthlyMax: z.number().int().min(1).max(31),
  quietStartHour: z.number().int().min(0).max(23),
  quietEndHour: z.number().int().min(0).max(23),
  blockRatePauseBps: z.number().int().min(1).max(10_000),
  blockRateMinSample: z.number().int().min(1).max(100_000),
};
const capsOrdered = (value: { weeklyMax: number; monthlyMax: number }) =>
  value.weeklyMax <= value.monthlyMax;
const capsMessage = {
  message: 'The weekly cap cannot exceed the monthly cap.',
  path: ['weeklyMax'],
};
export const marketingSendPolicySettings = z
  .object(marketingSendPolicyShape)
  .strict()
  .refine(capsOrdered, capsMessage);
export const marketingSendPolicyInput = z
  .object({ branchId: z.string().trim().min(1).max(128), ...marketingSendPolicyShape })
  .strict()
  .refine(capsOrdered, capsMessage);

export async function readMarketingSendPolicy(
  db: ScopedDb,
  organizationId: string
): Promise<MarketingSendPolicy> {
  const row = await db.pharmacyMarketingSendPolicy.findUnique({ where: { organizationId } });
  return {
    weeklyMax: row?.weeklyMax ?? MARKETING_SEND_POLICY_DEFAULTS.weeklyMax,
    monthlyMax: row?.monthlyMax ?? MARKETING_SEND_POLICY_DEFAULTS.monthlyMax,
    quietStartHour: row?.quietStartHour ?? MARKETING_SEND_POLICY_DEFAULTS.quietStartHour,
    quietEndHour: row?.quietEndHour ?? MARKETING_SEND_POLICY_DEFAULTS.quietEndHour,
    blockRatePauseBps: row?.blockRatePauseBps ?? MARKETING_SEND_POLICY_DEFAULTS.blockRatePauseBps,
    blockRateMinSample:
      row?.blockRateMinSample ?? MARKETING_SEND_POLICY_DEFAULTS.blockRateMinSample,
    pausedAt: row?.pausedAt ?? null,
    pauseReason: row?.pauseReason ?? null,
  };
}

/** Wraps midnight when start > end; equal hours mean the whole day is quiet. */
export function isQuietHour(hour: number, startHour: number, endHour: number) {
  if (startHour === endHour) return true;
  return startHour > endHour
    ? hour >= startHour || hour < endHour
    : hour >= startHour && hour < endHour;
}

/**
 * Counts other WhatsApp marketing captures for the customer across every
 * campaign and branch in the organization and applies the weekly and monthly caps.
 */
export async function marketingPolicyCapReason(
  db: ScopedDb,
  organizationId: string,
  customerId: string,
  policy: Pick<MarketingSendPolicy, 'weeklyMax' | 'monthlyMax'>,
  now: Date,
  excludeCaptureId?: string
): Promise<'FREQUENCY_CAP' | null> {
  const count = (days: number) =>
    db.pharmacyCampaignCapture.count({
      where: {
        organizationId,
        customerId,
        channel: 'WHATSAPP',
        ...(excludeCaptureId ? { id: { not: excludeCaptureId } } : {}),
        capturedAt: { gte: new Date(now.getTime() - days * DAY), lte: now },
      },
    });
  if ((await count(MARKETING_WEEK_DAYS)) >= policy.weeklyMax) return 'FREQUENCY_CAP';
  if ((await count(MARKETING_MONTH_DAYS)) >= policy.monthlyMax) return 'FREQUENCY_CAP';
  return null;
}

const PAUSING_EVENTS = new Set([
  'FLAGGED',
  'DOWNGRADE',
  'ACCOUNT_RESTRICTION',
  'ACCOUNT_VIOLATION',
  'DISABLED_UPDATE',
]);
const DROPPED_QUALITY = new Set(['YELLOW', 'RED', 'MEDIUM', 'LOW', 'FLAGGED']);

export type MarketingPauseSignal = {
  reason: 'QUALITY_DROP' | 'ACCOUNT_RESTRICTION';
  evidence: { version: 1; field: string; event: string | null; quality: string | null };
};

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim().toUpperCase().slice(0, 64) : null;

/** Reads a Meta `account_update` / `phone_number_quality_update` change; never stores phone data. */
export function marketingPauseSignal(field: string, value: unknown): MarketingPauseSignal | null {
  if (field !== 'account_update' && field !== 'phone_number_quality_update') return null;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const event = text(record.event);
  const quality = text(record.quality_rating) ?? text(record.new_quality_score);
  const qualityDropped = quality !== null && DROPPED_QUALITY.has(quality);
  if (!qualityDropped && !(event && PAUSING_EVENTS.has(event))) return null;
  const restriction =
    event === 'ACCOUNT_RESTRICTION' || event === 'ACCOUNT_VIOLATION' || event === 'DISABLED_UPDATE';
  return {
    reason: restriction ? 'ACCOUNT_RESTRICTION' : 'QUALITY_DROP',
    evidence: { version: 1, field: field.slice(0, 64), event, quality },
  };
}

/** Idempotent: an already-paused organization keeps its original pause evidence. */
export async function pauseMarketingSending(
  db: ScopedDb,
  organizationId: string,
  signal: { reason: string; evidence: Record<string, unknown> },
  now = new Date()
) {
  const existing = await db.pharmacyMarketingSendPolicy.findUnique({
    where: { organizationId },
    select: { pausedAt: true },
  });
  if (existing?.pausedAt) return 'ALREADY_PAUSED' as const;
  const data = {
    pausedAt: now,
    pauseReason: signal.reason,
    pauseEvidence: signal.evidence as never,
  };
  await db.pharmacyMarketingSendPolicy.upsert({
    where: { organizationId },
    create: { organizationId, ...data },
    update: data,
  });
  return 'PAUSED' as const;
}

/**
 * Block rate = WhatsApp marketing STOP revocations / delivered marketing messages
 * over the last week. Pauses once the sample is large enough and the rate reaches
 * the configured threshold.
 */
export async function evaluateMarketingBlockRate(
  db: ScopedDb,
  organizationId: string,
  now = new Date()
) {
  const policy = await readMarketingSendPolicy(db, organizationId);
  if (policy.pausedAt) return 'ALREADY_PAUSED' as const;
  const since = new Date(now.getTime() - MARKETING_WEEK_DAYS * DAY);
  const [blocks, delivered] = await Promise.all([
    db.patientConsent.count({
      where: {
        organizationId,
        purpose: 'MARKETING',
        channel: 'WHATSAPP',
        granted: false,
        // Only WhatsApp STOP replies; counter and QR refusals are not blocks.
        source: 'REPLY',
        recordedAt: { gte: since, lte: now },
      },
    }),
    // One real provider delivery per accepted message: sandbox rows and repeat
    // delivered/read callbacks for the same message must not dilute the rate.
    db.pharmacyCampaignDeliveryEvent
      .groupBy({
        by: ['acceptanceId'],
        where: {
          organizationId,
          provider: 'meta',
          state: 'DELIVERED',
          acceptanceId: { not: null },
          occurredAt: { gte: since, lte: now },
        },
      })
      .then((rows) => rows.length),
  ]);
  if (delivered < policy.blockRateMinSample) return 'INSUFFICIENT_SAMPLE' as const;
  const rateBps = Math.floor((blocks * 10_000) / delivered);
  if (rateBps < policy.blockRatePauseBps) return 'WITHIN_THRESHOLD' as const;
  return pauseMarketingSending(
    db,
    organizationId,
    {
      reason: 'BLOCK_RATE',
      evidence: {
        version: 1,
        blocks,
        delivered,
        rateBps,
        thresholdBps: policy.blockRatePauseBps,
      },
    },
    now
  );
}

export async function updateMarketingSendPolicy(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  raw: z.input<typeof marketingSendPolicySettings>
) {
  const settings = marketingSendPolicySettings.parse(raw);
  await db.pharmacyMarketingSendPolicy.upsert({
    where: { organizationId },
    create: { organizationId, ...settings, updatedByUserId: actorId },
    update: { ...settings, updatedByUserId: actorId },
  });
  return readMarketingSendPolicy(db, organizationId);
}

/** Owner-only; the caller authorizes the actor and records the audit entry. */
export async function resumeMarketingSending(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  now = new Date()
) {
  const result = await db.pharmacyMarketingSendPolicy.updateMany({
    where: { organizationId, pausedAt: { not: null } },
    data: {
      pausedAt: null,
      pauseReason: null,
      resumedAt: now,
      resumedByUserId: actorId,
    },
  });
  return { resumed: result.count === 1 };
}
