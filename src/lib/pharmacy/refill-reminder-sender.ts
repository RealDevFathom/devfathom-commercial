import 'server-only';

import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

export const REFILL_REMINDER_TEMPLATE = 'refill_reminder_bilingual_v1';
export const REFILL_OPT_OUT_KEYWORD = 'STOP REFILL';

export type RefillSkipReason =
  'CONSENT_MISSING' | 'CONSENT_REVOKED' | 'PATIENT_OPTED_OUT' | 'BRANCH_UNAVAILABLE';

type DueCapture = { id: string; organizationId: string; branchId: string; patientId: string };

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

/**
 * Persist the preference independently from general WhatsApp/loyalty flags.
 * Returns whether the stored preference was written.
 *
 * `ordered` is for a customer's `STOP REFILL` reply: it applies only when it is
 * not older than the stored decision, and an opt-out wins an equal timestamp
 * (provider timestamps have second precision). A delayed or replayed reply can
 * therefore never undo a newer staff or link decision.
 */
export async function setRefillReminderPreference(
  db: ScopedDb,
  input: {
    organizationId: string;
    patientId: string;
    optedOut: boolean;
    source: 'STAFF' | 'KEYWORD' | 'LINK';
    actorUserId?: string;
    now?: Date;
    ordered?: boolean;
  }
): Promise<boolean> {
  const now = input.now ?? new Date();
  // This patient row is the serialization point shared with the scheduler. It
  // prevents a preference/consent change racing a reminder eligibility claim.
  await db.$queryRaw(Prisma.sql`
    SELECT "id" FROM "pharmacy_patients"
    WHERE "organizationId" = ${input.organizationId} AND "id" = ${input.patientId}
    FOR UPDATE
  `);
  const written = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO "pharmacy_refill_reminder_preferences" AS pref
      ("id", "organizationId", "patientId", "optedOut", "source", "changedByUserId", "changedAt")
    VALUES (${randomUUID()}, ${input.organizationId}, ${input.patientId}, ${input.optedOut},
            ${input.source}, ${input.actorUserId ?? null}, ${now})
    ON CONFLICT ("organizationId", "patientId") DO UPDATE SET
      "optedOut" = EXCLUDED."optedOut", "source" = EXCLUDED."source",
      "changedByUserId" = EXCLUDED."changedByUserId", "changedAt" = EXCLUDED."changedAt"
    ${
      input.ordered
        ? Prisma.sql`WHERE pref."changedAt" < EXCLUDED."changedAt"
            OR (pref."changedAt" = EXCLUDED."changedAt" AND EXCLUDED."optedOut")`
        : Prisma.empty
    }
    RETURNING pref."id"
  `);
  return written.length === 1;
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
      SELECT "id", "organizationId", "branchId", "patientId"
      FROM "pharmacy_refill_reminder_captures"
      WHERE "status" = 'CAPTURED' AND "channel" = 'WHATSAPP' AND "reminderAt" <= ${now}
      ORDER BY "reminderAt", "id" LIMIT ${limit}
    `)
  );
  const result = { scanned: captures.length, queued: 0, skipped: 0, duplicate: 0 };

  for (const candidate of captures) {
    const outcome = await withTenantDb(
      candidate.organizationId,
      async (db) => {
        // Consent events reference the patient row, preference writes take the
        // same lock, and branch availability changes update the branch row.
        // Eligibility therefore remains true through the outbox claim.
        await db.$queryRaw(Prisma.sql`
        SELECT p."id" FROM "pharmacy_patients" p
        JOIN "pharmacy_branches" b ON b."organizationId" = p."organizationId"
          AND b."id" = ${candidate.branchId}
        WHERE p."organizationId" = ${candidate.organizationId} AND p."id" = ${candidate.patientId}
        FOR UPDATE OF p, b
      `);
        const rows = await db.$queryRaw<
          Array<{
            id: string;
            patientId: string;
            reminderAt: Date;
            reason: RefillSkipReason | null;
          }>
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
          WHERE "organizationId" = ${candidate.organizationId}
            AND "branchId" = ${candidate.branchId} AND "id" = ${capture.id}
            AND "status" = 'CAPTURED'
        `);
          return 'SKIPPED' as const;
        }
        const payload = refillReminderPayload(capture.reminderAt);
        const inserted = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "pharmacy_message_logs"
          ("id", "organizationId", "branchId", "patientId", "direction", "kind", "status",
           "dedupeKey", "templateName", "refillCaptureId", "dueDate", "templateLocale",
           "templatePayload", "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${candidate.organizationId}, ${candidate.branchId}, ${capture.patientId},
          'OUTBOUND', 'REFILL_REMINDER', 'PENDING', ${`refill-capture:${capture.id}`},
          ${REFILL_REMINDER_TEMPLATE}, ${capture.id}, ${payload.parameters.reminderDate}, 'en-ur',
          ${JSON.stringify(payload)}::jsonb, ${now}, ${now})
        ON CONFLICT ("organizationId", "dedupeKey") DO NOTHING
        RETURNING "id"
      `);
        // Never advance the capture when this transaction did not create the
        // matching outbox record. This makes an unexpected dedupe collision fail
        // closed rather than authorizing delivery from unrelated evidence.
        if (inserted.length !== 1) return 'DUPLICATE' as const;
        await db.$executeRaw(Prisma.sql`
        UPDATE "pharmacy_refill_reminder_captures"
        SET "status" = 'QUEUED', "statusReason" = NULL, "queuedAt" = ${now}
        WHERE "organizationId" = ${candidate.organizationId} AND "branchId" = ${candidate.branchId}
          AND "id" = ${capture.id} AND "status" = 'CAPTURED'
      `);
        return 'QUEUED' as const;
      },
      { skipDrain: true }
    );
    if (outcome === 'QUEUED') result.queued++;
    else if (outcome === 'SKIPPED') result.skipped++;
    else result.duplicate++;
  }
  return result;
}

/**
 * QUEUED -> SENT, only on the evidence of the capture's own outbox claim: the
 * outbound REFILL_REMINDER log written with it (same tenant, branch and
 * capture, `refill-capture:<id>` key) must carry this provider message id in a
 * state the provider accepted. Callers run it in the transaction that records
 * that acceptance (`sendClaimedMessage`, `applyProviderAck`), so the log and
 * the capture move together. Returns the number of captures moved.
 */
export async function markRefillReminderSent(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    captureId: string;
    messageLogId: string;
    providerMessageId: string;
    sentAt: Date;
  }
) {
  return db.$executeRaw(Prisma.sql`
    UPDATE "pharmacy_refill_reminder_captures" AS c
    SET "status" = 'SENT', "sentAt" = ${input.sentAt}, "statusReason" = NULL
    WHERE c."organizationId" = ${input.organizationId} AND c."branchId" = ${input.branchId}
      AND c."id" = ${input.captureId} AND c."status" = 'QUEUED'
      AND EXISTS (
        SELECT 1 FROM "pharmacy_message_logs" l
        WHERE l."organizationId" = c."organizationId" AND l."branchId" = c."branchId"
          AND l."id" = ${input.messageLogId} AND l."refillCaptureId" = c."id"
          AND l."dedupeKey" = 'refill-capture:' || c."id"
          AND l."direction" = 'OUTBOUND' AND l."kind" = 'REFILL_REMINDER'
          AND l."providerMessageId" = ${input.providerMessageId}
          AND l."status" IN ('SENT', 'DELIVERED', 'READ')
      )
  `);
}
