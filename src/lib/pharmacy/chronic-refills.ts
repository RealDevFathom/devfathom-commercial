import 'server-only';

import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

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
    WHERE medicine."organizationId" = ${scope.organizationId}
      AND medicine."id" = ${input.medicineId}
      AND presentation."id" = ${input.presentationId}
      AND pack."id" = ${input.packLevelId}
      AND medicine."saleable" AND NOT medicine."restricted" AND NOT medicine."controlled"
  `);
  if (!item || (item.rx && !input.prescriptionLineId))
    throw new ChronicRefillError('SUBSCRIPTION_ITEM_INVALID');

  const id = randomUUID();
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "pharmacy_chronic_refill_subscriptions"
      ("id", "organizationId", "branchId", "customerId", "medicineId", "presentationId",
       "packLevelId", "quantityPacks", "prescriptionLineId", "fulfillment", "paymentMode",
       "addressLine", "city", "deliveryInstructions", "cadenceDays", "nextDueAt", "createdByUserId")
    VALUES (${id}, ${scope.organizationId}, ${scope.branchId}, ${input.customerId},
      ${input.medicineId}, ${input.presentationId}, ${input.packLevelId}, ${input.quantityPacks},
      ${input.prescriptionLineId ?? null}, ${input.fulfillment}::"PharmacyCustomerOrderFulfillment",
      ${input.paymentMode}::"PharmacyChronicRefillPayment", ${input.addressLine?.trim() || null},
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
