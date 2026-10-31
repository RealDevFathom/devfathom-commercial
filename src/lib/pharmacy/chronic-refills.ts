import 'server-only';

import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { can } from '@/lib/abac';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import { placeCustomerOrder } from './customer-ordering';
import { assertRxSaleAllowed, PharmacyRxSaleDenied } from './rx-sale-gate';
import type { LedgerScope } from './stock-ledger';

const DAY_MS = 86_400_000;
/** A cycle may be prepared (and its stock held) this far ahead of the due date. */
export const CHRONIC_REFILL_LEAD_DAYS = 2;
/** Stock stays reserved until this long after the due date so staff can act on it. */
export const CHRONIC_REFILL_HOLD_GRACE_DAYS = 2;
/** A subscription whose automatic cycle failed is retried after this delay, not every run. */
export const CHRONIC_REFILL_RETRY_HOURS = 6;

export type ChronicRefillPayment = 'PREPAY' | 'KHATA';

export class ChronicRefillError extends Error {
  constructor(
    readonly reason:
      | 'SUBSCRIPTION_NOT_FOUND'
      | 'SUBSCRIPTION_ITEM_INVALID'
      | 'PHARMACIST_APPROVAL_REQUIRED'
      | 'SUBSCRIPTION_CANCELLED'
      | 'NOT_DUE'
      | 'INVALID_FULFILLMENT'
      | 'PRESCRIPTION_EXHAUSTED'
      | 'DISPENSE_PERMISSION_REQUIRED'
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

/** Mirrors the table CHECK and placeCustomerOrder so bad input is a domain error, not a 500. */
function assertFulfillment(value: {
  fulfillment: 'COLLECT' | 'DELIVER';
  addressLine: string | null;
  city: string | null;
  deliveryInstructions: string | null;
}) {
  if (
    (value.fulfillment === 'DELIVER' && (!value.addressLine || !value.city)) ||
    (value.fulfillment === 'COLLECT' &&
      (value.addressLine || value.city || value.deliveryInstructions))
  )
    throw new ChronicRefillError('INVALID_FULFILLMENT');
}

const trimmed = (value: string | null | undefined) => value?.trim() || null;

/** First cadence step strictly after `now`, so a late run or a long pause never back-fills. */
function nextDueAfter(dueAt: Date, cadenceDays: number, now: Date) {
  const step = cadenceDays * DAY_MS;
  let next = dueAt.getTime() + step;
  if (next <= now.getTime()) next += Math.ceil((now.getTime() - next + 1) / step) * step;
  return new Date(next);
}

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
  },
  now: Date = new Date()
) {
  if (
    (input.cadenceDays !== undefined &&
      (!Number.isSafeInteger(input.cadenceDays) || input.cadenceDays < 1)) ||
    (input.quantityPacks !== undefined &&
      (!Number.isSafeInteger(input.quantityPacks) || input.quantityPacks < 1))
  )
    throw new ChronicRefillError('SUBSCRIPTION_ITEM_INVALID');
  const [current] = await db.$queryRaw<
    {
      id: string;
      active: boolean;
      cancelledAt: Date | null;
      cadenceDays: number;
      nextDueAt: Date;
      quantityPacks: number;
      fulfillment: 'COLLECT' | 'DELIVER';
      paymentMode: ChronicRefillPayment;
      addressLine: string | null;
      city: string | null;
      deliveryInstructions: string | null;
    }[]
  >(Prisma.sql`
      SELECT "id", "active", "cancelledAt", "cadenceDays", "nextDueAt", "quantityPacks",
             "fulfillment"::text AS "fulfillment", "paymentMode"::text AS "paymentMode",
             "addressLine", "city", "deliveryInstructions"
      FROM "pharmacy_chronic_refill_subscriptions"
      WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
        AND "id" = ${input.subscriptionId}
      FOR UPDATE
    `);
  if (!current) throw new ChronicRefillError('SUBSCRIPTION_NOT_FOUND');
  if (current.cancelledAt && input.action === 'REACTIVATE')
    throw new ChronicRefillError('SUBSCRIPTION_CANCELLED');

  const fulfillment = input.fulfillment ?? current.fulfillment;
  // Switching to collection clears delivery fields the caller did not explicitly set.
  const keepOrClear = (value: string | null | undefined, previous: string | null) =>
    value !== undefined ? trimmed(value) : fulfillment === 'COLLECT' ? null : previous;
  const next = {
    cadenceDays: input.cadenceDays ?? current.cadenceDays,
    nextDueAt:
      input.nextDueAt ??
      // A paused subscription resumes with one cycle due now, never a back-dated burst.
      (input.action === 'REACTIVATE' && current.nextDueAt < now
        ? now
        : current.nextDueAt),
    quantityPacks: input.quantityPacks ?? current.quantityPacks,
    fulfillment,
    paymentMode: input.paymentMode ?? current.paymentMode,
    addressLine: keepOrClear(input.addressLine, current.addressLine),
    city: keepOrClear(input.city, current.city),
    deliveryInstructions: keepOrClear(input.deliveryInstructions, current.deliveryInstructions),
  };
  assertFulfillment(next);

  const active = input.action === 'REACTIVATE' ? true : input.action ? false : current.active;
  const cancelledAt = input.action === 'CANCEL' ? now : current.cancelledAt;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(next) as (keyof typeof next)[]) {
    const from = current[key];
    const to = next[key];
    const same =
      from instanceof Date && to instanceof Date ? from.getTime() === to.getTime() : from === to;
    if (!same) changes[key] = { from, to };
  }
  const changed = await db.$executeRaw(Prisma.sql`
    UPDATE "pharmacy_chronic_refill_subscriptions"
    SET "active" = ${active}, "cancelledAt" = ${cancelledAt},
        "cadenceDays" = ${next.cadenceDays},
        "nextDueAt" = ${next.nextDueAt},
        "quantityPacks" = ${next.quantityPacks},
        "fulfillment" = ${next.fulfillment}::"PharmacyCustomerOrderFulfillment",
        "paymentMode" = ${next.paymentMode}::"PharmacyChronicRefillPayment",
        "addressLine" = ${next.addressLine},
        "city" = ${next.city},
        "deliveryInstructions" = ${next.deliveryInstructions},
        "schedulerRetryAt" = NULL, "schedulerFailure" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
      AND "id" = ${input.subscriptionId}
  `);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "pharmacy_chronic_refill_events"
      ("id", "organizationId", "branchId", "subscriptionId", "kind", "actorUserId", "details")
    VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${input.subscriptionId},
      ${input.action ?? 'EDIT'}, ${scope.actorId}, ${JSON.stringify({ changes })}::jsonb)
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
  assertFulfillment({
    fulfillment: input.fulfillment,
    addressLine: trimmed(input.addressLine),
    city: trimmed(input.city),
    deliveryInstructions: trimmed(input.deliveryInstructions),
  });

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
      AND subscription."cancelledAt" IS NULL
    FOR UPDATE OF subscription
  `);
  if (!subscription) throw new ChronicRefillError('SUBSCRIPTION_NOT_FOUND');
  // The cycle (and its stock hold) is prepared a short lead ahead of the due date.
  if (subscription.nextDueAt.getTime() - CHRONIC_REFILL_LEAD_DAYS * DAY_MS > now.getTime())
    throw new ChronicRefillError('NOT_DUE');

  if (subscription.rx) {
    if (!subscription.prescriptionLineId || !input.pharmacistDecisionId)
      throw new ChronicRefillError('PHARMACIST_APPROVAL_REQUIRED');
    // The person releasing an Rx cycle must hold the same grant an Rx sale needs.
    try {
      await assertRxSaleAllowed(db, scope, [{ rx: true, restricted: false, controlled: false }]);
    } catch (error) {
      if (error instanceof PharmacyRxSaleDenied)
        throw new ChronicRefillError('DISPENSE_PERMISSION_REQUIRED');
      throw error;
    }
    // Serialize every consumer of this prescription's remaining quantity.
    await db.$queryRaw(Prisma.sql`
      SELECT "id" FROM "pharmacy_prescription_lines"
      WHERE "organizationId" = ${scope.organizationId} AND "id" = ${subscription.prescriptionLineId}
      FOR UPDATE
    `);
    // The signature must be fresh for this cycle (made after the subscription or its previous
    // cycle), on a reviewed line that never dispensed, not since refused, and never used before.
    // Locking the reviewed sale makes a concurrent completion of it wait and then be refused by
    // the pharmacy_sale_chronic_review_claim_guard trigger.
    const [approval] = await db.$queryRaw<{ id: string; canonicalUnits: number }[]>(Prisma.sql`
      SELECT decision."id", sale_line."canonicalUnits"
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
      JOIN "pharmacy_sales" sale
        ON sale."organizationId" = sale_line."organizationId"
       AND sale."branchId" = sale_line."branchId"
       AND sale."id" = sale_line."saleId"
      WHERE decision."organizationId" = ${scope.organizationId}
        AND decision."id" = ${input.pharmacistDecisionId}
        AND decision."kind" = 'SIGN' AND decision."signedAt" IS NOT NULL
        AND decision."createdAt" >= COALESCE((
          SELECT MAX(previous."createdAt") FROM "pharmacy_chronic_refill_cycles" previous
          WHERE previous."organizationId" = subscription."organizationId"
            AND previous."branchId" = subscription."branchId"
            AND previous."subscriptionId" = subscription."id"
        ), subscription."createdAt")
        AND item."prescriptionLineId" = subscription."prescriptionLineId"
        AND sale_line."branchId" = ${scope.branchId}
        AND sale_line."medicineId" = subscription."medicineId"
        AND sale_line."presentationId" = subscription."presentationId"
        AND sale_line."packLevelId" = subscription."packLevelId"
        AND sale_line."saleUnit" = 'PACK'
        AND sale_line."quantity" = subscription."quantityPacks"
        AND sale."status" <> 'COMPLETED'
        AND NOT EXISTS (
          SELECT 1 FROM "pharmacy_prescription_fills" fill
          WHERE fill."organizationId" = sale_line."organizationId"
            AND fill."idempotencyKey" IN ('controlled:' || sale_line."id", 'rx-reference:' || sale_line."id")
        )
        AND NOT EXISTS (
          SELECT 1 FROM "pharmacy_pharmacist_review_decisions" later
          WHERE later."organizationId" = decision."organizationId"
            AND later."reviewItemId" = decision."reviewItemId"
            AND later."kind" = 'REFUSE' AND later."createdAt" >= decision."createdAt"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "pharmacy_chronic_refill_cycles" cycle
          WHERE cycle."organizationId" = decision."organizationId"
            AND cycle."pharmacistDecisionId" = decision."id"
        )
      FOR UPDATE OF sale
    `);
    if (!approval) throw new ChronicRefillError('PHARMACIST_APPROVAL_REQUIRED');

    // Draw down what remains: completed fills plus cycles already released but not yet sold.
    const [allowance] = await db.$queryRaw<
      {
        authorizedCanonicalUnits: number;
        authorizedRepeats: number;
        filledUnits: number;
        fillCount: number;
        pendingUnits: number;
        pendingCount: number;
      }[]
    >(Prisma.sql`
      SELECT line."authorizedCanonicalUnits", prescription."authorizedRepeats",
             COALESCE((SELECT SUM(fill."quantityCanonicalUnits") FROM "pharmacy_prescription_fills" fill
               WHERE fill."organizationId" = line."organizationId"
                 AND fill."prescriptionLineId" = line."id"), 0)::integer AS "filledUnits",
             (SELECT COUNT(*) FROM "pharmacy_prescription_fills" fill
               WHERE fill."organizationId" = line."organizationId"
                 AND fill."prescriptionLineId" = line."id")::integer AS "fillCount",
             COALESCE((SELECT SUM(order_line."canonicalUnits")
               FROM "pharmacy_chronic_refill_cycles" cycle
               JOIN "pharmacy_chronic_refill_subscriptions" pending
                 ON pending."organizationId" = cycle."organizationId"
                AND pending."branchId" = cycle."branchId" AND pending."id" = cycle."subscriptionId"
               JOIN "pharmacy_customer_orders" customer_order
                 ON customer_order."organizationId" = cycle."organizationId"
                AND customer_order."branchId" = cycle."branchId" AND customer_order."id" = cycle."orderId"
               JOIN "pharmacy_customer_order_lines" order_line
                 ON order_line."organizationId" = customer_order."organizationId"
                AND order_line."branchId" = customer_order."branchId"
                AND order_line."orderId" = customer_order."id"
               LEFT JOIN "pharmacy_sales" counter_sale
                 ON counter_sale."organizationId" = customer_order."organizationId"
                AND counter_sale."branchId" = customer_order."branchId"
                AND counter_sale."id" = customer_order."counterSaleId"
               WHERE cycle."organizationId" = line."organizationId"
                 AND pending."prescriptionLineId" = line."id"
                 AND customer_order."status" IN ('PROPOSED', 'ACCEPTED', 'PACKING', 'READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY')
                 AND (counter_sale."id" IS NULL OR counter_sale."status" <> 'COMPLETED')), 0)::integer AS "pendingUnits",
             (SELECT COUNT(*)
               FROM "pharmacy_chronic_refill_cycles" cycle
               JOIN "pharmacy_chronic_refill_subscriptions" pending
                 ON pending."organizationId" = cycle."organizationId"
                AND pending."branchId" = cycle."branchId" AND pending."id" = cycle."subscriptionId"
               JOIN "pharmacy_customer_orders" customer_order
                 ON customer_order."organizationId" = cycle."organizationId"
                AND customer_order."branchId" = cycle."branchId" AND customer_order."id" = cycle."orderId"
               LEFT JOIN "pharmacy_sales" counter_sale
                 ON counter_sale."organizationId" = customer_order."organizationId"
                AND counter_sale."branchId" = customer_order."branchId"
                AND counter_sale."id" = customer_order."counterSaleId"
               WHERE cycle."organizationId" = line."organizationId"
                 AND pending."prescriptionLineId" = line."id"
                 AND customer_order."status" IN ('PROPOSED', 'ACCEPTED', 'PACKING', 'READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY')
                 AND (counter_sale."id" IS NULL OR counter_sale."status" <> 'COMPLETED'))::integer AS "pendingCount"
      FROM "pharmacy_prescription_lines" line
      JOIN "pharmacy_prescriptions" prescription
        ON prescription."organizationId" = line."organizationId"
       AND prescription."id" = line."prescriptionId"
      JOIN "pharmacy_customers" customer
        ON customer."organizationId" = prescription."organizationId"
       AND customer."patientId" = prescription."patientId"
      WHERE line."organizationId" = ${scope.organizationId}
        AND line."id" = ${subscription.prescriptionLineId}
        AND customer."id" = ${subscription.customerId}
        AND prescription."validFrom" <= ${now}
        AND prescription."validUntil" > ${now}
        AND prescription."validUntil" >= ${subscription.nextDueAt}
    `);
    const units = Number(approval.canonicalUnits);
    if (
      !allowance ||
      !Number.isSafeInteger(units) ||
      units <= 0 ||
      Number(allowance.filledUnits) + Number(allowance.pendingUnits) + units >
        Number(allowance.authorizedCanonicalUnits) ||
      Number(allowance.fillCount) + Number(allowance.pendingCount) >
        Number(allowance.authorizedRepeats)
    )
      throw new ChronicRefillError('PRESCRIPTION_EXHAUSTED');
  }

  const holdFrom = Math.max(subscription.nextDueAt.getTime(), now.getTime());
  const order = await placeCustomerOrder(db, scope, {
    customerId: subscription.customerId,
    staff: true,
    fulfillment: subscription.fulfillment,
    intendedPaymentMethod: subscription.paymentMode === 'KHATA' ? 'CREDIT' : 'BANK_TRANSFER',
    addressLine: subscription.addressLine ?? undefined,
    city: subscription.city ?? undefined,
    deliveryInstructions: subscription.deliveryInstructions ?? undefined,
    // Hold the pack through the due date plus a grace period, not the 30-minute default.
    reservationExpiresAt: new Date(holdFrom + CHRONIC_REFILL_HOLD_GRACE_DAYS * DAY_MS),
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
  const nextDueAt = nextDueAfter(subscription.nextDueAt, subscription.cadenceDays, now);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "pharmacy_chronic_refill_cycles"
      ("id", "organizationId", "branchId", "subscriptionId", "dueAt", "orderId",
       "pharmacistDecisionId", "createdByUserId")
    VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${subscription.id},
      ${subscription.nextDueAt}, ${order.id}, ${subscription.rx ? input.pharmacistDecisionId! : null}, ${scope.actorId})
  `);
  await db.$executeRaw(Prisma.sql`
    UPDATE "pharmacy_chronic_refill_subscriptions"
      SET "nextDueAt" = ${nextDueAt}, "schedulerRetryAt" = NULL, "schedulerFailure" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
        AND "id" = ${subscription.id}
  `);
  return { order, nextDueAt };
}

type SchedulerCandidate = {
  id: string;
  organizationId: string;
  branchId: string;
  createdByUserId: string;
};

/** Tenant, module, branch and actor must all still be live before an automatic cycle runs. */
async function schedulerSkipReason(db: ScopedDb, candidate: SchedulerCandidate, now: Date) {
  const organization = await db.organization.findUnique({
    where: { id: candidate.organizationId },
    select: { vertical: true, status: true },
  });
  if (
    !organization ||
    organization.vertical !== 'PHARMACY' ||
    !isTenantLifecycleAccessible(organization.status)
  )
    return 'TENANT_INACTIVE';
  if (
    !hasModule(
      await resolveOrganizationEntitlements(candidate.organizationId, db, now),
      'pharmacy-counter'
    )
  )
    return 'MODULE_NOT_ENTITLED';
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId: candidate.organizationId, id: candidate.branchId, active: true },
    select: { id: true },
  });
  if (!branch) return 'BRANCH_INACTIVE';
  const actor = await db.user.findFirst({
    where: { organizationId: candidate.organizationId, id: candidate.createdByUserId },
    select: { status: true },
  });
  if (
    actor?.status !== 'ACTIVE' ||
    !(await can({ id: candidate.createdByUserId, role: 'EMPLOYEE' }, 'pharmacy:orders', undefined, {
      db,
    }))
  )
    return 'ACTOR_INACTIVE';
  return null;
}

function failureReason(error: unknown) {
  if (error instanceof ChronicRefillError) return error.reason;
  const reason = (error as { reason?: unknown } | null)?.reason;
  if (typeof reason === 'string') return reason.slice(0, 120);
  return 'UNEXPECTED_ERROR';
}

/** Scheduler tick. Non-Rx subscriptions recur automatically; Rx remains pharmacist-triggered. */
export async function processDueChronicRefills(options: { now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const leadEnd = new Date(now.getTime() + CHRONIC_REFILL_LEAD_DAYS * DAY_MS);
  const candidates = await withPlatformDb((db) =>
    db.$queryRaw<SchedulerCandidate[]>(Prisma.sql`
      SELECT subscription."id", subscription."organizationId", subscription."branchId",
             subscription."createdByUserId"
      FROM "pharmacy_chronic_refill_subscriptions" subscription
      JOIN "pharmacy_medicines" medicine
        ON medicine."organizationId" = subscription."organizationId"
       AND medicine."id" = subscription."medicineId"
      WHERE subscription."active" AND subscription."cancelledAt" IS NULL
        AND subscription."nextDueAt" <= ${leadEnd} AND NOT medicine."rx"
        AND (subscription."schedulerRetryAt" IS NULL OR subscription."schedulerRetryAt" <= ${now})
      ORDER BY subscription."nextDueAt", subscription."id"
      LIMIT ${limit}
    `)
  );
  const result = { scanned: candidates.length, created: 0, skipped: 0, failed: 0 };
  for (const candidate of candidates) {
    const scope = {
      organizationId: candidate.organizationId,
      branchId: candidate.branchId,
      actorId: candidate.createdByUserId,
    };
    let reason: string | null = null;
    try {
      reason = await withTenantDb(
        candidate.organizationId,
        (db) =>
          db.$transaction(async (tx) => {
            const skip = await schedulerSkipReason(tx as ScopedDb, candidate, now);
            if (skip) return skip;
            await createDueChronicRefillOrder(tx as ScopedDb, scope, {
              subscriptionId: candidate.id,
              now,
            });
            return null;
          }),
        { userId: candidate.createdByUserId }
      );
      if (!reason) {
        result.created += 1;
        continue;
      }
      result.skipped += 1;
    } catch (error) {
      // One out-of-stock or concurrently claimed subscription must not stop the sweep.
      reason = failureReason(error);
      result.failed += 1;
      console.error('[chronic-refills] automatic cycle failed', {
        organizationId: candidate.organizationId,
        subscriptionId: candidate.id,
        reason,
      });
    }
    if (reason === 'NOT_DUE' || reason === 'SUBSCRIPTION_NOT_FOUND') continue;
    // Defer the row so persistent failures cannot occupy the head of the queue, and leave
    // staff-visible evidence of why the cycle did not run.
    await withTenantDb(
      candidate.organizationId,
      (db) =>
        db.$transaction(async (tx) => {
          const [previous] = await tx.$queryRaw<{ schedulerFailure: string | null }[]>(Prisma.sql`
            SELECT "schedulerFailure" FROM "pharmacy_chronic_refill_subscriptions"
            WHERE "organizationId" = ${candidate.organizationId}
              AND "branchId" = ${candidate.branchId} AND "id" = ${candidate.id}
            FOR UPDATE
          `);
          if (!previous) return;
          await tx.$executeRaw(Prisma.sql`
            UPDATE "pharmacy_chronic_refill_subscriptions"
            SET "schedulerRetryAt" = ${new Date(now.getTime() + CHRONIC_REFILL_RETRY_HOURS * 3_600_000)},
                "schedulerFailure" = ${reason}, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "organizationId" = ${candidate.organizationId}
              AND "branchId" = ${candidate.branchId} AND "id" = ${candidate.id}
          `);
          // One event per distinct failure, not one per retry of a long-suspended tenant.
          if (previous.schedulerFailure === reason) return;
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "pharmacy_chronic_refill_events"
              ("id", "organizationId", "branchId", "subscriptionId", "kind", "actorUserId", "details")
            VALUES (${randomUUID()}, ${candidate.organizationId}, ${candidate.branchId}, ${candidate.id},
              'SCHEDULER_FAILED', ${candidate.createdByUserId}, ${JSON.stringify({ reason })}::jsonb)
          `);
        }),
      { userId: candidate.createdByUserId }
    ).catch((error: unknown) => {
      console.error('[chronic-refills] could not defer failed subscription', {
        organizationId: candidate.organizationId,
        subscriptionId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return result;
}
