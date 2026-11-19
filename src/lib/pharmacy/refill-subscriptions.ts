import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { can } from '@/lib/abac';
import type { Subject } from '@/lib/abac/types';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
} from '@/lib/restaurant/operator-credentials';
import { verifyApprovalSecret } from '@/lib/approval-authenticator';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

import { activateBranchScope, reservationCandidates } from './customer-ordering';
import { planAllocation, PharmacyInventoryError } from './inventory';
import { prescriptionIsCurrent } from './prescription-calendar';
import {
  DAY_MS,
  nextCycleDueAt,
  REFILL_SUBSCRIPTION_DEFAULTS,
  REFILL_SUBSCRIPTION_LIMITS,
  refillCycleCampaignKey,
  refillCycleOpensBy,
} from './refill-subscription-rules';

import { attachPrescriptionReference } from './rx-prescription-reference';
import { rxReviewSignerDenial, rxReviewSignerRowDenial } from './rx-review-self-sign';
import { assertRxSaleAllowed } from './rx-sale-gate';
import {
  isPharmacistCheckOffMarker,
  pharmacistCheckAtSaleEnabled,
  pharmacistCheckOffMarker,
} from './pharmacist-check-policy';
import { requirePharmacyTodayOpenForTrading } from './settlement';
import { addReservedSaleLine, createSale } from './sales';
import type { LedgerScope } from './stock-ledger';

export {
  isRefillCycleCampaignKey,
  nextCycleDueAt,
  REFILL_SUBSCRIPTION_DEFAULTS,
  REFILL_SUBSCRIPTION_LIMITS,
  refillCycleCampaignKey,
  refillSubscriptionReminder,
  refillSubscriptionReminderDue,
} from './refill-subscription-rules';

/**
 * DEV-73 — chronic refill program and monthly pack subscription.
 *
 * A subscription is one pack of one medicine for one retail customer, repeated
 * every `cycleDays`. Opening a cycle is the "due order": it holds the stock with
 * DEM-03 restock reservations (so every availability query already excludes it)
 * and advances the next due date. A prescription-only cycle stays
 * AWAITING_PHARMACIST until a valid prescription covers THAT cycle and a
 * pharmacist approves it with a fresh PIN; only then can the counter start its
 * checkout. There is no emergency exception. Controlled and restricted
 * medicines are never subscribable: their registers need a per-sale decision.
 */

export const REFILL_CYCLE_APPROVAL_CAPABILITY = 'pharmacy:dispense' as const;
export const REFILL_CYCLE_APPROVAL_POLICY = 'PHARMACIST_PIN_REAUTH';

const OPEN_CYCLE_STATUSES = ['AWAITING_PHARMACIST', 'RESERVED'] as const;

export class RefillSubscriptionError extends Error {
  constructor(
    readonly reason:
      | 'CUSTOMER_NOT_FOUND'
      | 'ITEM_NOT_SUBSCRIBABLE'
      | 'INVALID_SCHEDULE'
      | 'KHATA_NOT_AVAILABLE'
      | 'SUBSCRIPTION_NOT_FOUND'
      | 'CYCLE_NOT_FOUND'
      | 'CYCLE_ALREADY_OPEN'
      | 'INSUFFICIENT_STOCK'
      | 'INVALID_STATE'
      | 'PHARMACIST_APPROVAL_REQUIRED'
      | 'PRESCRIPTION_REQUIRED'
      | 'PRESCRIPTION_NOT_FOUND'
      | 'PRESCRIPTION_PATIENT_MISMATCH'
      | 'PRESCRIPTION_NOT_IN_DATE'
      | 'PRESCRIPTION_EXHAUSTED'
  ) {
    super(reason);
    this.name = 'RefillSubscriptionError';
  }
}

const REFILL_CYCLE_APPROVAL_MESSAGES = {
  PIN: 'A prescription refill cycle needs a pharmacist to approve it with their PIN.',
  BRANCH:
    'This pharmacist is not assigned to this branch. Only a pharmacist assigned to this branch can approve its refills.',
} as const;

export class RefillCycleApprovalDenied extends Error {
  constructor(readonly reason: keyof typeof REFILL_CYCLE_APPROVAL_MESSAGES = 'PIN') {
    super(REFILL_CYCLE_APPROVAL_MESSAGES[reason]);
    this.name = 'RefillCycleApprovalDenied';
  }
}

export function isSubscribableMedicine(medicine: {
  saleable: boolean;
  restricted: boolean;
  controlled: boolean;
}) {
  return medicine.saleable && !medicine.restricted && !medicine.controlled;
}

function inRange(value: number, range: { min: number; max: number }) {
  return Number.isSafeInteger(value) && value >= range.min && value <= range.max;
}

export type CreateRefillSubscriptionInput = {
  customerId: string;
  medicineId: string;
  presentationId: string;
  packLevelId: string;
  packsPerCycle: number;
  cycleDays?: number;
  reminderLeadDays?: number;
  fulfillment: 'COLLECT' | 'DELIVER';
  paymentMode: 'PREPAY' | 'KHATA';
  firstDueAt: Date;
};

async function subscribableMedicine(
  db: ScopedDb,
  organizationId: string,
  input: { medicineId: string; presentationId: string; packLevelId: string }
) {
  const medicine = await db.medicine.findFirst({
    where: { id: input.medicineId, organizationId },
    include: {
      presentations: {
        where: { id: input.presentationId },
        include: { packLevels: { where: { id: input.packLevelId } } },
      },
    },
  });
  if (
    !medicine ||
    !isSubscribableMedicine(medicine) ||
    medicine.presentations[0]?.packLevels.length !== 1
  ) {
    throw new RefillSubscriptionError('ITEM_NOT_SUBSCRIBABLE');
  }
  return medicine;
}

export async function createRefillSubscription(
  db: ScopedDb,
  scope: LedgerScope,
  input: CreateRefillSubscriptionInput
) {
  await activateBranchScope(db, scope);
  const cycleDays = input.cycleDays ?? REFILL_SUBSCRIPTION_DEFAULTS.cycleDays;
  const reminderLeadDays = input.reminderLeadDays ?? REFILL_SUBSCRIPTION_DEFAULTS.reminderLeadDays;
  if (
    !inRange(input.packsPerCycle, REFILL_SUBSCRIPTION_LIMITS.packsPerCycle) ||
    !inRange(cycleDays, REFILL_SUBSCRIPTION_LIMITS.cycleDays) ||
    !inRange(reminderLeadDays, REFILL_SUBSCRIPTION_LIMITS.reminderLeadDays) ||
    reminderLeadDays >= cycleDays ||
    !Number.isFinite(input.firstDueAt.getTime())
  ) {
    throw new RefillSubscriptionError('INVALID_SCHEDULE');
  }
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: input.customerId, organizationId: scope.organizationId, active: true },
    select: { id: true, creditLimitMinor: true },
  });
  if (!customer) throw new RefillSubscriptionError('CUSTOMER_NOT_FOUND');
  // Khata is credit the pharmacy has chosen to extend; no limit means no khata.
  if (input.paymentMode === 'KHATA' && customer.creditLimitMinor <= 0) {
    throw new RefillSubscriptionError('KHATA_NOT_AVAILABLE');
  }
  await subscribableMedicine(db, scope.organizationId, input);
  return db.pharmacyRefillSubscription.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: customer.id,
      medicineId: input.medicineId,
      presentationId: input.presentationId,
      packLevelId: input.packLevelId,
      packsPerCycle: input.packsPerCycle,
      cycleDays,
      reminderLeadDays,
      fulfillment: input.fulfillment,
      paymentMode: input.paymentMode,
      nextDueAt: input.firstDueAt,
      createdByUserId: scope.actorId,
    },
  });
}

async function lockSubscription(db: ScopedDb, scope: LedgerScope, subscriptionId: string) {
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM "pharmacy_refill_subscriptions" WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${subscriptionId} FOR UPDATE`
  );
  const subscription = await db.pharmacyRefillSubscription.findFirst({
    where: { id: subscriptionId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!subscription) throw new RefillSubscriptionError('SUBSCRIPTION_NOT_FOUND');
  return subscription;
}

async function lockCycle(db: ScopedDb, scope: LedgerScope, cycleId: string) {
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM "pharmacy_refill_subscription_cycles" WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${cycleId} FOR UPDATE`
  );
  const cycle = await db.pharmacyRefillSubscriptionCycle.findFirst({
    where: { id: cycleId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { subscription: true },
  });
  if (!cycle) throw new RefillSubscriptionError('CYCLE_NOT_FOUND');
  return cycle;
}

async function reserveCycleStock(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    cycleId: string;
    medicineId: string;
    productName: string;
    candidates: Awaited<ReturnType<typeof reservationCandidates>>;
    requiredUnits: number;
  }
) {
  let plan;
  try {
    plan = planAllocation({
      candidates: input.candidates.map((candidate) => ({
        ...candidate,
        availableUnits: Number(candidate.availableUnits),
      })),
      requiredUnits: input.requiredUnits,
      scope: { organizationId: scope.organizationId, branchId: scope.branchId, at: new Date() },
    });
  } catch (error) {
    if (error instanceof PharmacyInventoryError) {
      throw new RefillSubscriptionError('INSUFFICIENT_STOCK');
    }
    throw error;
  }
  for (const allocation of plan.allocations) {
    const demand = await db.unfulfilledDemandEvent.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        requestedMedicineId: input.medicineId,
        requestedText: input.productName,
        saleUnit: 'PACK',
        quantity: allocation.units,
        reason: 'SERVICE_FAILURE',
        inventoryRuleSnapshot: {
          source: 'REFILL_SUBSCRIPTION_RESERVATION',
          cycleId: input.cycleId,
        },
        capturedByUserId: scope.actorId,
      },
    });
    const interest = await db.pharmacyRestockInterest.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        demandEventId: demand.id,
        reserveOnArrival: false,
        quantityUnits: allocation.units,
        campaignKey: refillCycleCampaignKey(input.cycleId),
        createdByUserId: scope.actorId,
      },
    });
    await db.pharmacyRestockReservation.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        interestId: interest.id,
        inventoryLotId: allocation.inventoryLotId,
        stockLocationId: allocation.stockLocationId,
        reservedUnits: allocation.units,
      },
    });
  }
}

/** Release a cycle's held stock. `status` is CONSUMED when the counter sale takes it. */
async function settleCycleReservations(
  db: ScopedDb,
  scope: LedgerScope,
  cycleId: string,
  status: 'RELEASED' | 'CONSUMED'
) {
  const at = new Date();
  const interests = await db.pharmacyRestockInterest.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      campaignKey: refillCycleCampaignKey(cycleId),
    },
    select: { id: true, demandEventId: true },
  });
  const interestIds = interests.map((interest) => interest.id);
  await db.pharmacyRestockReservation.updateMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      interestId: { in: interestIds },
      status: 'RESERVED',
    },
    data: { status, settledAt: at },
  });
  await db.pharmacyRestockInterest.updateMany({
    where: { organizationId: scope.organizationId, id: { in: interestIds } },
    data: { status: 'OPTED_OUT' },
  });
  await db.unfulfilledDemandEvent.updateMany({
    where: {
      organizationId: scope.organizationId,
      id: { in: interests.map((interest) => interest.demandEventId) },
      status: 'OPEN',
    },
    data: { status: 'CLOSED', closedAt: at },
  });
}

/**
 * Open the subscription's next due cycle: reserve the stock and advance the
 * schedule. Idempotent per due date; refuses while an earlier cycle is open.
 */
export async function openRefillCycle(db: ScopedDb, scope: LedgerScope, subscriptionId: string) {
  await activateBranchScope(db, scope);
  const subscription = await lockSubscription(db, scope, subscriptionId);
  const existing = await db.pharmacyRefillSubscriptionCycle.findFirst({
    where: {
      organizationId: scope.organizationId,
      subscriptionId,
      dueAt: subscription.nextDueAt,
    },
  });
  if (existing) return existing;
  if (subscription.status !== 'ACTIVE') throw new RefillSubscriptionError('INVALID_STATE');
  const open = await db.pharmacyRefillSubscriptionCycle.findFirst({
    where: {
      organizationId: scope.organizationId,
      subscriptionId,
      status: { in: [...OPEN_CYCLE_STATUSES] },
    },
    select: { id: true },
  });
  if (open) throw new RefillSubscriptionError('CYCLE_ALREADY_OPEN');

  const medicine = await subscribableMedicine(db, scope.organizationId, subscription);
  const candidates = await reservationCandidates(
    db,
    scope,
    subscription.medicineId,
    subscription.packLevelId
  );
  const firstLot = candidates.find((candidate) => Number(candidate.availableUnits) > 0);
  const unitsPerPack = Number(firstLot?.unitsPerPack);
  if (!firstLot || !Number.isSafeInteger(unitsPerPack) || unitsPerPack <= 0) {
    throw new RefillSubscriptionError('INSUFFICIENT_STOCK');
  }
  const canonicalUnits = unitsPerPack * subscription.packsPerCycle;
  if (!Number.isSafeInteger(canonicalUnits)) {
    throw new RefillSubscriptionError('ITEM_NOT_SUBSCRIBABLE');
  }
  // DEV-911: while the owner has the pharmacist check switched off, an Rx cycle is not held
  // for a pharmacist. It opens ready, its approval recorded as the owner-switched-off marker
  // (accepted by the database only while the setting is off at that version).
  const checkOff = medicine.rx ? await pharmacistCheckOffMarker(db, scope.organizationId) : null;
  const cycle = await db.pharmacyRefillSubscriptionCycle.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      subscriptionId,
      dueAt: subscription.nextDueAt,
      canonicalUnits,
      // Snapshot of the medicine's schedule now: an Rx item needs a pharmacist
      // every cycle, even if the catalogue flag changes before checkout.
      requiresPharmacist: medicine.rx,
      status: medicine.rx && !checkOff ? 'AWAITING_PHARMACIST' : 'RESERVED',
      openedByUserId: scope.actorId,
      ...(checkOff
        ? { approvedByUserId: scope.actorId, approvalPolicy: checkOff, approvedAt: new Date() }
        : {}),
    },
  });
  await reserveCycleStock(db, scope, {
    cycleId: cycle.id,
    medicineId: subscription.medicineId,
    productName: medicine.productName,
    candidates,
    requiredUnits: canonicalUnits,
  });
  await db.pharmacyRefillSubscription.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: subscriptionId } },
    data: { nextDueAt: nextCycleDueAt(subscription.nextDueAt, subscription.cycleDays) },
  });
  return cycle;
}

/**
 * Active subscriptions in the branch whose reminder window has started. The
 * caller opens each one in its own transaction, so one stock-out never undoes
 * the cycles opened for other subscribers.
 */
export async function listDueRefillSubscriptionIds(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  now = new Date()
) {
  await activateBranchScope(db, scope);
  // DEV-943: due on the shop's own calendar day, as the scheduled job decides
  // (`refillCycleOpensBy`), so a cycle opening later today counts: one day past the
  // longest lead time covers every subscription whose opening day is today.
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  const horizon = new Date(
    now.getTime() + (REFILL_SUBSCRIPTION_LIMITS.reminderLeadDays.max + 1) * DAY_MS
  );
  const candidates = await db.pharmacyRefillSubscription.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'ACTIVE',
      nextDueAt: { lte: horizon },
    },
    select: { id: true, nextDueAt: true, reminderLeadDays: true },
    orderBy: [{ nextDueAt: 'asc' }, { id: 'asc' }],
    take: 200,
  });
  return candidates
    .filter((subscription) => refillCycleOpensBy(subscription, organization?.timezone, now))
    .map((subscription) => subscription.id);
}

/**
 * A prescription covers a cycle when its line is for this organization, the
 * subscriber's patient, this medicine and presentation; it is in date both on
 * the cycle's due date and today (the dispense happens now); and its remaining
 * authorized quantity and repeats can still take the whole cycle. The line is
 * locked so a concurrent fill cannot spend the same remainder. The counter sale
 * repeats the quantity check when it records the fill.
 */
async function assertPrescriptionCoversCycle(
  db: ScopedDb,
  scope: LedgerScope,
  cycle: {
    dueAt: Date;
    canonicalUnits: number;
    subscription: { customerId: string; medicineId: string; presentationId: string };
  },
  prescriptionLineId: string | null | undefined,
  now: Date = new Date()
): Promise<{ prescriptionLineId: string; patientId: string }> {
  if (!prescriptionLineId) throw new RefillSubscriptionError('PRESCRIPTION_REQUIRED');
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_prescription_lines WHERE "organizationId"=${scope.organizationId} AND id=${prescriptionLineId} FOR UPDATE`
  );
  const line = await db.prescriptionLine.findFirst({
    where: {
      id: prescriptionLineId,
      organizationId: scope.organizationId,
      medicineId: cycle.subscription.medicineId,
      presentationId: cycle.subscription.presentationId,
    },
    select: {
      id: true,
      authorizedCanonicalUnits: true,
      prescription: {
        select: { patientId: true, validFrom: true, validUntil: true, authorizedRepeats: true },
      },
      fills: { select: { quantityCanonicalUnits: true } },
    },
  });
  if (!line) throw new RefillSubscriptionError('PRESCRIPTION_NOT_FOUND');
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: cycle.subscription.customerId, organizationId: scope.organizationId },
    select: { patientId: true },
  });
  if (!customer || customer.patientId !== line.prescription.patientId) {
    throw new RefillSubscriptionError('PRESCRIPTION_PATIENT_MISMATCH');
  }
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  const timeZone = workspaceTimezone(organization?.timezone);
  const { validFrom, validUntil } = line.prescription;
  if (
    !prescriptionIsCurrent(validFrom, validUntil, cycle.dueAt, timeZone) ||
    !prescriptionIsCurrent(validFrom, validUntil, now, timeZone)
  ) {
    throw new RefillSubscriptionError('PRESCRIPTION_NOT_IN_DATE');
  }
  const filled = line.fills.reduce((sum, fill) => sum + fill.quantityCanonicalUnits, 0);
  if (
    filled + cycle.canonicalUnits > line.authorizedCanonicalUnits ||
    line.fills.length > line.prescription.authorizedRepeats
  ) {
    throw new RefillSubscriptionError('PRESCRIPTION_EXHAUSTED');
  }
  return { prescriptionLineId: line.id, patientId: line.prescription.patientId };
}

export type RefillCyclePin = { staffProfileId: string; pin: string };

export type RefillCycleApproval = {
  approvedByUserId: string;
  credentialId: string;
};

type ActiveUser = Subject & { organizationId: string | null };

/**
 * Verify the pharmacist's PIN in its OWN tenant transaction (run by the caller)
 * so a wrong PIN commits its failed-attempt strike even though the approval
 * itself is refused. Every approval is a fresh PIN re-authentication, including
 * a solo owner-pharmacist approving a cycle they opened themselves; that case
 * is recorded as self-approved in the cycle and the audit log.
 */
export async function verifyRefillCyclePharmacistPin(
  db: ScopedDb,
  scope: LedgerScope,
  input: RefillCyclePin
): Promise<RefillCycleApproval | null> {
  await db.$queryRaw`SELECT id FROM restaurant_operator_credentials WHERE "organizationId"=${scope.organizationId} AND "staffProfileId"=${input.staffProfileId} AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: scope.organizationId,
      staffProfileId: input.staffProfileId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
    },
    include: { staffProfile: { include: { user: true } } },
  });
  const approver = credential?.staffProfile.user as ActiveUser | null | undefined;
  const now = new Date();
  if (
    !credential ||
    credential.staffProfile.status !== 'ACTIVE' ||
    !approver ||
    approver.organizationId !== scope.organizationId ||
    approver.status !== 'ACTIVE' ||
    isLockedOut(credential, now) ||
    !(await can(approver, REFILL_CYCLE_APPROVAL_CAPABILITY, undefined, { db, now }))
  ) {
    return null;
  }
  if (
    !(await verifyApprovalSecret(db, {
      organizationId: scope.organizationId,
      approverUserId: approver.id,
      credentialHash: credential.credentialHash,
      secret: input.pin,
      action: 'pharmacy.refillCycleApproval',
      requestedById: scope.actorId,
      now,
    }))
  ) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return null;
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  return { approvedByUserId: approver.id, credentialId: credential.id };
}

/**
 * Approve an Rx cycle. Inside the business transaction the approver must still
 * hold `pharmacy:dispense`, the PIN credential that proved it must be live, and
 * the named prescription line must cover this cycle.
 */
export async function approveRefillCycle(
  db: ScopedDb,
  scope: LedgerScope,
  cycleId: string,
  approval: RefillCycleApproval,
  prescription: { prescriptionLineId: string }
) {
  await activateBranchScope(db, scope);
  const cycle = await lockCycle(db, scope, cycleId);
  const awaiting = cycle.status === 'AWAITING_PHARMACIST' && cycle.requiresPharmacist;
  // A medicine reclassified as prescription-only after its cycle opened still needs
  // a pharmacist before checkout; let that RESERVED cycle take the same approval.
  const reclassified =
    cycle.status === 'RESERVED' &&
    !cycle.approvedAt &&
    (await subscribableMedicine(db, scope.organizationId, cycle.subscription)).rx;
  // An approved Rx cycle not yet at the counter may take a fresh PIN approval that
  // replaces its prescription, e.g. once another sale used up the one it relied on.
  const replacing = cycle.status === 'RESERVED' && cycle.requiresPharmacist && !!cycle.approvedAt;
  if (!awaiting && !reclassified && !replacing) {
    throw new RefillSubscriptionError('INVALID_STATE');
  }
  // DEV-941 / DEV-962: the PIN must belong to someone who may sign a prescription check at
  // the cycle's branch: an ACTIVE member holding `pharmacy:dispense` with an active
  // assignment to it, or an organisation admin. The shared rule (`rxReviewSignerDenial`),
  // read live inside the approval's transaction, so the two never drift.
  const approverDenial = await rxReviewSignerDenial(db, {
    organizationId: scope.organizationId,
    branchId: cycle.branchId,
    userId: approval.approvedByUserId,
  });
  if (approverDenial === 'BRANCH') throw new RefillCycleApprovalDenied('BRANCH');
  if (approverDenial) throw new RefillCycleApprovalDenied();
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      id: approval.credentialId,
      organizationId: scope.organizationId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
      staffProfile: { status: 'ACTIVE', userId: approval.approvedByUserId },
    },
    select: { id: true },
  });
  if (!credential) throw new RefillCycleApprovalDenied();
  // The owner's launch rule: no prescription covering this cycle, no release.
  const covering = await assertPrescriptionCoversCycle(
    db,
    scope,
    cycle,
    prescription.prescriptionLineId
  );
  const selfApproved = approval.approvedByUserId === cycle.openedByUserId;
  const approvedAt = new Date();
  const updated = await db.pharmacyRefillSubscriptionCycle.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: cycle.id } },
    data: {
      status: 'RESERVED',
      requiresPharmacist: true,
      approvedByUserId: approval.approvedByUserId,
      approvalPolicy: REFILL_CYCLE_APPROVAL_POLICY,
      approvalCredentialId: approval.credentialId,
      selfApproved,
      approvedAt,
      prescriptionLineId: covering.prescriptionLineId,
    },
  });
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      actorType: 'USER',
      source: 'TRPC',
      category: 'PHARMACY_SAFETY',
      operation: 'OTHER',
      action: 'pharmacy.refillCycle.pharmacistApproval',
      targetType: 'PharmacyRefillSubscriptionCycle',
      targetId: cycle.id,
      metadata: {
        approverId: approval.approvedByUserId,
        policy: REFILL_CYCLE_APPROVAL_POLICY,
        pinVerified: true,
        selfApproved,
        prescriptionLineId: covering.prescriptionLineId,
      },
    },
  });
  return updated;
}

/** Skip one cycle: its held stock goes back on the shelf. */
export async function releaseRefillCycle(db: ScopedDb, scope: LedgerScope, cycleId: string) {
  await activateBranchScope(db, scope);
  const cycle = await lockCycle(db, scope, cycleId);
  if (!(OPEN_CYCLE_STATUSES as readonly string[]).includes(cycle.status)) {
    throw new RefillSubscriptionError('INVALID_STATE');
  }
  await settleCycleReservations(db, scope, cycle.id, 'RELEASED');
  return db.pharmacyRefillSubscriptionCycle.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: cycle.id } },
    data: { status: 'RELEASED', releasedAt: new Date() },
  });
}

export async function cancelRefillSubscription(
  db: ScopedDb,
  scope: LedgerScope,
  subscriptionId: string
) {
  await activateBranchScope(db, scope);
  const subscription = await lockSubscription(db, scope, subscriptionId);
  if (subscription.status === 'CANCELLED') return subscription;
  const open = await db.pharmacyRefillSubscriptionCycle.findMany({
    where: {
      organizationId: scope.organizationId,
      subscriptionId,
      status: { in: [...OPEN_CYCLE_STATUSES] },
    },
    select: { id: true },
  });
  for (const cycle of open) await releaseRefillCycle(db, scope, cycle.id);
  return db.pharmacyRefillSubscription.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: subscriptionId } },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });
}

export async function setRefillSubscriptionPaused(
  db: ScopedDb,
  scope: LedgerScope,
  subscriptionId: string,
  paused: boolean
) {
  await activateBranchScope(db, scope);
  const subscription = await lockSubscription(db, scope, subscriptionId);
  if (subscription.status === 'CANCELLED') throw new RefillSubscriptionError('INVALID_STATE');
  return db.pharmacyRefillSubscription.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: subscriptionId } },
    data: { status: paused ? 'PAUSED' : 'ACTIVE' },
  });
}

/**
 * Hand a ready cycle to the counter: the held stock is released into a new
 * open counter sale for the subscriber, where the normal tender (prepaid or
 * khata) completes it. An Rx cycle without its pharmacist approval is refused
 * here and by the database CHECK behind it.
 */
export async function startRefillCycleCheckout(db: ScopedDb, scope: LedgerScope, cycleId: string) {
  await activateBranchScope(db, scope);
  const cycle = await lockCycle(db, scope, cycleId);
  if (cycle.status === 'CHECKOUT_STARTED' && cycle.counterSaleId) {
    return {
      saleId: cycle.counterSaleId,
      replayed: true,
      paymentMode: cycle.subscription.paymentMode,
    };
  }
  // DEV-911: the pharmacist hold gives way only while the owner has the check switched off.
  let checkOff: string | null = null;
  if (cycle.status === 'AWAITING_PHARMACIST') {
    checkOff = await pharmacistCheckOffMarker(db, scope.organizationId);
    if (!checkOff) throw new RefillSubscriptionError('PHARMACIST_APPROVAL_REQUIRED');
  } else if (cycle.status !== 'RESERVED') throw new RefillSubscriptionError('INVALID_STATE');
  // DEV-631: no counter bill is opened, and no hold is consumed into one, while today's
  // business day is closed for trading. Takes the day lock before any stock lock.
  await requirePharmacyTodayOpenForTrading(db, scope);
  const { subscription } = cycle;
  const medicine = await subscribableMedicine(db, scope.organizationId, subscription);
  // Both the flag snapshotted at opening and the medicine's current schedule count:
  // a medicine reclassified as prescription-only since still needs its pharmacist.
  const prescriptionOnly = cycle.requiresPharmacist || medicine.rx;
  // A cycle readied while the check was off is no longer approved once it is back on.
  const approved =
    Boolean(cycle.approvedByUserId && cycle.approvedAt) &&
    !(
      isPharmacistCheckOffMarker(cycle.approvalPolicy) &&
      (await pharmacistCheckAtSaleEnabled(db, scope.organizationId))
    );
  if (prescriptionOnly && !approved) {
    checkOff ??= await pharmacistCheckOffMarker(db, scope.organizationId);
    if (!checkOff) throw new RefillSubscriptionError('PHARMACIST_APPROVAL_REQUIRED');
  }
  if (checkOff) {
    // Recorded on the cycle before checkout, so the database CHECKs behind the pharmacist
    // approval and the prescription still hold, with the owner-switched-off marker as the
    // approval policy (accepted only while the setting is off at that version).
    await db.pharmacyRefillSubscriptionCycle.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: cycle.id } },
      data: {
        status: 'RESERVED',
        requiresPharmacist: true,
        approvedByUserId: scope.actorId,
        approvalPolicy: checkOff,
        approvalCredentialId: null,
        selfApproved: false,
        approvedAt: new Date(),
      },
    });
  }
  // DEV-911: released under the owner's switch, the cycle needs no prescription either.
  const releasedByCheckOff =
    prescriptionOnly && (Boolean(checkOff) || isPharmacistCheckOffMarker(cycle.approvalPolicy));
  // The approved prescription must still cover the cycle at the moment of hand-over.
  let covering: Awaited<ReturnType<typeof assertPrescriptionCoversCycle>> | null = null;
  if (prescriptionOnly && !releasedByCheckOff) {
    try {
      covering = await assertPrescriptionCoversCycle(db, scope, cycle, cycle.prescriptionLineId);
    } catch (error) {
      // With the check switched off, a prescription that no longer covers the cycle does not
      // stop it; with it on, missing or unreadable, the refusal stands.
      if (
        !(error instanceof RefillSubscriptionError) ||
        (await pharmacistCheckAtSaleEnabled(db, scope.organizationId))
      )
        throw error;
    }
  }
  // The counter's own Rx gate (#518): only a dispenser may put an Rx line on a sale.
  await assertRxSaleAllowed(db, scope, [medicine]);
  const unitsPerPack = cycle.canonicalUnits / subscription.packsPerCycle;
  if (!Number.isSafeInteger(unitsPerPack) || unitsPerPack <= 0) {
    throw new RefillSubscriptionError('INVALID_STATE');
  }
  // Hand over exactly the lots this cycle holds, never a fresh FEFO pick.
  const held = await db.pharmacyRestockReservation.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'RESERVED',
      interest: { campaignKey: refillCycleCampaignKey(cycle.id) },
    },
    select: { inventoryLotId: true, stockLocationId: true, reservedUnits: true },
    orderBy: { id: 'asc' },
  });
  if (held.reduce((total, row) => total + row.reservedUnits, 0) !== cycle.canonicalUnits) {
    throw new RefillSubscriptionError('INVALID_STATE');
  }
  await settleCycleReservations(db, scope, cycle.id, 'CONSUMED');
  const sale = await createSale(db, scope);
  await db.pharmacySale.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: sale.id } },
    data: { customerId: subscription.customerId },
  });
  const added = await addReservedSaleLine(
    db,
    scope,
    {
      saleId: sale.id,
      medicineId: subscription.medicineId,
      presentationId: subscription.presentationId,
      packLevelId: subscription.packLevelId,
      saleUnit: 'PACK',
      quantity: subscription.packsPerCycle,
      canonicalUnitsPerSaleUnit: unitsPerPack,
      idempotencyKey: `refill-cycle:${cycle.id}`,
    },
    {
      allocations: held.map((row) => ({
        inventoryLotId: row.inventoryLotId,
        stockLocationId: row.stockLocationId,
        units: row.reservedUnits,
      })),
      // A cycle hold has no clock of its own; the lots are revalidated under lock now.
      expiresAt: new Date(Date.now() + 60_000),
      pharmacistApprovedRx: prescriptionOnly,
    }
  );
  if (covering) {
    // DEV-629: the counter sale carries the cycle's prescription, and payment still
    // waits for the pharmacist's RX-03 SIGN of this exact sale line.
    await attachPrescriptionReference(db, scope, { ...covering, saleLineId: added.line.id });
    await db.pharmacyPharmacistReviewItem.create({
      data: {
        organizationId: scope.organizationId,
        prescriptionLineId: covering.prescriptionLineId,
        saleLineId: added.line.id,
        requestedByUserId: scope.actorId,
      },
    });
  }
  await db.pharmacyRefillSubscriptionCycle.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: cycle.id } },
    data: { status: 'CHECKOUT_STARTED', counterSaleId: sale.id },
  });
  return { saleId: sale.id, replayed: false, paymentMode: subscription.paymentMode };
}

export async function listRefillSubscriptions(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>
) {
  await activateBranchScope(db, scope);
  return db.pharmacyRefillSubscription.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
    include: {
      customer: { select: { id: true, displayName: true, phoneLast4: true } },
      cycles: { orderBy: { dueAt: 'desc' }, take: 3 },
    },
    orderBy: [{ status: 'asc' }, { nextDueAt: 'asc' }, { id: 'asc' }],
    take: 200,
  });
}

/**
 * The refill program screen's list: each subscription with the item it names, for
 * staff eyes only. Messages to the customer never carry these names.
 */
export async function listRefillProgram(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>
) {
  const subscriptions = await listRefillSubscriptions(db, scope);
  const medicineIds = [...new Set(subscriptions.map((row) => row.medicineId))];
  const medicines = medicineIds.length
    ? await db.medicine.findMany({
        where: { organizationId: scope.organizationId, id: { in: medicineIds } },
        select: {
          id: true,
          productName: true,
          rx: true,
          presentations: { select: { id: true, presentation: true } },
        },
      })
    : [];
  const byId = new Map(medicines.map((row) => [row.id, row]));
  return subscriptions.map((subscription) => {
    const medicine = byId.get(subscription.medicineId);
    return {
      ...subscription,
      item: {
        productName: medicine?.productName ?? 'Unknown item',
        presentation:
          medicine?.presentations.find((row) => row.id === subscription.presentationId)
            ?.presentation ?? null,
        prescriptionOnly: medicine?.rx ?? false,
      },
    };
  });
}

/**
 * Items a subscription may name: saleable, never controlled or restricted, with
 * the current pack levels of each presentation. Prescription-only items are
 * listed; every one of their cycles is held for a pharmacist.
 */
export async function listSubscribableItems(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId'>,
  search = ''
) {
  const query = search.trim();
  const medicines = await db.medicine.findMany({
    where: {
      organizationId: scope.organizationId,
      saleable: true,
      restricted: false,
      controlled: false,
      ...(query
        ? {
            OR: [
              { productName: { contains: query, mode: 'insensitive' } },
              { brandName: { contains: query, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      productName: true,
      rx: true,
      presentations: {
        select: {
          id: true,
          presentation: true,
          packLevels: {
            where: { effectiveTo: null },
            select: { id: true, level: true },
            orderBy: { id: 'asc' },
          },
        },
        orderBy: { id: 'asc' },
      },
    },
    orderBy: [{ productName: 'asc' }, { id: 'asc' }],
    take: 50,
  });
  return medicines.flatMap((medicine) =>
    medicine.presentations.flatMap((presentation) =>
      presentation.packLevels.map((pack) => ({
        medicineId: medicine.id,
        productName: medicine.productName,
        prescriptionOnly: medicine.rx,
        presentationId: presentation.id,
        presentation: presentation.presentation,
        packLevelId: pack.id,
        packLabel: pack.level,
      }))
    )
  );
}

/**
 * The subscriber's prescription lines for this cycle's medicine and presentation,
 * for the pharmacist to choose from. Listing one is not approving it: the
 * approval re-checks date, patient, quantity and repeats under lock.
 */
export async function listRefillCyclePrescriptionCandidates(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  cycleId: string
) {
  await activateBranchScope(db, scope);
  const cycle = await db.pharmacyRefillSubscriptionCycle.findFirst({
    where: { id: cycleId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { subscription: true },
  });
  if (!cycle) throw new RefillSubscriptionError('CYCLE_NOT_FOUND');
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: cycle.subscription.customerId, organizationId: scope.organizationId },
    select: { patientId: true },
  });
  if (!customer?.patientId) return [];
  const lines = await db.prescriptionLine.findMany({
    where: {
      organizationId: scope.organizationId,
      medicineId: cycle.subscription.medicineId,
      presentationId: cycle.subscription.presentationId,
      prescription: { patientId: customer.patientId },
    },
    select: {
      id: true,
      authorizedCanonicalUnits: true,
      prescription: {
        select: {
          validFrom: true,
          validUntil: true,
          authorizedRepeats: true,
          prescriber: { select: { name: true } },
        },
      },
      fills: { select: { quantityCanonicalUnits: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 20,
  });
  return lines.map((line) => {
    const filled = line.fills.reduce((sum, fill) => sum + fill.quantityCanonicalUnits, 0);
    return {
      id: line.id,
      prescriberName: line.prescription.prescriber.name,
      validFrom: line.prescription.validFrom,
      validUntil: line.prescription.validUntil,
      remainingUnits: Math.max(0, line.authorizedCanonicalUnits - filled),
      repeatsLeft: Math.max(0, line.prescription.authorizedRepeats + 1 - line.fills.length),
    };
  });
}

/**
 * Staff profiles the screen may offer to sign a prescription cycle: active members
 * with a live staff PIN who hold the dispensing capability and may act at the
 * branch (DEV-941: an active assignment to it, or an organisation admin). When
 * nobody else qualifies (the solo rule), the actor's own profile is offered so a
 * sole owner-pharmacist can self-approve by re-entering their PIN; the approval
 * itself re-checks everything and records the self-approval in the audit.
 */
export async function listRefillCyclePharmacists(db: ScopedDb, scope: LedgerScope) {
  const now = new Date();
  const profiles = await db.restaurantStaffProfile.findMany({
    where: {
      organizationId: scope.organizationId,
      status: 'ACTIVE',
      user: { organizationId: scope.organizationId, status: 'ACTIVE' },
      credentials: { some: { type: 'PIN', revokedAt: null, deviceId: null } },
    },
    select: {
      id: true,
      displayName: true,
      user: {
        select: { id: true, role: true, department: true, status: true, organizationId: true },
      },
    },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
  });
  const eligible: Array<{ id: string; name: string; self: boolean }> = [];
  for (const profile of profiles) {
    const user = profile.user;
    // The approval's own rule (`rxReviewSignerDenial`), on the row already read.
    if (!user || (await rxReviewSignerRowDenial(db, user, scope, now))) continue;
    eligible.push({ id: profile.id, name: profile.displayName, self: user.id === scope.actorId });
  }
  const others = eligible.filter((profile) => !profile.self);
  return others.length ? others : eligible;
}
