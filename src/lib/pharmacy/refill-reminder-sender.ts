import 'server-only';

import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

export const REFILL_REMINDER_TEMPLATE = 'refill_reminder_bilingual_v1';
export const REFILL_OPT_OUT_KEYWORD = 'STOP REFILL';

export type RefillSkipReason =
  | 'CONSENT_MISSING'
  | 'CONSENT_REVOKED'
  | 'PATIENT_OPTED_OUT'
  | 'BRANCH_UNAVAILABLE';

type DueCapture = { id: string; organizationId: string; branchId: string };

/**
 * The queue payload intentionally contains no patient name, medicine, dosage or
 * directions. Those clinical facts remain in the capture; the provider receives
 * only a transactional bilingual template, the reminder date and opt-out route.
 */
export function refillReminderPayload(reminderAt: Date) {
  return {
    locale: 'en_UR',
    template: REFILL_REMINDER_TEMPLATE,
    parameters: {
      reminderDate: reminderAt.toISOString().slice(0, 10),
      optOutKeyword: REFILL_OPT_OUT_KEYWORD,
      optOutPath: '/pharmacy/refill-reminders/opt-out',
    },
  } as const;
}

/** Persist the preference independently from general WhatsApp/loyalty flags. */
export async function setRefillReminderPreference(
  db: ScopedDb,
  input: {
    organizationId: string;
    patientId: string;
    optedOut: boolean;
    source: 'STAFF' | 'KEYWORD' | 'LINK';
    actorUserId?: string;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "pharmacy_refill_reminder_preferences"
      ("id", "organizationId", "patientId", "optedOut", "source", "changedByUserId", "changedAt")
    VALUES (${randomUUID()}, ${input.organizationId}, ${input.patientId}, ${input.optedOut},
            ${input.source}, ${input.actorUserId ?? null}, ${now})
    ON CONFLICT ("organizationId", "patientId") DO UPDATE SET
      "optedOut" = EXCLUDED."optedOut", "source" = EXCLUDED."source",
      "changedByUserId" = EXCLUDED."changedByUserId", "changedAt" = EXCLUDED."changedAt"
  `);
}

/**
 * Select due CAPTURED rows globally, then re-enter each tenant RLS context.
 * Eligibility, the outbox claim and CAPTURED -> QUEUED/SKIPPED transition share
 * one transaction. No provider is invoked here: live WhatsApp remains blocked.
 */
export async function queueDueRefillReminders(options: { now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const captures = await withPlatformDb((db) =>
    db.$queryRaw<DueCapture[]>(Prisma.sql`
      SELECT "id", "organizationId", "branchId"
      FROM "pharmacy_refill_reminder_captures"
      WHERE "status" = 'CAPTURED' AND "channel" = 'WHATSAPP' AND "reminderAt" <= ${now}
      ORDER BY "reminderAt", "id" LIMIT ${limit}
    `)
  );
  const result = { scanned: captures.length, queued: 0, skipped: 0, duplicate: 0 };

  for (const candidate of captures) {
    const outcome = await withTenantDb(candidate.organizationId, async (db) => {
      const rows = await db.$queryRaw<
        Array<{ id: string; patientId: string; reminderAt: Date; reason: RefillSkipReason | null }>
      >(Prisma.sql`
        SELECT c."id", c."patientId", c."reminderAt",
          CASE
            WHEN b."id" IS NULL THEN 'BRANCH_UNAVAILABLE'
            WHEN consent."id" IS NULL THEN 'CONSENT_MISSING'
            WHEN NOT consent."granted" OR consent."revokedAt" IS NOT NULL THEN 'CONSENT_REVOKED'
            WHEN COALESCE(pref."optedOut", false) THEN 'PATIENT_OPTED_OUT'
            ELSE NULL
          END AS reason
        FROM "pharmacy_refill_reminder_captures" c
        LEFT JOIN "pharmacy_branches" b ON b."organizationId" = c."organizationId"
          AND b."id" = c."branchId" AND b."active" = true
        LEFT JOIN LATERAL (
          SELECT pc."id", pc."granted", pc."revokedAt" FROM "pharmacy_patient_consents" pc
          WHERE pc."organizationId" = c."organizationId" AND pc."patientId" = c."patientId"
            AND pc."purpose" = 'REMINDERS' AND pc."channel" = c."channel"
            AND pc."recordedAt" <= ${now}
          ORDER BY pc."version" DESC LIMIT 1
        ) consent ON true
        LEFT JOIN "pharmacy_refill_reminder_preferences" pref
          ON pref."organizationId" = c."organizationId" AND pref."patientId" = c."patientId"
        WHERE c."organizationId" = ${candidate.organizationId} AND c."branchId" = ${candidate.branchId}
          AND c."id" = ${candidate.id} AND c."status" = 'CAPTURED'
          AND c."channel" = 'WHATSAPP' AND c."reminderAt" <= ${now}
        FOR UPDATE OF c
      `);
      const capture = rows[0];
      if (!capture) return 'DUPLICATE' as const;
      if (capture.reason) {
        await db.$executeRaw(Prisma.sql`
          UPDATE "pharmacy_refill_reminder_captures"
          SET "status" = 'SKIPPED', "statusReason" = ${capture.reason}
          WHERE "organizationId" = ${candidate.organizationId} AND "id" = ${capture.id}
        `);
        return 'SKIPPED' as const;
      }
      const payload = refillReminderPayload(capture.reminderAt);
      await db.$executeRaw(Prisma.sql`
        INSERT INTO "pharmacy_message_logs"
          ("id", "organizationId", "branchId", "patientId", "direction", "kind", "status",
           "dedupeKey", "templateName", "refillCaptureId", "dueDate", "templateLocale",
           "templatePayload", "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${candidate.organizationId}, ${candidate.branchId}, ${capture.patientId},
          'OUTBOUND', 'REFILL_REMINDER', 'PENDING', ${`refill-capture:${capture.id}`},
          ${REFILL_REMINDER_TEMPLATE}, ${capture.id}, ${payload.parameters.reminderDate}, 'en-ur',
          ${JSON.stringify(payload)}::jsonb, ${now}, ${now})
        ON CONFLICT ("organizationId", "dedupeKey") DO NOTHING
      `);
      await db.$executeRaw(Prisma.sql`
        UPDATE "pharmacy_refill_reminder_captures"
        SET "status" = 'QUEUED', "statusReason" = NULL, "queuedAt" = ${now}
        WHERE "organizationId" = ${candidate.organizationId} AND "branchId" = ${candidate.branchId}
          AND "id" = ${capture.id} AND "status" = 'CAPTURED'
      `);
      return 'QUEUED' as const;
    }, { skipDrain: true });
    if (outcome === 'QUEUED') result.queued++;
    else if (outcome === 'SKIPPED') result.skipped++;
    else result.duplicate++;
  }
  return result;
}

/** Called by the existing outbox worker after provider acknowledgement. */
export async function markRefillReminderSent(
  db: ScopedDb,
  organizationId: string,
  captureId: string,
  sentAt = new Date()
) {
  return db.$executeRaw(Prisma.sql`
    UPDATE "pharmacy_refill_reminder_captures"
    SET "status" = 'SENT', "sentAt" = ${sentAt}, "statusReason" = NULL
    WHERE "organizationId" = ${organizationId} AND "id" = ${captureId} AND "status" = 'QUEUED'
  `);
}
