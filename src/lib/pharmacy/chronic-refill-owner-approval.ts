import 'server-only';

import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import { can } from '@/lib/abac';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';

/** The caller must commit blocked results so bad PIN attempts retain their lockout counters. */
export async function approveChronicRefillAsOwner(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    subscriptionId: string;
    reviewItemId: string;
    staffProfileId: string;
    pin: string;
    reason: string;
  }
): Promise<{ blocked: true } | { decisionId: string }> {
  await db.$queryRaw(Prisma.sql`
    SELECT "id" FROM "restaurant_operator_credentials"
    WHERE "organizationId" = ${scope.organizationId} AND "staffProfileId" = ${input.staffProfileId}
      AND "type" = 'PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE
  `);
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: scope.organizationId,
      staffProfileId: input.staffProfileId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
    },
    include: { staffProfile: { include: { user: { include: { organizationRole: true } } } } },
  });
  const actor = credential?.staffProfile.user;
  const now = new Date();
  if (
    !credential ||
    credential.staffProfile.status !== 'ACTIVE' ||
    !actor ||
    actor.id !== scope.actorId ||
    actor.organizationId !== scope.organizationId ||
    actor.status !== 'ACTIVE' ||
    !['owner', 'owner-operator'].includes(actor.organizationRole?.key ?? '') ||
    !input.reason.trim() ||
    isLockedOut(credential, now) ||
    !(await can(actor, 'pharmacy:dispense', undefined, { db, now }))
  ) return { blocked: true };
  if (!(await verifyOperatorCredential('PIN', input.pin, credential.credentialHash))) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return { blocked: true };
  }
  const [item] = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT item."id" FROM "pharmacy_pharmacist_review_items" item
    JOIN "pharmacy_sale_lines" line ON line."organizationId" = item."organizationId" AND line."id" = item."saleLineId"
    JOIN "pharmacy_chronic_refill_subscriptions" subscription
      ON subscription."organizationId" = line."organizationId" AND subscription."branchId" = line."branchId"
     AND subscription."prescriptionLineId" = item."prescriptionLineId"
     AND subscription."medicineId" = line."medicineId" AND subscription."presentationId" = line."presentationId"
     AND subscription."packLevelId" = line."packLevelId" AND subscription."quantityPacks" = line."quantity"
    WHERE item."organizationId" = ${scope.organizationId} AND line."branchId" = ${scope.branchId}
      AND subscription."id" = ${input.subscriptionId} AND subscription."active" AND subscription."cancelledAt" IS NULL
      AND item."id" = ${input.reviewItemId} AND item."requestedByUserId" = ${scope.actorId}
    FOR UPDATE OF item
  `);
  if (!item) return { blocked: true };
  await db.restaurantOperatorCredential.update({ where: { id: credential.id }, data: clearLockout() });
  await db.$queryRaw(Prisma.sql`
    SELECT set_config('app.chronic_refill_owner_review_item_id', ${item.id}, true)
  `);
  const decision = await db.pharmacyPharmacistReviewDecision.create({
    data: {
      organizationId: scope.organizationId,
      reviewItemId: item.id,
      kind: 'SIGN',
      actorUserId: scope.actorId,
      signedAt: now,
      reason: input.reason.trim(),
    },
  });
  await db.$queryRaw(Prisma.sql`SELECT set_config('app.chronic_refill_owner_review_item_id', '', true)`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "pharmacy_chronic_refill_events"
      ("id", "organizationId", "branchId", "subscriptionId", "kind", "actorUserId", "details")
    VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${input.subscriptionId},
      'OWNER_PIN_APPROVED', ${scope.actorId}, ${JSON.stringify({ decisionId: decision.id,
        reviewItemId: item.id, credentialId: credential.id, reason: input.reason.trim() })}::jsonb)
  `);
  return { decisionId: decision.id };
}
