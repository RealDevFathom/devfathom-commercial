import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { MarketingWorkflowError } from './marketing-errors';

const accountUpdate = z.object({
  field: z.enum(['account_update', 'phone_number_quality_update']),
  value: z.object({
    event: z.string().optional(),
    phone_number: z.string().optional(),
    phone_number_id: z.string().optional(),
    display_phone_number: z.string().optional(),
    quality_score: z.string().optional(),
    new_quality_score: z.string().optional(),
    // Optional normalized provider telemetry: fractions, never percentages.
    block_rate: z.number().finite().min(0).max(1).optional(),
    previous_block_rate: z.number().finite().min(0).max(1).optional(),
    waba_info: z.object({ waba_id: z.string() }).optional(),
  }),
});

const degradingEvents = new Set([
  'BLOCKED',
  'ACCOUNT_BLOCKED',
  'ACCOUNT_VIOLATION',
  'VIOLATION',
  'RESTRICTED',
  'ACCOUNT_RESTRICTED',
  'RESTRICTION',
  'ACCOUNT_RESTRICTION',
  'DISABLED_UPDATE',
  'ACCOUNT_DISABLED',
  'ACCOUNT_BANNED',
  'BANNED',
  'FLAGGED',
  'DOWNGRADE',
]);

const accountEntry = z.object({
  id: z.string().min(1),
  time: z
    .union([z.number(), z.string().regex(/^\d+$/)])
    .transform(Number)
    .pipe(z.number().int().positive().max(8_640_000_000_000)),
  changes: z.array(z.unknown()).max(500),
});

export type MarketingQualityUpdate = {
  quality: string;
  paused: boolean;
  reason: string | null;
  eventKey: string;
  occurredAt: Date;
  blockRate?: { previous: number; current: number };
};

/** The app signature alone does not prove ownership of an account-level event. */
export function parseMarketingQualityUpdates(
  payload: unknown,
  senderId: string,
  businessAccountId?: string | null,
  displayPhoneNumber?: string | null
): MarketingQualityUpdate[] {
  if (!senderId || !businessAccountId) return [];
  const root = z
    .object({
      object: z.literal('whatsapp_business_account'),
      entry: z.array(z.unknown()).max(500),
    })
    .safeParse(payload);
  if (!root.success) return [];
  return root.data.entry.flatMap((rawEntry) => {
    const parsedEntry = accountEntry.safeParse(rawEntry);
    if (!parsedEntry.success || parsedEntry.data.id !== businessAccountId) return [];
    const entry = parsedEntry.data;
    return entry.changes.flatMap((raw): MarketingQualityUpdate[] => {
      const parsed = accountUpdate.safeParse(raw);
      if (!parsed.success) return [];
      const value = parsed.data.value;
      if (value.waba_info && value.waba_info.waba_id !== businessAccountId) return [];
      // Reject contradictory sender evidence, including an explicitly empty identifier.
      if (
        (value.phone_number_id !== undefined && value.phone_number_id !== senderId) ||
        (value.phone_number !== undefined && value.phone_number !== senderId) ||
        (value.display_phone_number !== undefined &&
          value.display_phone_number !== displayPhoneNumber)
      )
        return [];
      // Phone-scoped events need positive sender evidence; an account can own
      // several numbers. Meta may supply only the display number here.
      if (
        parsed.data.field === 'phone_number_quality_update' &&
        value.phone_number_id !== senderId &&
        value.phone_number !== senderId &&
        !(displayPhoneNumber && value.display_phone_number === displayPhoneNumber)
      )
        return [];
      const event = value.event?.toUpperCase() ?? '';
      const reportedQuality = value.new_quality_score ?? value.quality_score;
      const quality = reportedQuality?.toUpperCase();
      const blockRate =
        value.block_rate !== undefined && value.previous_block_rate !== undefined
          ? { previous: value.previous_block_rate, current: value.block_rate }
          : undefined;
      const state = degradingEvents.has(event)
        ? { quality: 'EVENT_DEGRADED', paused: true, reason: `ACCOUNT_${event}` }
        : blockRate && blockRate.current > blockRate.previous
          ? { quality: 'BLOCK_RATE_RISE', paused: true, reason: 'ACCOUNT_BLOCK_RATE_RISE' }
          : quality && ['GREEN', 'YELLOW', 'RED'].includes(quality)
            ? {
                quality,
                paused: quality !== 'GREEN',
                reason: quality === 'GREEN' ? null : `ACCOUNT_QUALITY_${quality}`,
              }
            : null;
      if (!state) return [];
      // A content-derived identity stays stable across provider retries and receipt times.
      const identity: unknown[] = [businessAccountId, senderId, entry.time, event, state];
      if (blockRate) identity.push(blockRate);
      const eventKey = createHash('sha256')
        .update(JSON.stringify(identity))
        .digest('hex');
      return [
        {
          ...state,
          eventKey,
          occurredAt: new Date(entry.time * 1000),
          ...(blockRate ? { blockRate } : {}),
        },
      ];
    });
  });
}

export async function recordMarketingQualityUpdate(
  db: ScopedDb,
  organizationId: string,
  senderId: string,
  update: MarketingQualityUpdate
) {
  // Caller supplies one tenant transaction, including the audit write.
  // ON CONFLICT serializes competing first inserts and updates. Never decide freshness
  // with a separate read; equal-time evidence may pause, but cannot clear a pause.
  const changed = await db.$executeRaw(Prisma.sql`
    INSERT INTO pharmacy_marketing_safety_states
      ("organizationId", "senderId", quality, paused, reason, "eventKey", "occurredAt", "updatedAt")
    VALUES (${organizationId}, ${senderId}, ${update.quality}, ${update.paused},
      ${update.reason}, ${update.eventKey}, ${update.occurredAt}, CURRENT_TIMESTAMP)
    ON CONFLICT ("organizationId", "senderId") DO UPDATE SET
      quality = EXCLUDED.quality, paused = EXCLUDED.paused, reason = EXCLUDED.reason,
      "eventKey" = EXCLUDED."eventKey", "occurredAt" = EXCLUDED."occurredAt",
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE pharmacy_marketing_safety_states."eventKey" <> EXCLUDED."eventKey"
      AND (pharmacy_marketing_safety_states."occurredAt" < EXCLUDED."occurredAt"
        OR (pharmacy_marketing_safety_states."occurredAt" = EXCLUDED."occurredAt"
          AND EXCLUDED.paused AND NOT pharmacy_marketing_safety_states.paused))
  `);
  if (changed)
    await db.auditLog.create({
      data: {
        organizationId,
        actorType: 'SYSTEM',
        source: 'SYSTEM',
        category: 'PHARMACY_MARKETING',
        operation: 'UPDATE',
        action: update.paused
          ? 'pharmacyMarketing.qualityPaused'
          : 'pharmacyMarketing.qualityResumed',
        targetType: 'PharmacyMarketingSafetyState',
        targetId: senderId,
        metadata: {
          quality: update.quality,
          paused: update.paused,
          reason: update.reason,
          eventKey: update.eventKey,
          occurredAt: update.occurredAt.toISOString(),
          ...(update.blockRate ? { blockRate: update.blockRate } : {}),
        },
      },
    });
  return changed;
}

export const resumeMarketingQualityInput = z
  .object({
    senderId: z.string().trim().min(1).max(128),
    expectedEventKey: z.string().min(1).max(128),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

/** Owner-authorized recovery, in one tenant transaction. A newer event wins. */
export async function resumeMarketingQuality(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  input: z.infer<typeof resumeMarketingQualityInput>
) {
  const validated = resumeMarketingQualityInput.parse(input);
  const changed = await db.pharmacyMarketingSafetyState.updateMany({
    where: {
      organizationId,
      senderId: validated.senderId,
      eventKey: validated.expectedEventKey,
      paused: true,
    },
    // Preserve provider time and identity so a retry cannot undo the override,
    // and any newer provider evidence can pause marketing again.
    data: { paused: false, reason: 'OWNER_OVERRIDE' },
  });
  if (changed.count !== 1)
    throw new MarketingWorkflowError(
      'Quality state changed or is not paused. Reload before resuming.'
    );
  await db.auditLog.create({
    data: {
      organizationId,
      actorType: 'USER',
      actorId,
      source: 'TRPC',
      category: 'PHARMACY_MARKETING',
      operation: 'UPDATE',
      action: 'pharmacyMarketing.qualityOverride',
      targetType: 'PharmacyMarketingSafetyState',
      targetId: validated.senderId,
      metadata: { reason: validated.reason, eventKey: validated.expectedEventKey, paused: false },
    },
  });
  return { paused: false as const };
}

export async function requireMarketingQuality(db: ScopedDb, organizationId: string) {
  const paused = await db.pharmacyMarketingSafetyState.findFirst({
    where: { organizationId, paused: true },
    select: { reason: true },
  });
  if (paused)
    throw new MarketingWorkflowError(
      `Marketing is auto-paused by provider quality (${paused.reason ?? 'QUALITY_DROP'}).`
    );
}
