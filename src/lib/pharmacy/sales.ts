import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { legacyStripOption, packLevelCanonicalUnits } from './counter-pricing';
import { mrpRoundingIncrementForLot, priceFromLot } from './medicine';
import {
  branchUnknownLossProbability,
  estimateLossMinor,
  lossProbability,
  notifyCapture,
  resolveVisit,
  serverUnitPriceMinor,
} from './lost-sales';
import type { LostSaleOutcome } from './lost-sales';
import {
  apportionDiscount,
  saleAllocationMoney,
  returnedMoney,
  priceReturn,
} from './sale-line-money';
import { hashDeviceSecret } from '@/lib/retail-terminal/device-secret';
import { canonicalJson } from './offline-snapshot-envelope';
import { checkEnvelope } from './offline-snapshot-envelope';
import type { OfflineSnapshotEnvelope } from './offline-snapshot-envelope';
import { checkSafetyLease } from './offline-safety-lease';
import { SNAPSHOT_SIGNING_KEY_ID, verifySnapshotSignature } from './offline-snapshots';
import {
  authorizeControlledRestoration,
  type ControlledRestorationPin,
} from './controlled-restoration-authorization';
import { appendControlledRestorations, lockRegister } from './controlled-register';
import { lockStockBalances, lockStockRowsFrom } from './stock-lock-order';
import { assertStoredPharmacyMayOperate } from './regulatory';
import { isRefillCycleCampaignKey } from './refill-subscription-rules';
import { assertVoucherEligibleLine, VoucherScopeError } from './voucher-scope';
import { assertVoucherIssuerRights, VoucherIssuerRevoked } from './voucher-controls';
import { allocateForSale, allocateReservedForSale, reverseMovements } from './stock-ledger';
import {
  claimSoldPackSerial,
  PharmacySerializedPackError,
  releaseSoldPackSerials,
  resolveSerializedPackForSale,
  SERIALIZED_PACK_APPROVAL_POLICY,
  serializedPackOverrideReason,
  type ResolvedSerializedPack,
} from './serialized-pack-sale';
import type { LedgerScope, ReservedSaleAllocation } from './stock-ledger';
import { postSaleReturnEntry, postUnidentifiedSaleReturnEntry } from './finance-postings';
import { releaseVoidedSaleRedemptions } from './loyalty-void-release';
import {
  backInStockQueue,
  backInStockReference,
  DAY_MS,
  readBackInStockPolicy,
  restockRequestCutoff,
  selectRecoveryLine,
  type BackInStockPolicy,
} from './back-in-stock';
import { priceCounterPromotion, promotionApprovalPolicy } from './promotions';

/**
 * Re-exported from `./medicine`, where MED-08 pricing now lives so the counter
 * can preview a price in the browser without pulling Prisma into the bundle.
 * Existing server callers keep importing it from here.
 */
export { priceFromLot };

export const OFFLINE_REPLAY_MAX_AGE_DAYS = 7;

export type PharmacyLeasedReceipt = {
  leaseId: string;
  receiptNumber: number;
  originalSaleAt: string;
  envelope: OfflineSnapshotEnvelope;
  signature: string;
};

export type PharmacyCommandAuthentication = { deviceSecret: string; signature: string };

/** HMAC-SHA256 over UTF-8 domain + canonical JSON; the 256-bit enrollment
 * secret stays on the device and in the authenticated request, never the log.
 * This authenticates device origin, not independent proof of wall-clock time. */
export function signPharmacyCommand(
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  deviceId: string,
  payload: unknown,
  deviceSecret: string
) {
  return createHmac('sha256', deviceSecret)
    .update('pharmacy-offline-command:v1\n')
    .update(
      canonicalJson({
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId,
        payload,
      })
    )
    .digest('hex');
}

export async function authenticatePharmacyCommand(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  deviceId: string,
  payload: unknown,
  authentication?: PharmacyCommandAuthentication
) {
  if (
    !authentication ||
    !/^pcd_[A-Za-z0-9_-]{43}$/.test(authentication.deviceSecret) ||
    !/^[0-9a-f]{64}$/.test(authentication.signature)
  )
    throw new PharmacySaleError('INVALID_COMMAND_SIGNATURE');
  const rows = await db.$queryRaw<Array<{ deviceSecretHash: string }>>(Prisma.sql`
    SELECT "deviceSecretHash" FROM pharmacy_registered_devices
    WHERE id = ${deviceId} AND "organizationId" = ${scope.organizationId}
      AND "branchId" = ${scope.branchId} AND status = 'ACTIVE' AND "revokedAt" IS NULL
    FOR SHARE`);
  const device = rows[0];
  if (
    !device ||
    device.deviceSecretHash !== hashDeviceSecret(authentication.deviceSecret) ||
    !timingSafeEqual(
      Buffer.from(authentication.signature, 'hex'),
      Buffer.from(signPharmacyCommand(scope, deviceId, payload, authentication.deviceSecret), 'hex')
    )
  )
    throw new PharmacySaleError('INVALID_COMMAND_SIGNATURE');
}

/** The signed server window bounds the original client sale instant. The
 * settlement authenticates this entire payload with the device command MAC
 * before using the timestamp; the snapshot signature authenticates the window. */
export function validateLeasedReceiptReplay(
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  deviceId: string,
  input: PharmacyLeasedReceipt,
  nowMs = Date.now()
) {
  const saleMs = Date.parse(input.originalSaleAt);
  if (!Number.isFinite(saleMs) || saleMs > nowMs)
    throw new PharmacySaleError('INVALID_REPLAY_TIME');
  if (nowMs - saleMs > OFFLINE_REPLAY_MAX_AGE_DAYS * 86_400_000)
    throw new PharmacySaleError('replay_stale');
  if (!input.leaseId || !Number.isSafeInteger(input.receiptNumber) || input.receiptNumber < 1)
    throw new PharmacySaleError('INVALID_RECEIPT_LEASE');
  if (
    input.envelope.signingKeyId !== SNAPSHOT_SIGNING_KEY_ID ||
    !verifySnapshotSignature(input.envelope, input.signature) ||
    !checkEnvelope({
      envelope: input.envelope,
      scope: { ...scope, deviceId },
      nowMs: saleMs,
      heldVersion: null,
      payloadHash: input.envelope.payloadHash,
    }).ok ||
    !checkSafetyLease(
      {
        lease: input.envelope.safetyLease,
        appliedRecallVersion: input.envelope.safetyLease.recallVersion,
        recalledBatchIds: [],
      },
      saleMs
    ).ok
  )
    throw new PharmacySaleError('INVALID_SAFETY_LEASE');
}

export class PharmacySaleError extends Error {
  constructor(
    readonly reason:
      | 'INVALID_COMMAND_SIGNATURE'
      | 'replay_stale'
      | 'INVALID_REPLAY_TIME'
      | 'INVALID_RECEIPT_LEASE'
      | 'INVALID_SAFETY_LEASE'
      | 'NOT_FOUND'
      | 'INVALID_STATE'
      | 'INVALID_QUANTITY'
      | 'INVALID_SALE_UNIT'
      | 'PRICE_ABOVE_MRP'
      | 'MARGIN_GUARDRAIL'
      | 'APPROVAL_REQUIRED'
      | 'REGULATED_DISCOUNT_REFUSED'
      | 'VOUCHER_CATEGORY_REFUSED'
      | 'VOUCHER_INVALID'
      | 'VOUCHER_PIN_REQUIRED'
      | 'RETURN_EXCEEDS_SOLD'
      | 'IDEMPOTENCY_CONFLICT'
      | 'CONSENT_REQUIRED'
      | 'UNSAFE_STOCK'
      | 'CROSS_BRANCH_REFERENCE'
      | 'BILL_HAS_PAYMENTS'
      | 'NOT_BILL_OWNER'
  ) {
    super(reason);
  }
}

export function validateDiscount(input: {
  regulated: boolean;
  discountMinor: number;
  grossMinor: number;
  costMinor: number;
  approvedByUserId?: string;
  approvalPolicy?: string;
}) {
  if (input.discountMinor < 0 || input.discountMinor > input.grossMinor)
    throw new PharmacySaleError('MARGIN_GUARDRAIL');
  if (input.regulated && input.discountMinor > 0)
    throw new PharmacySaleError('REGULATED_DISCOUNT_REFUSED');
  if (input.discountMinor > 0 && (!input.approvedByUserId || !input.approvalPolicy))
    throw new PharmacySaleError('APPROVAL_REQUIRED');
  if (input.grossMinor - input.discountMinor < input.costMinor)
    throw new PharmacySaleError('MARGIN_GUARDRAIL');
}

export function priceMixedLotAllocation(
  allocations: readonly { units: number; unitPriceMinor: number }[],
  quantity: number,
  canonicalUnitsPerSaleUnit: number
) {
  let weightedMinorUnits = 0;
  const allocationGrossMinors = allocations.map((allocation) => {
    const before = Math.floor(weightedMinorUnits / canonicalUnitsPerSaleUnit);
    weightedMinorUnits += allocation.units * allocation.unitPriceMinor;
    return Math.floor(weightedMinorUnits / canonicalUnitsPerSaleUnit) - before;
  });
  const grossMinor = Math.floor(weightedMinorUnits / canonicalUnitsPerSaleUnit);
  if (
    !Number.isSafeInteger(weightedMinorUnits) ||
    !Number.isSafeInteger(grossMinor) ||
    grossMinor < 0 ||
    quantity <= 0
  )
    throw new PharmacySaleError('INVALID_QUANTITY');
  return { grossMinor, unitPriceMinor: Math.floor(grossMinor / quantity), allocationGrossMinors };
}

async function saleInScope(db: ScopedDb, scope: LedgerScope, saleId: string) {
  const sale = await db.pharmacySale.findFirst({
    where: { id: saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { lines: { include: { medicine: true } } },
  });
  if (!sale) throw new PharmacySaleError('CROSS_BRANCH_REFERENCE');
  return sale;
}

async function event(
  db: ScopedDb,
  scope: LedgerScope,
  saleId: string,
  kind: Parameters<typeof db.pharmacySaleEvent.create>[0]['data']['kind'],
  reason?: string,
  payload?: Prisma.InputJsonValue
) {
  return db.pharmacySaleEvent.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId,
      kind,
      actorId: scope.actorId,
      reason,
      payload,
    },
  });
}

export async function createSale(
  db: ScopedDb,
  scope: LedgerScope,
  quotation = false,
  /** A caller-specific precondition, checked after the shared gate and before the insert. */
  beforeCreate?: () => Promise<void>
) {
  // Every creation path (counter, offline replay, customer orders) shares this gate.
  await assertStoredPharmacyMayOperate(db, scope.organizationId, scope.branchId, {
    name: 'pharmacy.sale.create',
  });
  await beforeCreate?.();
  const sale = await db.pharmacySale.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      createdByUserId: scope.actorId,
      status: quotation ? 'QUOTATION' : 'OPEN',
    },
  });
  await event(db, scope, sale.id, quotation ? 'QUOTATION_CREATED' : 'CREATED');
  return sale;
}

type AddSaleLineInput = {
  saleId: string;
  medicineId: string;
  presentationId: string;
  packLevelId: string;
  saleUnit: 'PACK' | 'STRIP' | 'UNIT';
  quantity: number;
  canonicalUnitsPerSaleUnit: number;
  discountKind?: 'DISCOUNT' | 'PROMOTION' | 'COMPLIMENTARY';
  discountMinor?: number;
  /** DEV-27: a stored voucher to redeem; it sets the discount and its approval. */
  voucherId?: string;
  /**
   * DEV-819: set only by the counter after the redeeming cashier re-entered their own PIN.
   * A voucher line without it is refused.
   */
  voucherCashierPinVerified?: true;
  approvedByUserId?: string;
  approvalPolicy?: string;
  override?: { inventoryLotId: string; reason: string; approvalPolicy: string };
  /**
   * DEV-92: the GS1 DataMatrix scanned off the one serialized pack this line sells.
   * DEV-843: `fefoApprovalPolicy` is set only by the server from a verified manager or owner
   * PIN; without it a pack whose lot is not the earliest-expiry one is refused.
   */
  scannedPack?: { payload: string; fefoApprovalPolicy?: string };
  idempotencyKey: string;
};

/** Take the organization-wide request lock before any prescription, register or stock lock.
 * Multi-line offline commands hold all their line keys before preparing stock. */
export async function lockSaleLineKey(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId'>,
  idempotencyKey: string
) {
  await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(
    hashtextextended(${scope.organizationId + ':sale-line:' + idempotencyKey}, 0))`;
}

/** Read committed line evidence without dispensing or consuming a voucher again. */
export async function replaySaleLine(db: ScopedDb, scope: LedgerScope, input: AddSaleLineInput) {
  await lockSaleLineKey(db, scope, input.idempotencyKey);
  const previous = await db.pharmacySaleLine.findFirst({
    where: {
      organizationId: scope.organizationId,
      idempotencyKey: input.idempotencyKey,
    },
    include: { allocations: { orderBy: { stockMovementId: 'asc' } } },
  });
  if (!previous) return null;
  // Saved lines are never re-priced, so an omitted manual discount means none. Only a
  // voucher or automatic promotion priced the line itself, and either needs no manual discount.
  const manualDiscountRequested = Boolean(input.discountKind || input.discountMinor);
  const discountChanged = previous.voucherId
    ? false
    : previous.promotionId
      ? manualDiscountRequested
      : previous.discountKind !== (input.discountKind ?? null) ||
        previous.discountMinor !== (input.discountMinor ?? 0);
  // Never return another branch's line or let a key silently change its target or quantity.
  if (
    previous.branchId !== scope.branchId ||
    previous.saleId !== input.saleId ||
    previous.medicineId !== input.medicineId ||
    previous.presentationId !== input.presentationId ||
    previous.packLevelId !== input.packLevelId ||
    previous.saleUnit !== input.saleUnit ||
    previous.quantity !== input.quantity ||
    previous.canonicalUnitsPerSaleUnit !== input.canonicalUnitsPerSaleUnit ||
    previous.voucherId !== (input.voucherId ?? null) ||
    discountChanged
  )
    throw new PharmacySaleError('IDEMPOTENCY_CONFLICT');
  const { allocations, ...line } = previous;
  return {
    line,
    allocation: {
      allocations: allocations.map((part) => ({
        inventoryLotId: part.inventoryLotId,
        stockLocationId: part.stockLocationId,
        units: part.canonicalUnits,
      })),
      movementIds: allocations.map((part) => part.stockMovementId),
      recommendedLotId: null,
      blocked: [],
      overrideId: null,
      discrepancyId: null,
    },
    replayed: true,
  };
}

/**
 * DEV-830 (F05): the canonical units in one sale unit come from the stored medicine,
 * presentation and pack hierarchy, never from the request. The pack level must belong
 * to the line's presentation and that presentation to its medicine. A loose UNIT is one
 * canonical unit. A PACK or STRIP holds exactly what its stored level holds, or what a
 * lot of this medicine at this branch was received as at that level (the counter's
 * DEV-717 fallback). Anything else is refused before quota, stock or price is touched.
 */
export async function assertSaleUnitConversion(
  db: ScopedDb,
  scope: LedgerScope,
  input: Pick<
    AddSaleLineInput,
    'medicineId' | 'presentationId' | 'packLevelId' | 'saleUnit' | 'canonicalUnitsPerSaleUnit'
  >,
  at = new Date()
): Promise<void> {
  const packLevels = await db.packLevel.findMany({
    where: {
      organizationId: scope.organizationId,
      presentationId: input.presentationId,
      presentation: { organizationId: scope.organizationId, medicineId: input.medicineId },
    },
    select: {
      id: true,
      level: true,
      parentPackLevelId: true,
      unitsPerParent: true,
      effectiveFrom: true,
      effectiveTo: true,
      versionGroupId: true,
      presentation: { select: { presentation: true, dosageForm: true } },
    },
  });
  if (!packLevels.some((level) => level.id === input.packLevelId))
    throw new PharmacySaleError('INVALID_SALE_UNIT');
  if (input.saleUnit === 'UNIT') {
    if (input.canonicalUnitsPerSaleUnit !== 1) throw new PharmacySaleError('INVALID_SALE_UNIT');
    return;
  }
  if (
    packLevelCanonicalUnits({ packLevels, packLevelId: input.packLevelId, at }).includes(
      input.canonicalUnitsPerSaleUnit
    )
  )
    return;
  // Legacy strips are accepted only at the multiplier derived from this tenant's
  // stored, reviewed box wording. PACK and UNIT retain their existing checks.
  const pack = packLevels.find((level) => level.id === input.packLevelId)!;
  if (
    input.saleUnit === 'STRIP' &&
    legacyStripOption({
      packLevels,
      packLevelId: input.packLevelId,
      presentation: pack.presentation?.presentation,
      dosageForm: pack.presentation?.dosageForm ?? null,
    })?.canonicalUnitsPerSaleUnit === input.canonicalUnitsPerSaleUnit
  )
    return;
  const received = await db.pharmacyInventoryLot.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      packLevelId: input.packLevelId,
      unitsPerPack: input.canonicalUnitsPerSaleUnit,
      batch: { medicineId: input.medicineId },
    },
    select: { id: true },
  });
  if (!received) throw new PharmacySaleError('INVALID_SALE_UNIT');
}

/**
 * `applyCounterPromotions` (#727) is set only by the online counter. Offline replay and
 * reserved customer orders keep the price they quoted, so they never opt in.
 */
export async function addSaleLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: AddSaleLineInput,
  options: {
    applyCounterPromotions?: boolean;
    /** DEV-830: offline replay checks the sale unit against the setup at the signed sale time. */
    saleUnitAt?: Date;
  } = {}
) {
  return addSaleLineWithAllocation(
    db,
    scope,
    input,
    undefined,
    options.applyCounterPromotions,
    options.saleUnitAt
  );
}

/** Internal customer-order path; never accepted by the counter's public input schema.
 * Caller holds order/reservation/stock locks and releases the validated reservations
 * in this same transaction. No override approval is fabricated for reserved stock.
 */
export async function addReservedSaleLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: Omit<AddSaleLineInput, 'override' | 'scannedPack'>,
  reservation: ReservedSaleAllocation
) {
  return addSaleLineWithAllocation(db, scope, input, reservation);
}

/**
 * DEV-27: loads the stored voucher for a line and enforces its allowlist. The
 * caller cannot set the amount, kind or approver of a voucher discount.
 *
 * DEV-819: the cashier must have re-entered their PIN; the voucher must be live (not
 * revoked, not expired, uses left); the issuer must still hold owner rights and the recorded
 * approval must still stand. One use is taken here, inside the sale transaction, with a
 * compare-and-set on the use count so concurrent redemptions cannot exceed the limit.
 */
async function voucherForRedemption(
  db: ScopedDb,
  scope: LedgerScope,
  input: AddSaleLineInput,
  medicine: {
    rx: boolean;
    otc: boolean;
    restricted: boolean;
    controlled: boolean;
    productFamily: string;
  }
) {
  if (
    input.discountKind !== undefined ||
    input.discountMinor !== undefined ||
    input.approvedByUserId !== undefined ||
    input.approvalPolicy !== undefined
  )
    throw new PharmacySaleError('VOUCHER_INVALID');
  if (input.voucherCashierPinVerified !== true) throw new PharmacySaleError('VOUCHER_PIN_REQUIRED');
  const now = new Date();
  const voucher = await db.pharmacyVoucher.findFirst({
    where: {
      id: input.voucherId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      active: true,
      revokedAt: null,
      validUntil: { gt: now },
    },
    select: {
      id: true,
      discountMinor: true,
      eligibleCategories: true,
      issuedByUserId: true,
      approvedByUserId: true,
      approvalPolicy: true,
      validUntil: true,
      maxUses: true,
      usedCount: true,
      revokedAt: true,
    },
  });
  if (
    !voucher ||
    voucher.revokedAt !== null ||
    !voucher.validUntil ||
    voucher.validUntil.getTime() <= now.getTime() ||
    voucher.usedCount >= voucher.maxUses
  )
    throw new PharmacySaleError('VOUCHER_INVALID');
  try {
    assertVoucherEligibleLine(medicine, voucher.eligibleCategories);
  } catch (error) {
    if (error instanceof VoucherScopeError) throw new PharmacySaleError('VOUCHER_CATEGORY_REFUSED');
    throw error;
  }
  let approverUserId: string;
  try {
    approverUserId = await assertVoucherIssuerRights(
      db,
      scope.organizationId,
      scope.branchId,
      voucher
    );
  } catch (error) {
    if (error instanceof VoucherIssuerRevoked) throw new PharmacySaleError('VOUCHER_INVALID');
    throw error;
  }
  const taken = await db.pharmacyVoucher.updateMany({
    where: {
      id: voucher.id,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      active: true,
      revokedAt: null,
      usedCount: voucher.usedCount,
    },
    data: { usedCount: { increment: 1 } },
  });
  if (taken.count !== 1) throw new PharmacySaleError('VOUCHER_INVALID');
  return { ...voucher, approverUserId };
}

async function addSaleLineWithAllocation(
  db: ScopedDb,
  scope: LedgerScope,
  input: AddSaleLineInput,
  reservation?: ReservedSaleAllocation,
  applyCounterPromotions = false,
  saleUnitAt?: Date
) {
  // #414: a sale opened while the licence was valid must not keep dispensing after it
  // lapses. Every line path (counter, controlled, offline replay, customer orders)
  // re-checks the persisted gate at dispense time, before any stock is allocated.
  await assertStoredPharmacyMayOperate(db, scope.organizationId, scope.branchId, {
    name: 'pharmacy.sale.dispense',
  });
  const replay = !reservation ? await replaySaleLine(db, scope, input) : null;
  if (replay) return replay;
  const sale = await saleInScope(db, scope, input.saleId);
  if (sale.status !== 'OPEN') throw new PharmacySaleError('INVALID_STATE');
  // Lock the sale row before allocating stock. At PostgreSQL READ COMMITTED,
  // this conditional update makes an add-line transaction serialize with a
  // concurrent void: whichever loses the row lock observes the new status and
  // rolls back before it can leave an allocation on a void sale.
  const locked = await db.pharmacySale.updateMany({
    where: {
      id: input.saleId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
    data: { status: 'OPEN' },
  });
  if (locked.count !== 1) throw new PharmacySaleError('INVALID_STATE');
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity <= 0 ||
    !Number.isSafeInteger(input.canonicalUnitsPerSaleUnit) ||
    input.canonicalUnitsPerSaleUnit <= 0
  )
    throw new PharmacySaleError('INVALID_QUANTITY');
  const canonicalUnits = input.quantity * input.canonicalUnitsPerSaleUnit;
  if (!Number.isSafeInteger(canonicalUnits)) throw new PharmacySaleError('INVALID_QUANTITY');

  const medicine = await db.medicine.findFirst({
    where: { id: input.medicineId, organizationId: scope.organizationId, saleable: true },
  });
  if (!medicine) throw new PharmacySaleError('NOT_FOUND');
  // DEV-86: an Rx, restricted or controlled line is dispensed only inside the rule set's
  // pharmacist-presence hours, on every line path, before any stock is allocated.
  if (medicine.rx || medicine.restricted || medicine.controlled)
    await assertStoredPharmacyMayOperate(db, scope.organizationId, scope.branchId, {
      name: 'pharmacy.sale.dispense_regulated',
      requiresQualifiedPerson: true,
      requiresPharmacistPresence: true,
    });
  // DEV-830 (F05): reserved customer-order and refill lines carry a multiplier the server
  // derived from the stored lot when it reserved them; every other line is checked here.
  if (!reservation) await assertSaleUnitConversion(db, scope, input, saleUnitAt);
  // DEV-92: a scanned serial names exactly one sealed pack of one lot.
  let pack: ResolvedSerializedPack | null = null;
  let override = input.override;
  if (input.scannedPack) {
    if (reservation || input.saleUnit !== 'PACK' || input.quantity !== 1)
      throw new PharmacySaleError('INVALID_QUANTITY');
    pack = await resolveSerializedPackForSale(db, scope, {
      medicineId: input.medicineId,
      payload: input.scannedPack.payload,
    });
    if (override && override.inventoryLotId !== pack.inventoryLotId)
      throw new PharmacySerializedPackError('SERIAL_LOT_UNAVAILABLE');
    // The pack's own evidence is always what is recorded: its serial, and the manager or owner
    // approval that let it leave FEFO order. A batch override's approval does not stand in.
    const packApproval = input.scannedPack.fefoApprovalPolicy;
    override = {
      inventoryLotId: pack.inventoryLotId,
      reason: serializedPackOverrideReason(pack.serialNumber),
      approvalPolicy: packApproval
        ? `${SERIALIZED_PACK_APPROVAL_POLICY}:${packApproval}`
        : SERIALIZED_PACK_APPROVAL_POLICY,
    };
  }
  // DEV-27: a voucher is a stored record. Its eligible-category allowlist is
  // enforced here, before any stock is allocated, so a voucher never applies to
  // an Rx, OTC drug, supplement or medical-device line.
  const voucher = input.voucherId ? await voucherForRedemption(db, scope, input, medicine) : null;
  const allocationInput = {
    medicineId: input.medicineId,
    requiredUnits: canonicalUnits,
    at: new Date(),
    idempotencyKeyPrefix: `sale:${input.idempotencyKey}`,
    override,
  };
  const allocation = reservation
    ? await allocateReservedForSale(db, scope, allocationInput, input.packLevelId, reservation)
    : await allocateForSale(db, scope, allocationInput);
  const lots = await db.pharmacyInventoryLot.findMany({
    where: {
      id: { in: allocation.allocations.map((a) => a.inventoryLotId) },
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    include: { batch: { select: { batchNumber: true } } },
  });
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  if (pack) {
    // The whole line must come out of the scanned pack's own lot, as one sealed pack.
    const pinned = pack.inventoryLotId;
    if (
      allocation.allocations.some(
        (part) =>
          part.inventoryLotId !== pinned ||
          lotById.get(part.inventoryLotId)?.unitsPerPack !== input.canonicalUnitsPerSaleUnit
      )
    )
      throw new PharmacySerializedPackError('SERIAL_LOT_UNAVAILABLE');
    // DEV-843: a scanned pack is not an approval. When its lot is not FEFO's choice the
    // allocation records an override, and that needs a verified manager or owner PIN.
    // The sale transaction rolls back everything allocated above.
    if (allocation.overrideId && !input.scannedPack?.fefoApprovalPolicy)
      throw new PharmacySerializedPackError('SERIAL_FEFO_APPROVAL_REQUIRED');
  }
  // MED-08: price each lot with the rounding increment of its own
  // (pack level, batch) MRP rule, exactly as the counter quoted it.
  const mrpRules = lots.length
    ? await db.medicinePackMrp.findMany({
        where: {
          organizationId: scope.organizationId,
          OR: lots.map((lot) => ({
            packLevelId: lot.packLevelId,
            batchReference: lot.batch.batchNumber,
          })),
        },
        select: { packLevelId: true, batchReference: true, roundingIncrementMinor: true },
      })
    : [];
  let ceiling = 0,
    costMinor = 0;
  const pricedAllocations: { units: number; unitPriceMinor: number }[] = [];
  for (const part of allocation.allocations) {
    const lot = lotById.get(part.inventoryLotId);
    if (!lot) throw new PharmacySaleError('NOT_FOUND');
    const price = priceFromLot({
      printedMrpMinor: lot.printedMrpMinor,
      canonicalUnitsInPack: lot.unitsPerPack,
      canonicalUnitsPerSaleUnit: input.canonicalUnitsPerSaleUnit,
      roundingIncrementMinor: mrpRoundingIncrementForLot(mrpRules, {
        packLevelId: lot.packLevelId,
        batchNumber: lot.batch.batchNumber,
      }),
    });
    pricedAllocations.push({ units: part.units, unitPriceMinor: price.unitPriceMinor });
    ceiling = Math.max(ceiling, price.proRataCeilingMinor);
    costMinor += lot.unitCostMinor * part.units;
  }
  const { grossMinor, unitPriceMinor, allocationGrossMinors } = priceMixedLotAllocation(
    pricedAllocations,
    input.quantity,
    input.canonicalUnitsPerSaleUnit
  );
  const regulated = medicine.rx || medicine.restricted || medicine.controlled;
  // #727: priced after allocation has finished waiting for its stock locks. A voucher,
  // manual discount or complimentary line is never combined with an automatic promotion.
  const promotionEvaluatedAt = new Date();
  const promotion =
    applyCounterPromotions && !voucher && !input.discountKind && !input.discountMinor
      ? await priceCounterPromotion(db, scope, {
          medicineId: input.medicineId,
          regulated,
          grossMinor,
          costMinor,
          at: promotionEvaluatedAt,
        })
      : null;
  const discountMinor = voucher
    ? Math.min(voucher.discountMinor, grossMinor)
    : (promotion?.discountMinor ?? input.discountMinor ?? 0);
  const discountKind = voucher
    ? ('VOUCHER' as const)
    : promotion
      ? ('PROMOTION' as const)
      : input.discountKind;
  const approvedByUserId = voucher
    ? voucher.approverUserId
    : (promotion?.promotion.createdByUserId ?? input.approvedByUserId);
  const approvalPolicy = voucher
    ? `voucher:${voucher.id}`
    : promotion
      ? promotionApprovalPolicy(promotion.promotion.id)
      : input.approvalPolicy;
  validateDiscount({
    regulated,
    discountMinor,
    grossMinor,
    costMinor,
    approvedByUserId,
    approvalPolicy,
  });
  const line = await db.pharmacySaleLine.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: input.saleId,
      medicineId: input.medicineId,
      presentationId: input.presentationId,
      packLevelId: input.packLevelId,
      saleUnit: input.saleUnit,
      quantity: input.quantity,
      canonicalUnitsPerSaleUnit: input.canonicalUnitsPerSaleUnit,
      canonicalUnits,
      unitPriceMinor,
      grossMinor,
      proRataCeilingMinor: ceiling,
      unitCostMinor: Math.ceil(costMinor / input.quantity),
      discountKind,
      discountMinor,
      voucherId: voucher?.id ?? null,
      approvalPolicy,
      approvedByUserId,
      promotionId: promotion?.promotion.id,
      promotionName: promotion?.promotion.name,
      idempotencyKey: input.idempotencyKey,
    },
  });
  const allocationDiscountMinors = apportionDiscount(discountMinor, allocationGrossMinors);
  await Promise.all(
    allocation.allocations.map((part, index) =>
      db.pharmacySaleLineAllocation.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          saleLineId: line.id,
          inventoryLotId: part.inventoryLotId,
          stockLocationId: part.stockLocationId,
          canonicalUnits: part.units,
          grossMinor: allocationGrossMinors[index]!,
          discountMinor: allocationDiscountMinors[index]!,
          stockMovementId: allocation.movementIds[index]!,
        },
      })
    )
  );
  if (pack) {
    await claimSoldPackSerial(db, scope, pack, {
      saleId: input.saleId,
      saleLineId: line.id,
      inventoryLotId: pack.inventoryLotId,
    });
  }
  await event(db, scope, sale.id, 'LINE_ADDED', undefined, {
    saleLineId: line.id,
    ...(promotion
      ? {
          promotionId: promotion.promotion.id,
          promotionName: promotion.promotion.name,
          discountMinor,
          approvedByUserId: promotion.promotion.createdByUserId,
          effectiveFrom: promotion.promotion.effectiveFrom.toISOString(),
          effectiveTo: promotion.promotion.effectiveTo.toISOString(),
          benefitBasisPoints: promotion.promotion.benefitBasisPoints,
          benefitMinor: promotion.promotion.benefitMinor,
          evaluatedAt: promotionEvaluatedAt.toISOString(),
        }
      : {}),
  });
  return { line, allocation, replayed: false };
}

/**
 * DEV-821: who is changing a bill's status, decided by the caller. Required on every
 * call, so no caller can void without stating it. A counter user may void only a
 * bill they created unless they are a manager or owner. A failed delivery that the
 * delivery path has already authorized voids its own order sale.
 */
export type SaleTransitionAuthority =
  { kind: 'COUNTER'; actorIsManager: boolean } | { kind: 'FAILED_DELIVERY_RETURN' };

function mayVoidSale(
  authority: SaleTransitionAuthority | undefined,
  sale: { createdByUserId: string },
  scope: LedgerScope
) {
  if (authority?.kind === 'FAILED_DELIVERY_RETURN') return true;
  if (authority?.kind !== 'COUNTER') return false;
  return authority.actorIsManager || sale.createdByUserId === scope.actorId;
}

export async function changeSaleStatus(
  db: ScopedDb,
  scope: LedgerScope,
  saleId: string,
  action: 'hold' | 'resume' | 'convertQuotation' | 'void',
  authority: SaleTransitionAuthority,
  reason?: string,
  controlledWitness?: ControlledRestorationPin,
  /** DEV-508: structured detail kept on the status event, e.g. a void's reason code. */
  eventPayload?: Prisma.InputJsonValue
) {
  const sale = await saleInScope(db, scope, saleId);
  // DEV-821: fails closed. A void releases the bill's stock, so a missing or
  // insufficient authority is refused before the bill is claimed.
  if (action === 'void' && !mayVoidSale(authority, sale, scope))
    throw new PharmacySaleError('NOT_BILL_OWNER');
  // DEV-623: a HELD bill can be voided directly. Resuming needs a licence valid
  // now, so a held bill must not need resuming to release the stock it holds.
  const transitions = {
    hold: [['OPEN'], 'HELD', 'HELD'],
    resume: [['HELD'], 'OPEN', 'RESUMED'],
    convertQuotation: [['QUOTATION'], 'OPEN', 'QUOTATION_CONVERTED'],
    void: [['OPEN', 'HELD'], 'VOID', 'VOIDED'],
  } as const;
  const [allowed, to, kind] = transitions[action];
  const from = sale.status;
  if (!allowed.some((status) => status === from)) throw new PharmacySaleError('INVALID_STATE');
  // #414: re-opening a held sale or a quotation for selling is a sale-time act, so it
  // needs a licence valid now. Hold and void stay available to wind a sale down.
  if (to === 'OPEN')
    await assertStoredPharmacyMayOperate(db, scope.organizationId, scope.branchId, {
      name: `pharmacy.sale.${action}`,
    });
  const witness =
    action === 'void' && sale.lines.some((line) => line.medicine.controlled)
      ? await authorizeControlledRestoration(db, scope, controlledWitness)
      : undefined;
  const claimed = await db.pharmacySale.updateMany({
    where: {
      id: saleId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: from,
    },
    data: { status: to },
  });
  if (claimed.count !== 1) throw new PharmacySaleError('INVALID_STATE');

  if (action === 'void') {
    // DEV-623: a split payment leaves a bill OPEN (and it can then be held), so a
    // void must not strand money taken on it. Every tender is refunded first, on
    // the refund path's own manager/owner gate. Read after the claim: the sale
    // row is locked, so a tender that committed earlier is seen here and a later
    // one finds the bill no longer OPEN. A refusal rolls the claim back.
    // DEV-764: a points tender is not money taken: the void releases it below instead, so it
    // never needs a money refund (or refund authority) first.
    const tenders = await db.pharmacyTender.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        saleId,
        type: { not: 'LOYALTY' },
      },
      select: { amountMinor: true, refunds: { select: { amountMinor: true } } },
    });
    const unrefundedMinor = tenders.reduce(
      (total, tender) =>
        total +
        tender.amountMinor -
        tender.refunds.reduce((refunded, refund) => refunded + refund.amountMinor, 0),
      0
    );
    if (unrefundedMinor > 0) throw new PharmacySaleError('BILL_HAS_PAYMENTS');
    await releaseVoidedSaleRedemptions(db, scope, saleId);
    // DEV-819: a voided unpaid bill gives back the voucher uses its lines took. The sale row is
    // claimed above, so this runs once per void.
    const voucherUses = new Map<string, number>();
    for (const line of sale.lines)
      if (line.voucherId)
        voucherUses.set(line.voucherId, (voucherUses.get(line.voucherId) ?? 0) + 1);
    for (const [voucherId, uses] of voucherUses)
      await db.pharmacyVoucher.updateMany({
        where: {
          id: voucherId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          usedCount: { gte: uses },
        },
        data: { usedCount: { decrement: uses } },
      });
    const allocations = await db.pharmacySaleLineAllocation.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        saleLine: { saleId },
      },
      orderBy: { createdAt: 'asc' },
      select: { stockMovementId: true },
    });
    // DEV-825: a controlled void writes the register, so it takes the register
    // lock before the reversals lock any balance (stock-lock-order.ts).
    if (witness) await lockRegister(db, scope.organizationId, scope.branchId);
    const reversals = await reverseMovements(db, scope, {
      movementIds: allocations.map((allocation) => allocation.stockMovementId),
      reason: reason ?? 'Sale voided',
      at: new Date(),
    });
    const movements = await db.pharmacyStockMovement.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        id: { in: allocations.map((allocation) => allocation.stockMovementId) },
      },
      select: { id: true, quantityUnits: true },
    });
    await appendControlledRestorations(db, {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      recordedByUserId: scope.actorId,
      witness,
      reason: reason ?? 'Sale voided',
      lines: movements.map((movement) => ({
        sourceMovementId: movement.id,
        restorationMovementId: reversals.find((row) => row.reversesMovementId === movement.id)!.id,
        quantityCanonicalUnits: -movement.quantityUnits,
        restoreSellable: true,
      })),
    });
    await releaseSoldPackSerials(db, scope, saleId);
  }

  await event(db, scope, saleId, kind, reason, eventPayload);
  return saleInScope(db, scope, saleId);
}

/** Cumulative rounding ensures partial returns sum to the original net line value. */
export function returnedLineValue(
  line: {
    quantity: number;
    unitPriceMinor: number;
    grossMinor?: number;
    discountMinor: number;
    canonicalUnits: number;
    returnLines?: {
      canonicalUnits: number;
      grossMinor?: number | null;
      discountMinor?: number | null;
    }[];
    unidentifiedReturnHolds?: {
      canonicalUnits: number;
      grossMinor?: number | null;
      discountMinor?: number | null;
    }[];
  },
  units: number
) {
  if (line.returnLines && line.unidentifiedReturnHolds) return returnedMoney(line).netMinor;
  return Math.floor(
    (((line.grossMinor ?? line.quantity * line.unitPriceMinor) - line.discountMinor) * units) /
      line.canonicalUnits
  );
}

export async function readReturnHistory(db: ScopedDb, scope: LedgerScope, saleId: string) {
  const sale = await db.pharmacySale.findFirst({
    where: {
      id: saleId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'COMPLETED',
    },
    include: {
      lines: {
        include: {
          medicine: { select: { productName: true, controlled: true } },
          // DEV-638: the pack level actually sold, so a standalone strip is not called a box.
          packLevel: { select: { level: true, parentPackLevelId: true } },
          returnLines: true,
          unidentifiedReturnHolds: true,
          allocations: { include: { lot: { include: { batch: true } } } },
        },
      },
      tenders: { include: { refunds: true } },
      returns: {
        include: { lines: true, unidentifiedHolds: { include: { verificationTask: true } } },
      },
    },
  });
  if (!sale) throw new PharmacySaleError('NOT_FOUND');
  const locations = await db.pharmacyStockLocation.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      active: true,
      kind: 'QUARANTINE',
    },
    select: { id: true, name: true },
  });
  const lines = sale.lines.map((line) => {
    const unidentifiedUnits = line.unidentifiedReturnHolds.reduce(
      (n, row) => n + row.canonicalUnits,
      0
    );
    const returnedUnits =
      line.returnLines.reduce((n, row) => n + row.canonicalUnits, 0) + unidentifiedUnits;
    const lots = [...new Set(line.allocations.map((row) => row.inventoryLotId))].map((lotId) => {
      const allocations = line.allocations.filter((row) => row.inventoryLotId === lotId);
      const batch = allocations[0].lot.batch;
      return {
        lotId,
        batchNumber: batch.batchNumber,
        expiresAt: batch.expiresAt,
        restockAllowed: batch.state === 'ACTIVE' && batch.expiresAt > new Date(),
        returnableUnits: Math.min(
          line.canonicalUnits - returnedUnits,
          allocations.reduce((n, row) => n + row.canonicalUnits, 0) -
            line.returnLines
              .filter((row) => row.inventoryLotId === lotId)
              .reduce((n, row) => n + row.canonicalUnits, 0)
        ),
      };
    });
    return {
      id: line.id,
      name: line.medicine.productName,
      // Controlled restorations need a fresh independent pharmacist witness PIN.
      controlled: line.medicine.controlled,
      saleUnit: line.saleUnit,
      // DEV-705: a strip cut from a standalone legacy box is stored on the box level;
      // a hierarchy strip never sits on a top level, so name the strip, not the box.
      levelLabel:
        line.saleUnit === 'STRIP' && line.packLevel?.parentPackLevelId === null
          ? 'STRIP'
          : (line.packLevel?.level ?? null),
      quantity: line.quantity,
      canonicalUnitsPerSaleUnit: line.canonicalUnitsPerSaleUnit,
      canonicalUnits: line.canonicalUnits,
      returnedUnits,
      unidentifiedUnits,
      lots,
      returnedMinor: returnedLineValue(line, returnedUnits),
      netMinor: line.grossMinor - line.discountMinor,
    };
  });
  const tenders = sale.tenders.map((tender) => ({
    id: tender.id,
    type: tender.type,
    amountMinor: tender.amountMinor,
    refundedMinor: tender.refunds.reduce((n, row) => n + row.amountMinor, 0),
    refunds: tender.refunds.map((row) => ({
      id: row.id,
      amountMinor: row.amountMinor,
      reason: row.reason,
      createdAt: row.createdAt,
      manualReversalRequired: row.reason.startsWith('[CASH; MANUAL REVERSAL REQUIRED]'),
    })),
  }));
  return {
    saleId: sale.id,
    receiptNumber: sale.receiptNumber,
    receiptDeviceId: sale.receiptDeviceId,
    businessDate: sale.businessDate,
    lines,
    tenders,
    locations,
    refundableMinor: Math.max(
      0,
      lines.reduce((n, row) => n + row.returnedMinor, 0) -
        tenders.reduce((n, row) => n + row.refundedMinor, 0)
    ),
    returns: sale.returns.map((row) => ({
      id: row.id,
      reason: row.reason,
      createdAt: row.createdAt,
      lines: [
        ...row.lines.map((line) => ({
          saleLineId: line.saleLineId,
          canonicalUnits: line.canonicalUnits,
          integrityDecision: line.integrityDecision,
          lotId: line.inventoryLotId,
          verificationTaskId: null as string | null,
        })),
        ...row.unidentifiedHolds.map((hold) => ({
          saleLineId: hold.saleLineId,
          canonicalUnits: hold.canonicalUnits,
          integrityDecision: `QUARANTINE: unidentified lot — pharmacist verification pending. ${hold.integrityDecision}`,
          lotId: null,
          verificationTaskId: hold.verificationTask?.id ?? null,
        })),
      ],
    })),
  };
}

type PlannedAllocation = {
  id: string;
  inventoryLotId: string;
  canonicalUnits: number;
  grossMinor?: number | null;
  discountMinor?: number | null;
};
type PlannedReturnRow = {
  inventoryLotId: string;
  canonicalUnits: number;
  grossMinor?: number | null;
  discountMinor?: number | null;
};

/**
 * How a verified-lot return splits across the sold line's allocations of that lot, and what
 * each slice is worth from its allocation's snapshotted price. Pure: returnSaleLine records
 * exactly this plan, and DEV-501's counter quotes the refund from it.
 */
export function planLotReturn<A extends PlannedAllocation>(
  line: Omit<Parameters<typeof priceReturn>[0], 'returnLines'> & {
    allocations: readonly A[];
    returnLines: readonly PlannedReturnRow[];
  },
  lotId: string,
  canonicalUnits: number
) {
  // Earlier slices of this return count as already returned when pricing later ones.
  const returnLines: PlannedReturnRow[] = [...line.returnLines];
  const priced = { ...line, returnLines };
  const consumed = new Map<string, number>();
  for (const row of returnLines)
    consumed.set(row.inventoryLotId, (consumed.get(row.inventoryLotId) ?? 0) + row.canonicalUnits);
  const moneyByAllocation = new Map(saleAllocationMoney(line).map((row) => [row.id, row]));
  const slices: Array<{
    allocation: A;
    units: number;
    money: { grossMinor: number; discountMinor: number };
  }> = [];
  let remaining = canonicalUnits;
  for (const allocation of line.allocations) {
    if (allocation.inventoryLotId !== lotId) continue;
    const used = Math.min(allocation.canonicalUnits, consumed.get(allocation.inventoryLotId) ?? 0);
    consumed.set(allocation.inventoryLotId, (consumed.get(allocation.inventoryLotId) ?? 0) - used);
    const units = Math.min(remaining, allocation.canonicalUnits - used);
    if (!units) continue;
    const charged = moneyByAllocation.get(allocation.id)!;
    const delta = (amount: number) =>
      Math.floor((amount * (used + units)) / allocation.canonicalUnits) -
      Math.floor((amount * used) / allocation.canonicalUnits);
    const discount = delta(charged.discountMinor);
    const money = priceReturn(priced, units, {
      grossMinor: delta(charged.grossMinor - charged.discountMinor) + discount,
      discountMinor: discount,
    });
    returnLines.push({
      inventoryLotId: allocation.inventoryLotId,
      canonicalUnits: units,
      ...money,
    });
    slices.push({ allocation, units, money });
    remaining -= units;
    if (!remaining) break;
  }
  return { slices, remaining };
}

/**
 * DEV-501: the refund a proposed return is worth, priced exactly as returnSaleLine would
 * snapshot it now. Read-only; the recorded return remains the source of truth.
 */
export async function quoteSaleLineReturn(
  db: ScopedDb,
  scope: LedgerScope,
  input: { saleLineId: string; lotId?: string; canonicalUnits: number }
) {
  const line = await db.pharmacySaleLine.findFirst({
    where: { id: input.saleLineId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: {
      sale: { select: { status: true } },
      allocations: { orderBy: { id: 'asc' } },
      returnLines: true,
      unidentifiedReturnHolds: true,
    },
  });
  if (!line || line.sale.status !== 'COMPLETED') throw new PharmacySaleError('NOT_FOUND');
  const returned =
    line.returnLines.reduce((sum, item) => sum + item.canonicalUnits, 0) +
    line.unidentifiedReturnHolds.reduce((sum, item) => sum + item.canonicalUnits, 0);
  if (
    !Number.isSafeInteger(input.canonicalUnits) ||
    input.canonicalUnits <= 0 ||
    returned + input.canonicalUnits > line.canonicalUnits
  )
    throw new PharmacySaleError('RETURN_EXCEEDS_SOLD');
  if (!input.lotId) {
    const money = priceReturn(line, input.canonicalUnits);
    return { valueMinor: money.grossMinor - money.discountMinor };
  }
  const plan = planLotReturn(line, input.lotId, input.canonicalUnits);
  if (!plan.slices.length) throw new PharmacySaleError('CROSS_BRANCH_REFERENCE');
  if (plan.remaining) throw new PharmacySaleError('RETURN_EXCEEDS_SOLD');
  return {
    valueMinor: plan.slices.reduce(
      (sum, slice) => sum + slice.money.grossMinor - slice.money.discountMinor,
      0
    ),
  };
}

export async function returnSaleLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    saleLineId: string;
    controlledWitness?: ControlledRestorationPin;
    lotId?: string;
    canonicalUnits: number;
    quarantineLocationId?: string;
    disposition?: 'RESTOCK' | 'QUARANTINE';
    reason: string;
    integrityDecision: string;
    idempotencyKey: string;
  }
) {
  // Serialize the operation key across lines, then quantity checks for this sold line.
  await db.$queryRaw(
    Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${scope.organizationId + ':return:' + input.idempotencyKey}, 0))`
  );
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_sale_lines WHERE id=${input.saleLineId}
    AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`);
  const line = await db.pharmacySaleLine.findFirst({
    where: { id: input.saleLineId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: {
      sale: true,
      medicine: true,
      allocations: { orderBy: { id: 'asc' } },
      returnLines: true,
      unidentifiedReturnHolds: true,
    },
  });
  if (!line || line.sale.status !== 'COMPLETED') throw new PharmacySaleError('NOT_FOUND');
  const witness = line.medicine.controlled
    ? await authorizeControlledRestoration(db, scope, input.controlledWitness)
    : undefined;
  const requestedDisposition = input.disposition ?? 'QUARANTINE';
  const disposition = input.lotId ? requestedDisposition : 'QUARANTINE';
  // Keep legacy request fingerprints stable; never infer physical identity from allocations.
  // Credentials are transient and never become event payloads or replay fingerprints.
  const { controlledWitness: _pin, ...fingerprintInput } = input;
  void _pin;
  const fingerprint = JSON.stringify({ ...fingerprintInput, disposition: requestedDisposition });
  const prior = await db.pharmacySaleEvent.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: line.saleId,
      kind: 'RETURNED',
      payload: { path: ['idempotencyKey'], equals: input.idempotencyKey },
    },
  });
  if (prior) {
    const payload = prior.payload as { fingerprint?: string; returnId?: string };
    if (payload.fingerprint !== fingerprint) throw new PharmacySaleError('IDEMPOTENCY_CONFLICT');
    const saleReturn = await db.pharmacySaleReturn.findFirst({
      where: {
        id: payload.returnId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        originalSaleId: line.saleId,
      },
      include: {
        lines: { orderBy: { id: 'asc' } },
        unidentifiedHolds: { include: { verificationTask: true } },
      },
    });
    const hold = saleReturn?.unidentifiedHolds[0];
    if (saleReturn && hold)
      return {
        saleReturn,
        returnLine: null,
        movement: null,
        holding: hold,
        verificationTask: hold.verificationTask,
        returnId: saleReturn.id,
        replayed: true,
      };
    const returnLine = saleReturn?.lines[0];
    const movement =
      returnLine &&
      (await db.pharmacyStockMovement.findFirst({
        where: {
          id: returnLine.stockMovementId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
      }));
    if (!saleReturn || !returnLine || !movement) throw new PharmacySaleError('INVALID_STATE');
    return { saleReturn, returnLine, movement, returnId: saleReturn.id, replayed: true };
  }
  const returned =
    line.returnLines.reduce((sum, item) => sum + item.canonicalUnits, 0) +
    line.unidentifiedReturnHolds.reduce((sum, item) => sum + item.canonicalUnits, 0);
  if (
    !Number.isSafeInteger(input.canonicalUnits) ||
    input.canonicalUnits <= 0 ||
    returned + input.canonicalUnits > line.canonicalUnits
  )
    throw new PharmacySaleError('RETURN_EXCEEDS_SOLD');
  if (!input.reason.trim() || !input.integrityDecision.trim())
    throw new PharmacySaleError('INVALID_STATE');
  const allocations = line.allocations.filter((row) => row.inventoryLotId === input.lotId);
  if (input.lotId && !allocations.length) throw new PharmacySaleError('CROSS_BRANCH_REFERENCE');
  if (
    input.lotId &&
    input.canonicalUnits >
      allocations.reduce((sum, row) => sum + row.canonicalUnits, 0) -
        line.returnLines
          .filter((row) => row.inventoryLotId === input.lotId)
          .reduce((sum, row) => sum + row.canonicalUnits, 0)
  )
    throw new PharmacySaleError('RETURN_EXCEEDS_SOLD');
  let quarantineLocationId = input.quarantineLocationId;
  if (disposition === 'QUARANTINE') {
    const location =
      (quarantineLocationId || !input.lotId) &&
      (await db.pharmacyStockLocation.findFirst({
        where: {
          id: quarantineLocationId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          active: true,
          kind: 'QUARANTINE',
        },
        orderBy: { id: 'asc' },
      }));
    if (!location) throw new PharmacySaleError('CROSS_BRANCH_REFERENCE');
    quarantineLocationId = location.id;
  }
  const saleReturn = await db.pharmacySaleReturn.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      originalSaleId: line.saleId,
      actorId: scope.actorId,
      reason: input.reason,
    },
  });
  if (!input.lotId) {
    const money = priceReturn(line, input.canonicalUnits);
    const holding = await db.pharmacyUnidentifiedReturnHold.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        returnId: saleReturn.id,
        saleLineId: line.id,
        quarantineLocationId: quarantineLocationId!,
        canonicalUnits: input.canonicalUnits,
        ...money,
        integrityDecision: input.integrityDecision,
        actorId: scope.actorId,
      },
    });
    const verificationTask = await db.pharmacyReturnVerificationTask.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        holdingId: holding.id,
        requestedByUserId: scope.actorId,
      },
    });
    await postUnidentifiedSaleReturnEntry(db, scope, {
      holdingId: holding.id,
      at: saleReturn.createdAt,
    });
    await event(db, scope, line.saleId, 'RETURNED', input.reason, {
      returnId: saleReturn.id,
      disposition,
      holdingId: holding.id,
      verificationTaskId: verificationTask.id,
      integrityDecision: input.integrityDecision,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
    });
    return {
      saleReturn,
      returnLine: null,
      movement: null,
      holding,
      verificationTask,
      returnId: saleReturn.id,
      replayed: false,
    };
  }
  let firstReturnLine: Awaited<ReturnType<typeof db.pharmacySaleReturnLine.create>> | undefined;
  let firstMovement: Awaited<ReturnType<typeof db.pharmacyStockMovement.create>> | undefined;
  const restorations: Array<{
    sourceMovementId: string;
    restorationMovementId: string;
    quantityCanonicalUnits: number;
    restoreSellable: boolean;
  }> = [];
  // DEV-501: the same pure plan prices the counter's refund quote.
  const plan = planLotReturn(line, input.lotId, input.canonicalUnits);
  // DEV-825: every lock this return takes, before its first write and in the
  // global order (stock-lock-order.ts): the register when it writes one, then the
  // batch (a restock shares the recall boundary; never restore unsafe stock as
  // available), then every slice's balance in key order. Slices follow the
  // allocation's FEFO order, which is not the key order when one lot was sold
  // from two locations.
  if (witness) await lockRegister(db, scope.organizationId, scope.branchId);
  if (disposition === 'RESTOCK' && plan.slices.length)
    await lockStockRowsFrom(
      db,
      scope.organizationId,
      Prisma.sql`SELECT l."manufacturingBatchId" AS "batchId" FROM pharmacy_inventory_lots l
        WHERE l."organizationId"=${scope.organizationId}
          AND l.id IN (${Prisma.join(plan.slices.map(({ allocation }) => allocation.inventoryLotId))})`,
      { batch: 'update' }
    );
  await lockStockBalances(
    db,
    scope,
    plan.slices.map(({ allocation }) =>
      disposition === 'RESTOCK'
        ? {
            inventoryLotId: allocation.inventoryLotId,
            stockLocationId: allocation.stockLocationId,
            disposition: 'AVAILABLE',
          }
        : {
            inventoryLotId: allocation.inventoryLotId,
            stockLocationId: quarantineLocationId!,
            disposition: 'QUARANTINE',
          }
    )
  );
  for (const { allocation, units, money } of plan.slices) {
    if (disposition === 'RESTOCK') {
      const lot = await db.pharmacyInventoryLot.findFirst({
        where: {
          id: allocation.inventoryLotId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
        include: { batch: true },
      });
      const location = await db.pharmacyStockLocation.findFirst({
        where: {
          id: allocation.stockLocationId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          active: true,
          kind: { notIn: ['QUARANTINE', 'RETURNS'] },
        },
      });
      if (!lot || lot.batch.state !== 'ACTIVE' || lot.batch.expiresAt <= new Date() || !location)
        throw new PharmacySaleError('UNSAFE_STOCK');
    }
    const stockLocationId =
      disposition === 'RESTOCK' ? allocation.stockLocationId : quarantineLocationId!;
    const movement = await db.pharmacyStockMovement.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        inventoryLotId: allocation.inventoryLotId,
        stockLocationId,
        kind: 'RETURN',
        disposition: disposition === 'RESTOCK' ? 'AVAILABLE' : 'QUARANTINE',
        quantityUnits: units,
        looseUnitDelta: units,
        actorId: scope.actorId,
        reason: input.reason,
        idempotencyKey: `${input.idempotencyKey}:${allocation.id}`,
      },
    });
    const returnedLine = await db.pharmacySaleReturnLine.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        returnId: saleReturn.id,
        saleLineId: line.id,
        inventoryLotId: allocation.inventoryLotId,
        stockLocationId,
        canonicalUnits: units,
        ...money,
        integrityDecision: `${disposition}: ${input.integrityDecision}`,
        stockMovementId: movement.id,
      },
    });
    line.returnLines.push(returnedLine);
    await postSaleReturnEntry(db, scope, {
      saleReturnLineId: returnedLine.id,
      at: saleReturn.createdAt,
    });
    firstReturnLine ??= returnedLine;
    firstMovement ??= movement;
    if (allocation.stockMovementId) {
      restorations.push({
        sourceMovementId: allocation.stockMovementId,
        restorationMovementId: movement.id,
        quantityCanonicalUnits: units,
        restoreSellable: disposition === 'RESTOCK',
      });
    }
  }
  await appendControlledRestorations(db, {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    recordedByUserId: scope.actorId,
    witness,
    reason: disposition === 'RESTOCK' ? 'Returned to stock' : 'Returned to quarantine',
    lines: restorations,
  });
  if (plan.remaining || !firstReturnLine || !firstMovement)
    throw new PharmacySaleError('INVALID_QUANTITY');
  // DEV-92: a serialized pack returned whole to sellable stock may be sold again.
  if (
    disposition === 'RESTOCK' &&
    line.returnLines.reduce((total, returned) => total + returned.canonicalUnits, 0) >=
      line.canonicalUnits
  ) {
    await releaseSoldPackSerials(db, scope, line.saleId, new Date(), line.id);
  }
  await event(db, scope, line.saleId, 'RETURNED', input.reason, {
    returnId: saleReturn.id,
    disposition,
    lotId: input.lotId,
    integrityDecision: input.integrityDecision,
    idempotencyKey: input.idempotencyKey,
    fingerprint,
  });
  return {
    saleReturn,
    returnLine: firstReturnLine,
    movement: firstMovement,
    returnId: saleReturn.id,
    replayed: false,
  };
}

/**
 * DEV-501: the money value snapshotted for one recorded sale return, so the counter can
 * refund exactly what that return is worth in the same transaction. A replayed return
 * reads the same snapshot, so its refund amount (and refund idempotency hash) is stable.
 */
export async function saleReturnValueMinor(db: ScopedDb, scope: LedgerScope, returnId: string) {
  const where = { organizationId: scope.organizationId, branchId: scope.branchId, returnId };
  const select = { grossMinor: true, discountMinor: true } as const;
  const [lines, holds] = await Promise.all([
    db.pharmacySaleReturnLine.findMany({ where, select }),
    db.pharmacyUnidentifiedReturnHold.findMany({ where, select }),
  ]);
  const rows = [...lines, ...holds];
  // A return always has rows; an unpriced (legacy) row cannot be valued for a refund.
  if (!rows.length || rows.some((row) => row.grossMinor == null || row.discountMinor == null))
    throw new PharmacySaleError('INVALID_STATE');
  return rows.reduce((sum, row) => sum + row.grossMinor! - row.discountMinor!, 0);
}

export async function captureDemand(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    saleId?: string;
    requestedMedicineId?: string;
    requestedText?: string;
    strength?: string;
    form?: string;
    presentation?: string;
    saleUnit: 'PACK' | 'STRIP' | 'UNIT';
    quantity: number;
    reason: Parameters<typeof db.unfulfilledDemandEvent.create>[0]['data']['reason'];
    inventoryRuleSnapshot: unknown;
    estimatedValueMinor?: number;
    estimatedMarginMinor?: number;
    customerId?: string;
    consentRecorded?: boolean;
    /** DEV-81: the counter device; lines from one terminal group into a visit. */
    terminalId?: string;
    /** DEV-81: the full quantity asked for; `quantity` stays the unmet part. */
    requestedQty?: number;
    outcome?: LostSaleOutcome;
    notifyOptIn?: boolean;
    notifyPhone?: string;
    freeText?: string;
    matchedProductId?: string;
    matchConfidence?: number;
  },
  now: Date = new Date()
) {
  if (!input.requestedMedicineId && !input.requestedText?.trim())
    throw new PharmacySaleError('INVALID_QUANTITY');
  if (input.customerId && !input.consentRecorded) throw new PharmacySaleError('CONSENT_REQUIRED');
  if (input.requestedQty !== undefined && input.requestedQty < input.quantity)
    throw new PharmacySaleError('INVALID_QUANTITY');
  let notify: ReturnType<typeof notifyCapture>;
  try {
    notify = notifyCapture(input);
  } catch {
    throw new PharmacySaleError('CONSENT_REQUIRED');
  }
  const outcome = input.outcome ?? 'UNKNOWN';
  // DEV-81: visit, price and loss are derived here, never taken from the client.
  const { visitId, visitType } = await resolveVisit(db, scope, {
    terminalId: input.terminalId,
    customerId: input.customerId,
    saleId: input.saleId,
    now,
    newId: randomUUID,
  });
  const unitPricePkrMinor = await serverUnitPriceMinor(
    db,
    scope,
    input.requestedMedicineId,
    input.saleUnit
  );
  const unknown =
    outcome === 'UNKNOWN' && visitType !== 'WALK_OUT'
      ? (await branchUnknownLossProbability(db, scope, now)).probability
      : 0;
  const probability = lossProbability({
    outcome,
    visitType,
    createdAt: now,
    now,
    unknownProbability: unknown,
  });
  return db.unfulfilledDemandEvent.create({
    data: {
      ...input,
      ...notify,
      outcome,
      freeText: input.freeText?.trim() || null,
      requestedQty: input.requestedQty ?? input.quantity,
      visitId,
      visitType,
      unitPricePkrMinor,
      lossProbability: probability,
      estLossPkrMinor: estimateLossMinor({
        quantity: input.quantity,
        unitPriceMinor: unitPricePkrMinor,
        probability,
      }),
      inventoryRuleSnapshot: input.inventoryRuleSnapshot as Prisma.InputJsonValue,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      capturedByUserId: scope.actorId,
      createdAt: now,
    },
  });
}

export async function recoverDemandWithAlternate(
  db: ScopedDb,
  scope: LedgerScope,
  demandId: string,
  saleLineId: string
) {
  const demand = await db.unfulfilledDemandEvent.findFirst({
    where: {
      id: demandId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
  });
  const line = await db.pharmacySaleLine.findFirst({
    where: { id: saleLineId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!demand || !line || !demand.saleId || demand.saleId !== line.saleId)
    throw new PharmacySaleError('CROSS_BRANCH_REFERENCE');
  return db.unfulfilledDemandEvent.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: demandId } },
    data: { status: 'RECOVERED', recoveredSaleLineId: saleLineId, recoveredAt: new Date() },
  });
}

export async function demandAggregate(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  from: Date,
  to: Date
) {
  const rows = await db.unfulfilledDemandEvent.groupBy({
    by: ['requestedMedicineId', 'requestedText', 'reason'],
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      createdAt: { gte: from, lt: to },
    },
    _count: { _all: true },
    _sum: { quantity: true, estimatedValueMinor: true, estimatedMarginMinor: true },
    orderBy: { _count: { requestedMedicineId: 'desc' } },
  });
  return {
    label: 'Estimate',
    method: 'Explicit POS-10 events grouped by requested item and cause',
    window: { from, to },
    exclusions: ['searches without an explicit event', 'abandoned carts'],
    confidence: 'observed-events-only',
    rows,
  };
}

/** Campaign-key prefixes owned by server lifecycles (refill cycles, customer orders). */
export const RESERVED_RESTOCK_CAMPAIGN_PREFIXES = ['refill-cycle:', 'order:'] as const;

export function isReservedRestockCampaignKey(campaignKey: string | null | undefined) {
  const key = campaignKey?.trim().toLowerCase();
  return Boolean(
    key && RESERVED_RESTOCK_CAMPAIGN_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export async function addRestockInterest(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    demandEventId: string;
    patientId?: string;
    channel?: 'SMS' | 'WHATSAPP';
    reserveOnArrival?: boolean;
    quantityUnits: number;
    campaignKey?: string;
  }
) {
  if (!Number.isSafeInteger(input.quantityUnits) || input.quantityUnits <= 0)
    throw new PharmacySaleError('INVALID_QUANTITY');
  // DEV-845: refill-cycle and order holds are settled only by their own lifecycle;
  // a counter interest may not borrow their keys.
  if (isReservedRestockCampaignKey(input.campaignKey)) throw new PharmacySaleError('INVALID_STATE');
  const demand = await db.unfulfilledDemandEvent.findFirst({
    where: {
      id: input.demandEventId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
  });
  if (!demand) throw new PharmacySaleError('NOT_FOUND');
  if ((input.patientId === undefined) !== (input.channel === undefined))
    throw new PharmacySaleError('CONSENT_REQUIRED');

  if (input.patientId && input.channel) {
    const consent = await db.patientConsent.findFirst({
      where: {
        organizationId: scope.organizationId,
        patientId: input.patientId,
        purpose: 'REMINDERS',
        channel: input.channel,
      },
      orderBy: { version: 'desc' },
    });
    if (!consent?.granted || consent.revokedAt) throw new PharmacySaleError('CONSENT_REQUIRED');
  }

  return db.pharmacyRestockInterest.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      demandEventId: demand.id,
      patientId: input.patientId,
      channel: input.channel,
      reserveOnArrival: input.reserveOnArrival ?? false,
      quantityUnits: input.quantityUnits,
      campaignKey: input.campaignKey,
      createdByUserId: scope.actorId,
    },
  });
}

/** DEM-03 restock tables enforce exactly one branch through FORCE RLS. */
async function activateRestockBranch(db: ScopedDb, scope: Pick<LedgerScope, 'branchId'>) {
  await db.$queryRaw(
    Prisma.sql`SELECT set_config('app.current_branch_id', ${scope.branchId}, true)`
  );
}

export async function captureSafeRestockArrival(
  db: ScopedDb,
  scope: LedgerScope,
  input: { inventoryLotId: string; at?: Date; policy?: BackInStockPolicy }
) {
  const at = input.at ?? new Date();
  const policy = input.policy ?? readBackInStockPolicy();
  const lot = await db.pharmacyInventoryLot.findFirst({
    where: {
      id: input.inventoryLotId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    include: {
      batch: { select: { medicineId: true, state: true, expiresAt: true } },
      balances: {
        where: { disposition: 'AVAILABLE', onHandUnits: { gt: 0 } },
        orderBy: { stockLocationId: 'asc' },
      },
    },
  });
  if (
    !lot?.receivedAt ||
    lot.batch.state !== 'ACTIVE' ||
    lot.batch.expiresAt.getTime() <= at.getTime() ||
    lot.balances.length === 0
  )
    throw new PharmacySaleError('UNSAFE_STOCK');

  await activateRestockBranch(db, scope);
  const interests = await db.pharmacyRestockInterest.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
      // DEV-79: a waiting request expires; it is never notified after the window.
      createdAt: { gt: restockRequestCutoff(at, policy) },
      demandEvent: { requestedMedicineId: lot.batch.medicineId, status: 'OPEN' },
    },
    include: { patient: { select: { phone: true } } },
    // DEV-79: first-in, first-out; the id breaks ties so every run orders alike.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const captured = [];
  for (const interest of backInStockQueue(interests, at, policy).queue) {
    let reservation = null;
    if (interest.reserveOnArrival) {
      reservation = await db.pharmacyRestockReservation.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          interestId: interest.id,
          inventoryLotId: lot.id,
          stockLocationId: lot.balances[0]!.stockLocationId,
          reservedUnits: interest.quantityUnits,
        },
      });
    }
    if (!interest.patientId || !interest.channel) {
      captured.push({ interestId: interest.id, reservation, notification: null });
      continue;
    }
    const consent = await db.patientConsent.findFirst({
      where: {
        organizationId: scope.organizationId,
        patientId: interest.patientId,
        purpose: 'REMINDERS',
        channel: interest.channel,
      },
      orderBy: { version: 'desc' },
    });
    // A withdrawn consent or missing number skips this customer only: the
    // request stays OPEN and unnotified, and the rest of the queue is served.
    if (!consent?.granted || consent.revokedAt || !interest.patient?.phone) {
      captured.push({ interestId: interest.id, reservation, notification: null });
      continue;
    }
    const notification = await db.pharmacyRestockNotification.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        interestId: interest.id,
        channel: interest.channel,
        destination: interest.patient.phone,
        consentId: consent.id,
        inventoryLotId: lot.id,
        idempotencyKey: `restock:${interest.id}:${lot.id}`,
      },
      // DEV-845: `destination` is the customer's phone; the sender reads it on the server.
      select: { id: true, status: true },
    });
    await db.pharmacyRestockInterest.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: interest.id } },
      data: { status: 'NOTIFIED' },
    });
    captured.push({
      interestId: interest.id,
      reservation,
      notification: { id: notification.id, status: notification.status, hasContact: true },
    });
  }
  return captured;
}

export async function optOutRestockInterest(db: ScopedDb, scope: LedgerScope, interestId: string) {
  const interest = await db.pharmacyRestockInterest.findFirst({
    where: { id: interestId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!interest || interest.status === 'RECOVERED') throw new PharmacySaleError('NOT_FOUND');
  // Order and refill-subscription holds are settled only by their own lifecycle.
  if (interest.orderLineId || isRefillCycleCampaignKey(interest.campaignKey))
    throw new PharmacySaleError('INVALID_STATE');
  const at = new Date();
  await db.pharmacyRestockNotification.updateMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      interestId,
      status: 'CAPTURED',
    },
    data: { status: 'CANCELLED', cancelledAt: at },
  });
  await db.pharmacyRestockReservation.updateMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      interestId,
      status: 'RESERVED',
    },
    data: { status: 'RELEASED', settledAt: at },
  });
  return db.pharmacyRestockInterest.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: interestId } },
    data: { status: 'OPTED_OUT' },
  });
}

export async function recoverRestockInterest(
  db: ScopedDb,
  scope: LedgerScope,
  input: { interestId: string; saleLineId: string }
) {
  const interest = await db.pharmacyRestockInterest.findFirst({
    where: {
      id: input.interestId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: { in: ['OPEN', 'NOTIFIED'] },
    },
    include: { demandEvent: true },
  });
  if (interest?.orderLineId || isRefillCycleCampaignKey(interest?.campaignKey))
    throw new PharmacySaleError('INVALID_STATE');
  const line = await db.pharmacySaleLine.findFirst({
    where: { id: input.saleLineId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { sale: true },
  });
  if (
    !interest ||
    !line ||
    line.medicineId !== interest.demandEvent.requestedMedicineId ||
    line.sale.status !== 'COMPLETED' ||
    line.sale.receiptNumber === null
  )
    throw new PharmacySaleError('CROSS_BRANCH_REFERENCE');
  const recoveredAt = new Date();
  await db.unfulfilledDemandEvent.update({
    where: {
      organizationId_id: { organizationId: scope.organizationId, id: interest.demandEventId },
    },
    data: { status: 'RECOVERED', recoveredSaleLineId: line.id, recoveredAt },
  });
  await db.pharmacyRestockReservation.updateMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      interestId: interest.id,
      status: 'RESERVED',
    },
    data: { status: 'CONSUMED', settledAt: recoveredAt },
  });
  return db.pharmacyRestockInterest.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: interest.id } },
    data: {
      status: 'RECOVERED',
      recoveredSaleId: line.saleId,
      recoveredSaleLineId: line.id,
      recoveredAt,
    },
    include: {
      recoveredSale: { select: { receiptNumber: true, receiptDeviceId: true, businessDate: true } },
    },
  });
}

/** How far back notified requests are re-examined for a recovering sale. */
const RECOVERY_LOOKBACK_DAYS = 90;

/**
 * DEV-79: links notified back-in-stock requests to the completed sale that
 * recovered them, through the same attribution as `recoverRestockInterest`
 * (`recoveredSaleId` / `recoveredSaleLineId`). A request is recovered by a
 * receipted sale of the requested SKU at the branch completed after its notice
 * was sent and within the policy's recovery window, preferring the customer
 * who asked.
 * Each sale line recovers at most one request. Safe to run repeatedly.
 */
export async function linkRestockRecoveries(
  db: ScopedDb,
  scope: LedgerScope,
  input: { now?: Date; policy?: BackInStockPolicy } = {}
) {
  const now = input.now ?? new Date();
  const policy = input.policy ?? readBackInStockPolicy();
  await activateRestockBranch(db, scope);
  const interests = await db.pharmacyRestockInterest.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'NOTIFIED',
      orderLineId: null,
      demandEvent: { requestedMedicineId: { not: null } },
    },
    select: {
      id: true,
      patientId: true,
      demandEvent: { select: { requestedMedicineId: true } },
      notifications: {
        where: {
          status: 'CAPTURED',
          queuedAt: { gt: new Date(now.getTime() - RECOVERY_LOOKBACK_DAYS * DAY_MS) },
        },
        select: { id: true },
      },
    },
  });
  // A queued notice is not a delivered one. The window opens only when the
  // provider accepted the back-in-stock message, at the time it was sent;
  // withheld, failed or never-sent notices recover nothing.
  const noticeKeys = interests.flatMap((interest) =>
    interest.notifications.map((notice) => `back-in-stock:${notice.id}`)
  );
  const sent = noticeKeys.length
    ? await db.pharmacyMessageLog.findMany({
        where: {
          organizationId: scope.organizationId,
          kind: 'BACK_IN_STOCK',
          status: 'SENT',
          dedupeKey: { in: noticeKeys },
        },
        select: { dedupeKey: true, createdAt: true },
      })
    : [];
  const sentAt = new Map(sent.map((log) => [log.dedupeKey, log.createdAt]));
  const pending = interests
    .map((interest) => ({
      id: interest.id,
      patientId: interest.patientId,
      medicineId: interest.demandEvent.requestedMedicineId,
      notifiedAt: interest.notifications
        .map((notice) => sentAt.get(`back-in-stock:${notice.id}`))
        .filter((at): at is Date => at instanceof Date)
        .sort((a, b) => a.getTime() - b.getTime())[0],
    }))
    .filter(
      (interest): interest is typeof interest & { medicineId: string; notifiedAt: Date } =>
        !!interest.medicineId && !!interest.notifiedAt
    )
    .sort(
      (a, b) =>
        a.notifiedAt.getTime() - b.notifiedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  if (!pending.length) return [];

  const earliest = pending[0]!.notifiedAt;
  const latestClose = new Date(
    Math.max(...pending.map((interest) => interest.notifiedAt.getTime())) +
      policy.recoveryWindowDays * DAY_MS
  );
  const lines = await db.pharmacySaleLine.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      medicineId: { in: [...new Set(pending.map((interest) => interest.medicineId))] },
      sale: {
        status: 'COMPLETED',
        receiptNumber: { not: null },
        completedAt: { gt: earliest, lte: latestClose },
      },
    },
    select: {
      id: true,
      saleId: true,
      medicineId: true,
      sale: { select: { completedAt: true, customer: { select: { patientId: true } } } },
    },
  });
  const used = new Set(
    (
      await db.pharmacyRestockInterest.findMany({
        where: {
          organizationId: scope.organizationId,
          recoveredSaleLineId: { in: lines.map((line) => line.id) },
        },
        select: { recoveredSaleLineId: true },
      })
    ).map((row) => row.recoveredSaleLineId)
  );
  const candidates = lines
    .filter((line) => line.sale.completedAt && !used.has(line.id))
    .map((line) => ({
      saleLineId: line.id,
      saleId: line.saleId,
      medicineId: line.medicineId,
      patientId: line.sale.customer?.patientId ?? null,
      completedAt: line.sale.completedAt!,
    }));

  const linked = [];
  for (const interest of pending) {
    const line = selectRecoveryLine(
      interest,
      candidates.filter((candidate) => !used.has(candidate.saleLineId)),
      policy
    );
    if (!line) continue;
    used.add(line.saleLineId);
    const recovered = await recoverRestockInterest(db, scope, {
      interestId: interest.id,
      saleLineId: line.saleLineId,
    });
    linked.push({
      interestId: interest.id,
      saleId: line.saleId,
      saleLineId: line.saleLineId,
      recoveredAt: recovered.recoveredAt,
    });
  }
  return linked;
}

export async function restockRecoveryReport(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  campaignKey?: string
) {
  const rows = await db.pharmacyRestockInterest.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      ...(campaignKey ? { campaignKey } : {}),
    },
    select: {
      id: true,
      demandEventId: true,
      campaignKey: true,
      status: true,
      recoveredSaleLineId: true,
      recoveredAt: true,
      demandEvent: { select: { requestedMedicineId: true, requestedText: true, quantity: true } },
      recoveredSale: {
        select: { id: true, receiptNumber: true, receiptDeviceId: true, businessDate: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  // DEV-79: the counter finds a request by the reference its notice carried.
  return rows.map((row) => ({ ...row, reference: backInStockReference(row.id) }));
}
