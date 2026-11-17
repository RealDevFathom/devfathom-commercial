import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { can } from '@/lib/abac';
import type { Subject } from '@/lib/abac/types';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { activateBranchScope, reservationCandidates } from './customer-ordering';
import { planAllocation, PharmacyInventoryError } from './inventory';
import {
  DAY_MS,
  nextCycleDueAt,
  REFILL_SUBSCRIPTION_DEFAULTS,
  REFILL_SUBSCRIPTION_LIMITS,
  refillCycleCampaignKey,
} from './refill-subscription-rules';

import { assertRxSaleAllowed } from './rx-sale-gate';
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
 * AWAITING_PHARMACIST until a pharmacist approves THAT cycle with a fresh PIN;
 * only then can the counter start its checkout. Controlled and restricted
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
  ) {
    super(reason);
    this.name = 'RefillSubscriptionError';
  }
}

export class RefillCycleApprovalDenied extends Error {
  constructor() {
    super('A prescription refill cycle needs a pharmacist to approve it with their PIN.');
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
      status: medicine.rx ? 'AWAITING_PHARMACIST' : 'RESERVED',
      openedByUserId: scope.actorId,
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
  const horizon = new Date(
    now.getTime() + REFILL_SUBSCRIPTION_LIMITS.reminderLeadDays.max * DAY_MS
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
    .filter(
      (subscription) =>
        subscription.nextDueAt.getTime() - subscription.reminderLeadDays * DAY_MS <= now.getTime()
    )
    .map((subscription) => subscription.id);
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
  if (!(await verifyOperatorCredential('PIN', input.pin, credential.credentialHash))) {
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
 * hold `pharmacy:dispense` and the PIN credential that proved it must be live.
 */
export async function approveRefillCycle(
  db: ScopedDb,
  scope: LedgerScope,
  cycleId: string,
  approval: RefillCycleApproval
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
  if (!awaiting && !reclassified) throw new RefillSubscriptionError('INVALID_STATE');
  const approver = (await db.user.findFirst({
    where: {
      id: approval.approvedByUserId,
      organizationId: scope.organizationId,
      status: 'ACTIVE',
    },
  })) as ActiveUser | null;
  if (!approver || !(await can(approver, REFILL_CYCLE_APPROVAL_CAPABILITY, undefined, { db }))) {
    throw new RefillCycleApprovalDenied();
  }
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
  if (cycle.status === 'AWAITING_PHARMACIST') {
    throw new RefillSubscriptionError('PHARMACIST_APPROVAL_REQUIRED');
  }
  if (cycle.status !== 'RESERVED') throw new RefillSubscriptionError('INVALID_STATE');
  const { subscription } = cycle;
  const medicine = await subscribableMedicine(db, scope.organizationId, subscription);
  // Both the flag snapshotted at opening and the medicine's current schedule count:
  // a medicine reclassified as prescription-only since still needs its pharmacist.
  const prescriptionOnly = cycle.requiresPharmacist || medicine.rx;
  if (prescriptionOnly && (!cycle.approvedByUserId || !cycle.approvedAt)) {
    throw new RefillSubscriptionError('PHARMACIST_APPROVAL_REQUIRED');
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
  // DEV-631: no counter bill is opened while today's business day is closed.
  await requirePharmacyTodayOpenForTrading(db, scope);
  await settleCycleReservations(db, scope, cycle.id, 'CONSUMED');
  const sale = await createSale(db, scope);
  await db.pharmacySale.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: sale.id } },
    data: { customerId: subscription.customerId },
  });
  await addReservedSaleLine(
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
