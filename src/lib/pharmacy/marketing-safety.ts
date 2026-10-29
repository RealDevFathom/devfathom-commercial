import 'server-only';

import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const accountUpdate = z.object({
  field: z.literal('account_update'),
  value: z.object({
    event: z.string().optional(),
    phone_number: z.string().optional(),
    phone_number_id: z.string().optional(),
    quality_score: z.string().optional(),
    new_quality_score: z.string().optional(),
  }),
});

/** Extract only quality events for the sender authenticated by the webhook host. */
export function parseMarketingQualityUpdates(payload: unknown, senderId: string) {
  const root = z
    .object({ entry: z.array(z.object({ changes: z.array(z.unknown()).max(500) })).max(500) })
    .safeParse(payload);
  if (!root.success) return [];
  return root.data.entry.flatMap((entry) =>
    entry.changes.flatMap((raw) => {
      const parsed = accountUpdate.safeParse(raw);
      if (!parsed.success) return [];
      const value = parsed.data.value;
      const eventSender = value.phone_number_id ?? value.phone_number;
      if (eventSender && eventSender !== senderId) return [];
      const event = value.event?.toUpperCase() ?? '';
      const reportedQuality = value.new_quality_score ?? value.quality_score;
      const quality = reportedQuality?.toUpperCase();
      if (quality && ['GREEN', 'YELLOW', 'RED'].includes(quality))
        return [
          {
            quality,
            paused: quality !== 'GREEN',
            reason: quality === 'GREEN' ? null : `ACCOUNT_QUALITY_${quality}`,
          },
        ];
      if (/(BLOCK|VIOLATION|RESTRICT)/.test(event))
        return [{ quality: 'EVENT_DEGRADED', paused: true, reason: `ACCOUNT_${event}` }];
      return [];
    })
  );
}

export async function recordMarketingQualityUpdate(
  db: ScopedDb,
  organizationId: string,
  senderId: string,
  update: { quality: string; paused: boolean; reason: string | null },
  occurredAt = new Date()
) {
  const eventKey = `account-quality:${senderId}:${occurredAt.toISOString()}:${update.quality}`;
  return db.pharmacyMarketingSafetyState.upsert({
    where: { organizationId_senderId: { organizationId, senderId } },
    create: { organizationId, senderId, ...update, eventKey, occurredAt },
    update: { ...update, eventKey, occurredAt },
  });
}

export async function requireMarketingQuality(db: ScopedDb, organizationId: string) {
  const paused = await db.pharmacyMarketingSafetyState.findFirst({
    where: { organizationId, paused: true },
    select: { reason: true },
  });
  if (paused)
    throw new Error(
      `Marketing is auto-paused by provider quality (${paused.reason ?? 'QUALITY_DROP'}).`
    );
}
