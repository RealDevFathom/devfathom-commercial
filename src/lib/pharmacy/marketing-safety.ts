import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { MarketingWorkflowError } from './marketing-errors';

const accountUpdate = z.object({
  field: z.literal('account_update'),
  value: z.object({
    event: z.string().optional(),
    phone_number: z.string().optional(),
    phone_number_id: z.string().optional(),
    quality_score: z.string().optional(),
    new_quality_score: z.string().optional(),
    waba_info: z.object({ waba_id: z.string() }).optional(),
  }),
});

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
};

/** The app signature alone does not prove ownership of an account-level event. */
export function parseMarketingQualityUpdates(
  payload: unknown,
  senderId: string,
  businessAccountId?: string | null
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
        (value.phone_number !== undefined && value.phone_number !== senderId)
      )
        return [];
      const event = value.event?.toUpperCase() ?? '';
      const reportedQuality = value.new_quality_score ?? value.quality_score;
      const quality = reportedQuality?.toUpperCase();
      const state = /(BLOCK|VIOLATION|RESTRICT)/.test(event)
        ? { quality: 'EVENT_DEGRADED', paused: true, reason: `ACCOUNT_${event}` }
        : quality && ['GREEN', 'YELLOW', 'RED'].includes(quality)
          ? {
              quality,
              paused: quality !== 'GREEN',
              reason: quality === 'GREEN' ? null : `ACCOUNT_QUALITY_${quality}`,
            }
          : null;
      if (!state) return [];
      // A content-derived identity stays stable across provider retries and receipt times.
      const eventKey = createHash('sha256')
        .update(JSON.stringify([businessAccountId, senderId, entry.time, event, state]))
        .digest('hex');
      return [{ ...state, eventKey, occurredAt: new Date(entry.time * 1000) }];
    });
  });
}

export async function recordMarketingQualityUpdate(
  db: ScopedDb,
  organizationId: string,
  senderId: string,
  update: MarketingQualityUpdate
) {
  // ON CONFLICT serializes competing first inserts and updates. Never decide freshness
  // with a separate read; equal-time evidence may pause, but cannot clear a pause.
  return db.$executeRaw(Prisma.sql`
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
