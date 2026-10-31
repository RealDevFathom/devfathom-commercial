import 'server-only';

import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import { placeCustomerOrder } from './customer-ordering';
import type { LedgerScope } from './stock-ledger';

const DAY_MS = 86_400_000;

export type ChronicRefillPayment = 'PREPAY' | 'KHATA';

export class ChronicRefillError extends Error {
  constructor(
    readonly reason:
      | 'SUBSCRIPTION_NOT_FOUND'
      | 'SUBSCRIPTION_ITEM_INVALID'
      | 'PHARMACIST_APPROVAL_REQUIRED'
      | 'SUBSCRIPTION_CANCELLED'
      | 'NOT_DUE'
  ) {
    super(reason);
  }
}

/**
 * Meta/DRAP-safe utility copy. Deliberately accepts no product data so a caller
 * cannot accidentally interpolate a drug, salt, strength, or medicine class.
 */
export function chronicRefillReminderText(input: {
  pharmacyName: string;
  dueDate: Date;
  fulfillment: 'COLLECT' | 'DELIVER';
}) {
  const date = input.dueDate.toISOString().slice(0, 10);
  const action = input.fulfillment === 'DELIVER' ? 'delivery' : 'collection';
  return `${input.pharmacyName}: your monthly order is scheduled for ${action} on ${date}. Reply YES to confirm or call us to make a change.`;
}

type DueSubscription = {
  id: string;
  customerId: string;
  fulfillment: 'COLLECT' | 'DELIVER';
  paymentMode: ChronicRefillPayment;
  addressLine: string | null;
  city: string | null;
  deliveryInstructions: string | null;
  cadenceDays: number;
  nextDueAt: Date;
  medicineId: string;
  presentationId: string;
  packLevelId: string;
  quantityPacks: number;
  prescriptionLineId: string | null;
  rx: boolean;
};

export type ChronicRefillLifecycleAction = 'PAUSE' | 'REACTIVATE' | 'CANCEL';

export async function listChronicRefillSubscriptions(db: ScopedDb, scope: LedgerScope) {
  return db.$queryRaw(Prisma.sql`
    SELECT subscription.*, cycle."orderId" AS "lastOrderId", cycle."createdAt" AS "lastCycleAt"
    FROM "pharmacy_chronic_refill_subscriptions" subscription
    LEFT JOIN LATERAL (
      SELECT "orderId", "createdAt" FROM "pharmacy_chronic_refill_cycles"
      WHERE "organizationId" = subscription."organizationId"
        AND "branchId" = subscription."branchId" AND "subscriptionId" = subscription."id"
      ORDER BY "createdAt" DESC LIMIT 1
    ) cycle ON true
    WHERE subscription."organizationId" = ${scope.organizationId}
      AND subscription."branchId" = ${scope.branchId}
    ORDER BY subscription."nextDueAt", subscription."id"
  `);
}

/** Staff lifecycle/edit command. Every change is recorded as immutable evidence. */
export async function updateChronicRefillSubscription(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    subscriptionId: string;
    action?: ChronicRefillLifecycleAction;
    cadenceDays?: number;
    nextDueAt?: Date;
    quantityPacks?: number;
    fulfillment?: 'COLLECT' | 'DELIVER';
    paymentMode?: ChronicRefillPayment;
    addressLine?: string | null;
    city?: string | null;
    deliveryInstructions?: string | null;
  }
) {
  if (
    (input.cadenceDays !== undefined &&
      (!Number.isSafeInteger(input.cadenceDays) || input.cadenceDays < 1)) ||
    (input.quantityPacks !== undefined &&
      (!Number.isSafeInteger(input.quantityPacks) || input.quantityPacks < 1))
  )
    throw new ChronicRefillError('SUBSCRIPTION_ITEM_INVALID');
  const [current] = await db.$queryRaw<{ id: string; active: boolean; cancelledAt: Date | null }[]>(
    Prisma.sql`
      SELECT "id", "active", "cancelledAt"
      FROM "pharmacy_chronic_refill_subscriptions"
      WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
        AND "id" = ${input.subscriptionId}
      FOR UPDATE
    `
  );
  if (!current) throw new ChronicRefillError('SUBSCRIPTION_NOT_FOUND');
  if (current.cancelledAt && input.action === 'REACTIVATE')
    throw new ChronicRefillError('SUBSCRIPTION_CANCELLED');

  const active = input.action === 'REACTIVATE' ? true : input.action ? false : current.active;
  const cancelledAt = input.action === 'CANCEL' ? new Date() : current.cancelledAt;
  const changed = await db.$executeRaw(Prisma.sql`
    UPDATE "pharmacy_chronic_refill_subscriptions"
    SET "active" = ${active}, "cancelledAt" = ${cancelledAt},
        "cadenceDays" = COALESCE(${input.cadenceDays ?? null}, "cadenceDays"),
        "nextDueAt" = COALESCE(${input.nextDueAt ?? null}, "nextDueAt"),
        "quantityPacks" = COALESCE(${input.quantityPacks ?? null}, "quantityPacks"),
        "fulfillment" = COALESCE(${input.fulfillment ?? null}::"PharmacyCustomerOrderFulfillment", "fulfillment"),
        "paymentMode" = COALESCE(${input.paymentMode ?? null}::"PharmacyChronicRefillPayment", "paymentMode"),
        "addressLine" = CASE WHEN ${input.addressLine === undefined} THEN "addressLine" ELSE ${input.addressLine?.trim() || null} END,
        "city" = CASE WHEN ${input.city === undefined} THEN "city" ELSE ${input.city?.trim() || null} END,
        "deliveryInstructions" = CASE WHEN ${input.deliveryInstructions === undefined} THEN "deliveryInstructions" ELSE ${input.deliveryInstructions?.trim() || null} END,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
      AND "id" = ${input.subscriptionId}
  `);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "pharmacy_chronic_refill_events"
      ("id", "organizationId", "branchId", "subscriptionId", "kind", "actorUserId", "details")
    VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${input.subscriptionId},
      ${input.action ?? 'EDIT'}, ${scope.actorId}, ${JSON.stringify({
        cadenceDays: input.cadenceDays,
        nextDueAt: input.nextDueAt,
        quantityPacks: input.quantityPacks,
        fulfillment: input.fulfillment,
        paymentMode: input.paymentMode,
      })}::jsonb)
  `);
  return { id: input.subscriptionId, active, cancelledAt, changed: changed === 1 };
}

export async function createChronicRefillSubscription(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    customerId: string;
    medicineId: string;
    presentationId: string;
    packLevelId: string;
    quantityPacks: number;
    prescriptionLineId?: string;
    reminderConsentId?: string;
    fulfillment: 'COLLECT' | 'DELIVER';
    paymentMode: ChronicRefillPayment;
    addressLine?: string;
    city?: string;
    deliveryInstructions?: string;
    cadenceDays: number;
    nextDueAt: Date;
  }
) {
  if (
    !Number.isSafeInteger(input.quantityPacks) ||
    input.quantityPacks <= 0 ||
    !Number.isSafeInteger(input.cadenceDays) ||
    input.cadenceDays < 1
  )
    throw new ChronicRefillError('SUBSCRIPTION_ITEM_INVALID');

  const [item] = await db.$queryRaw<{ rx: boolean }[]>(Prisma.sql`
    SELECT medicine."rx"
    FROM "pharmacy_medicines" medicine
    JOIN "pharmacy_presentations" presentation
      ON presentation."organizationId" = medicine."organizationId"
     AND presentation."medicineId" = medicine."id"
    JOIN "pharmacy_pack_levels" pack
      ON pack."organizationId" = presentation."organizationId"
     AND pack."presentationId" = presentation."id"
    JOIN "pharmacy_customers" customer
      ON customer."organizationId" = medicine."organizationId" AND customer."id" = ${input.customerId}
    LEFT JOIN "pharmacy_prescription_lines" rx_line
      ON rx_line."organizationId" = medicine."organizationId"
     AND rx_line."id" = ${input.prescriptionLineId ?? null}
    LEFT JOIN "pharmacy_prescriptions" prescription
      ON prescription."organizationId" = rx_line."organizationId"
     AND prescription."id" = rx_line."prescriptionId"
    LEFT JOIN "pharmacy_patient_consents" reminder_consent
      ON reminder_consent."organizationId" = customer."organizationId"
     AND reminder_consent."id" = ${input.reminderConsentId ?? null}
    WHERE medicine."organizationId" = ${scope.organizationId}
      AND medicine."id" = ${input.medicineId}
      AND presentation."id" = ${input.presentationId}
      AND pack."id" = ${input.packLevelId}
      AND medicine."saleable" AND NOT medicine."restricted" AND NOT medicine."controlled"
      AND (${input.reminderConsentId ?? null}::text IS NULL OR (
        reminder_consent."patientId" = customer."patientId"
        AND reminder_consent."purpose" = 'REMINDERS'
        AND reminder_consent."channel" = 'WHATSAPP'
        AND reminder_consent."granted" AND reminder_consent."revokedAt" IS NULL
      ))
      AND (NOT medicine."rx" OR (
        rx_line."medicineId" = medicine."id"
        AND rx_line."presentationId" = presentation."id"
        AND prescription."patientId" = customer."patientId"
        AND prescription."validFrom" <= ${input.nextDueAt}
        AND prescription."validUntil" >= ${input.nextDueAt}
      ))
  `);
  if (!item || (item.rx && !input.prescriptionLineId))
    throw new ChronicRefillError('SUBSCRIPTION_ITEM_INVALID');

  const id = randomUUID();
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "pharmacy_chronic_refill_subscriptions"
      ("id", "organizationId", "branchId", "customerId", "medicineId", "presentationId",
       "packLevelId", "quantityPacks", "prescriptionLineId", "fulfillment", "paymentMode",
       "reminderConsentId", "addressLine", "city", "deliveryInstructions", "cadenceDays", "nextDueAt", "createdByUserId")
    VALUES (${id}, ${scope.organizationId}, ${scope.branchId}, ${input.customerId},
      ${input.medicineId}, ${input.presentationId}, ${input.packLevelId}, ${input.quantityPacks},
      ${input.prescriptionLineId ?? null}, ${input.fulfillment}::"PharmacyCustomerOrderFulfillment",
      ${input.paymentMode}::"PharmacyChronicRefillPayment", ${input.reminderConsentId ?? null}, ${input.addressLine?.trim() || null},
      ${input.city?.trim() || null}, ${input.deliveryInstructions?.trim() || null},
      ${input.cadenceDays}, ${input.nextDueAt}, ${scope.actorId})
  `);
  return { id, nextDueAt: input.nextDueAt };
}

/** Creates exactly one order/cycle; the caller's transaction makes reservation and cycle atomic. */
export async function createDueChronicRefillOrder(
  db: ScopedDb,
  scope: LedgerScope,
  input: { subscriptionId: string; pharmacistDecisionId?: string; now?: Date }
) {
  const now = input.now ?? new Date();
  const [subscription] = await db.$queryRaw<DueSubscription[]>(Prisma.sql`
    SELECT subscription.*, medicine."rx"
    FROM "pharmacy_chronic_refill_subscriptions" subscription
    JOIN "pharmacy_medicines" medicine
      ON medicine."organizationId" = subscription."organizationId"
     AND medicine."id" = subscription."medicineId"
    WHERE subscription."organizationId" = ${scope.organizationId}
      AND subscription."branchId" = ${scope.branchId}
      AND subscription."id" = ${input.subscriptionId} AND subscription."active"
    FOR UPDATE OF subscription
  `);
  if (!subscription) throw new ChronicRefillError('SUBSCRIPTION_NOT_FOUND');
  if (subscription.nextDueAt > now) throw new ChronicRefillError('NOT_DUE');

  if (subscription.rx) {
    const [approval] = input.pharmacistDecisionId
      ? await db.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT decision."id"
          FROM "pharmacy_pharmacist_review_decisions" decision
          JOIN "pharmacy_chronic_refill_subscriptions" subscription
            ON subscription."organizationId" = decision."organizationId"
           AND subscription."branchId" = ${scope.branchId}
           AND subscription."id" = ${subscription.id}
          JOIN "pharmacy_pharmacist_review_items" item
            ON item."organizationId" = decision."organizationId"
           AND item."id" = decision."reviewItemId"
          JOIN "pharmacy_sale_lines" sale_line
            ON sale_line."organizationId" = item."organizationId"
           AND sale_line."id" = item."saleLineId"
          WHERE decision."organizationId" = ${scope.organizationId}
            AND decision."id" = ${input.pharmacistDecisionId}
            AND decision."kind" = 'SIGN' AND decision."signedAt" IS NOT NULL
            AND item."prescriptionLineId" = ${subscription.prescriptionLineId}
            AND sale_line."branchId" = ${scope.branchId}
            AND sale_line."medicineId" = subscription."medicineId"
            AND sale_line."presentationId" = subscription."presentationId"
            AND sale_line."packLevelId" = subscription."packLevelId"
            AND sale_line."saleUnit" = 'PACK'
            AND sale_line."quantity" = subscription."quantityPacks"
            AND sale_line."canonicalUnits" <= (
              SELECT line."authorizedCanonicalUnits"
              FROM "pharmacy_prescription_lines" line
              JOIN "pharmacy_prescriptions" prescription
                ON prescription."organizationId" = line."organizationId"
               AND prescription."id" = line."prescriptionId"
              JOIN "pharmacy_customers" customer
                ON customer."organizationId" = prescription."organizationId"
               AND customer."patientId" = prescription."patientId"
              WHERE line."organizationId" = subscription."organizationId"
                AND line."id" = subscription."prescriptionLineId"
                AND customer."id" = subscription."customerId"
                AND prescription."validFrom" <= subscription."nextDueAt"
                AND prescription."validUntil" >= subscription."nextDueAt"
            )
            AND NOT EXISTS (
              SELECT 1 FROM "pharmacy_chronic_refill_cycles" cycle
              WHERE cycle."organizationId" = decision."organizationId"
                AND cycle."pharmacistDecisionId" = decision."id"
            )
        `)
      : [];
    if (!approval) throw new ChronicRefillError('PHARMACIST_APPROVAL_REQUIRED');
  }

  const order = await placeCustomerOrder(db, scope, {
    customerId: subscription.customerId,
    staff: true,
    fulfillment: subscription.fulfillment,
    intendedPaymentMethod: subscription.paymentMode === 'KHATA' ? 'CREDIT' : 'BANK_TRANSFER',
    addressLine: subscription.addressLine ?? undefined,
    city: subscription.city ?? undefined,
    deliveryInstructions: subscription.deliveryInstructions ?? undefined,
    reviewedRx: subscription.rx,
    lines: [
      {
        medicineId: subscription.medicineId,
        presentationId: subscription.presentationId,
        packLevelId: subscription.packLevelId,
        saleUnit: 'PACK',
        quantity: subscription.quantityPacks,
      },
    ],
  });
  if (!order) throw new ChronicRefillError('SUBSCRIPTION_ITEM_INVALID');
  const nextDueAt = new Date(subscription.nextDueAt.getTime() + subscription.cadenceDays * DAY_MS);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "pharmacy_chronic_refill_cycles"
      ("id", "organizationId", "branchId", "subscriptionId", "dueAt", "orderId",
       "pharmacistDecisionId", "createdByUserId")
    VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${subscription.id},
      ${subscription.nextDueAt}, ${order.id}, ${input.pharmacistDecisionId ?? null}, ${scope.actorId})
  `);
  await db.$executeRaw(Prisma.sql`
    UPDATE "pharmacy_chronic_refill_subscriptions"
      SET "nextDueAt" = ${nextDueAt}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "organizationId" = ${scope.organizationId} AND "id" = ${subscription.id}
  `);
  return { order, nextDueAt };
}

/** Scheduler tick. Non-Rx subscriptions recur automatically; Rx remains pharmacist-triggered. */
export async function processDueChronicRefills(options: { now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const candidates = await withPlatformDb((db) =>
    db.$queryRaw<
      { id: string; organizationId: string; branchId: string; createdByUserId: string }[]
    >(Prisma.sql`
      SELECT subscription."id", subscription."organizationId", subscription."branchId",
             subscription."createdByUserId"
      FROM "pharmacy_chronic_refill_subscriptions" subscription
      JOIN "pharmacy_medicines" medicine
        ON medicine."organizationId" = subscription."organizationId"
       AND medicine."id" = subscription."medicineId"
      WHERE subscription."active" AND subscription."cancelledAt" IS NULL
        AND subscription."nextDueAt" <= ${now} AND NOT medicine."rx"
      ORDER BY subscription."nextDueAt", subscription."id"
      LIMIT ${limit}
    `)
  );
  const result = { scanned: candidates.length, created: 0, failed: 0 };
  for (const candidate of candidates) {
    try {
      await withTenantDb(
        candidate.organizationId,
        (db) =>
          db.$transaction((tx) =>
            createDueChronicRefillOrder(
              tx as ScopedDb,
              {
                organizationId: candidate.organizationId,
                branchId: candidate.branchId,
                actorId: candidate.createdByUserId,
              },
              { subscriptionId: candidate.id, now }
            )
          ),
        { userId: candidate.createdByUserId }
      );
      result.created += 1;
    } catch {
      // One out-of-stock or concurrently claimed subscription must not stop the sweep.
      result.failed += 1;
    }
  }
  return result;
}
