import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { packLevelCanonicalUnits } from './counter-pricing';
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
import { appendControlledRestorations } from './controlled-register';
import { assertStoredPharmacyMayOperate } from './regulatory';
import { isRefillCycleCampaignKey } from './refill-subscription-rules';
import { assertVoucherEligibleLine, VoucherScopeError } from './voucher-scope';
import { allocateForSale, allocateReservedForSale, reverseMovements } from './stock-ledger';
import type { LedgerScope, ReservedSaleAllocation } from './stock-ledger';
import { postSaleReturnEntry, postUnidentifiedSaleReturnEntry } from './finance-postings';
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
      | 'RETURN_EXCEEDS_SOLD'
      | 'IDEMPOTENCY_CONFLICT'
      | 'CONSENT_REQUIRED'
      | 'UNSAFE_STOCK'
      | 'CROSS_BRANCH_REFERENCE'
      | 'BILL_HAS_PAYMENTS'
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
  approvedByUserId?: string;
  approvalPolicy?: string;
  override?: { inventoryLotId: string; reason: string; approvalPolicy: string };
  idempotencyKey: string;
};

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
  options: { applyCounterPromotions?: boolean } = {}
) {
  return addSaleLineWithAllocation(db, scope, input, undefined, options.applyCounterPromotions);
}

/** Internal customer-order path; never accepted by the counter's public input schema.
 * Caller holds order/reservation/stock locks and releases the validated reservations
 * in this same transaction. No override approval is fabricated for reserved stock.
 */
export async function addReservedSaleLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: Omit<AddSaleLineInput, 'override'>,
  reservation: ReservedSaleAllocation
) {
  return addSaleLineWithAllocation(db, scope, input, reservation);
}

/**
 * DEV-27: loads the stored voucher for a line and enforces its allowlist. The
 * caller cannot set the amount, kind or approver of a voucher discount.
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
  const voucher = await db.pharmacyVoucher.findFirst({
    where: {
      id: input.voucherId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      active: true,
    },
    select: {
      id: true,
      discountMinor: true,
      eligibleCategories: true,
      issuedByUserId: true,
      validUntil: true,
    },
  });
  if (!voucher || (voucher.validUntil && voucher.validUntil.getTime() <= Date.now()))
    throw new PharmacySaleError('VOUCHER_INVALID');
  try {
    assertVoucherEligibleLine(medicine, voucher.eligibleCategories);
  } catch (error) {
    if (error instanceof VoucherScopeError) throw new PharmacySaleError('VOUCHER_CATEGORY_REFUSED');
    throw error;
  }
  return voucher;
}

async function addSaleLineWithAllocation(
  db: ScopedDb,
  scope: LedgerScope,
  input: AddSaleLineInput,
  reservation?: ReservedSaleAllocation,
  applyCounterPromotions = false
) {
  // #414: a sale opened while the licence was valid must not keep dispensing after it
  // lapses. Every line path (counter, controlled, offline replay, customer orders)
  // re-checks the persisted gate at dispense time, before any stock is allocated.
  await assertStoredPharmacyMayOperate(db, scope.organizationId, scope.branchId, {
    name: 'pharmacy.sale.dispense',
  });
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
  // DEV-830 (F05): reserved customer-order and refill lines carry a multiplier the server
  // derived from the stored lot when it reserved them; every other line is checked here.
  if (!reservation) await assertSaleUnitConversion(db, scope, input);
  // DEV-27: a voucher is a stored record. Its eligible-category allowlist is
  // enforced here, before any stock is allocated, so a voucher never applies to
  // an Rx, OTC drug, supplement or medical-device line.
  const voucher = input.voucherId ? await voucherForRedemption(db, scope, input, medicine) : null;
  const allocationInput = {
    medicineId: input.medicineId,
    requiredUnits: canonicalUnits,
    at: new Date(),
    idempotencyKeyPrefix: `sale:${input.idempotencyKey}`,
    override: input.override,
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
    ? voucher.issuedByUserId
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
  return { line, allocation };
}

export async function changeSaleStatus(
  db: ScopedDb,
  scope: LedgerScope,
  saleId: string,
  action: 'hold' | 'resume' | 'convertQuotation' | 'void',
  reason?: string,
  controlledWitness?: ControlledRestorationPin
) {
  const sale = await saleInScope(db, scope, saleId);
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
    const tenders = await db.pharmacyTender.findMany({
      where: { organizationId: scope.organizationId, branchId: scope.branchId, saleId },
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
    const allocations = await db.pharmacySaleLineAllocation.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        saleLine: { saleId },
      },
      orderBy: { createdAt: 'asc' },
      select: { stockMovementId: true },
    });
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
  }

  await event(db, scope, saleId, kind, reason);
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
          packLevel: { select: { level: true } },
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
      levelLabel: line.packLevel?.level ?? null,
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
  let remaining = input.canonicalUnits;
  let firstReturnLine: Awaited<ReturnType<typeof db.pharmacySaleReturnLine.create>> | undefined;
  let firstMovement: Awaited<ReturnType<typeof db.pharmacyStockMovement.create>> | undefined;
  const restorations: Array<{
    sourceMovementId: string;
    restorationMovementId: string;
    quantityCanonicalUnits: number;
    restoreSellable: boolean;
  }> = [];
  const consumed = new Map<string, number>();
  for (const row of line.returnLines)
    consumed.set(row.inventoryLotId, (consumed.get(row.inventoryLotId) ?? 0) + row.canonicalUnits);
  const moneyByAllocation = new Map(saleAllocationMoney(line).map((row) => [row.id, row]));
  for (const allocation of allocations) {
    const used = Math.min(allocation.canonicalUnits, consumed.get(allocation.inventoryLotId) ?? 0);
    consumed.set(allocation.inventoryLotId, (consumed.get(allocation.inventoryLotId) ?? 0) - used);
    const units = Math.min(remaining, allocation.canonicalUnits - used);
    if (!units) continue;
    if (disposition === 'RESTOCK') {
      // Batch lock shares the recall boundary; never restore unsafe stock as available.
      await db.$queryRaw(Prisma.sql`SELECT b.id FROM pharmacy_manufacturing_batches b
        JOIN pharmacy_inventory_lots l ON l."manufacturingBatchId"=b.id AND l."organizationId"=b."organizationId"
        WHERE l.id=${allocation.inventoryLotId} AND l."organizationId"=${scope.organizationId} FOR UPDATE OF b`);
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
    const charged = moneyByAllocation.get(allocation.id)!;
    const delta = (amount: number) =>
      Math.floor((amount * (used + units)) / allocation.canonicalUnits) -
      Math.floor((amount * used) / allocation.canonicalUnits);
    const discount = delta(charged.discountMinor);
    const money = priceReturn(line, units, {
      grossMinor: delta(charged.grossMinor - charged.discountMinor) + discount,
      discountMinor: discount,
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
    remaining -= units;
    if (!remaining) break;
  }
  await appendControlledRestorations(db, {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    recordedByUserId: scope.actorId,
    witness,
    reason: disposition === 'RESTOCK' ? 'Returned to stock' : 'Returned to quarantine',
    lines: restorations,
  });
  if (remaining || !firstReturnLine || !firstMovement)
    throw new PharmacySaleError('INVALID_QUANTITY');
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

export async function captureSafeRestockArrival(
  db: ScopedDb,
  scope: LedgerScope,
  input: { inventoryLotId: string; at?: Date }
) {
  const at = input.at ?? new Date();
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

  const interests = await db.pharmacyRestockInterest.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
      demandEvent: { requestedMedicineId: lot.batch.medicineId, status: 'OPEN' },
    },
    include: { patient: { select: { phone: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const captured = [];
  for (const interest of interests) {
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
    if (!consent?.granted || consent.revokedAt || !interest.patient?.phone)
      throw new PharmacySaleError('CONSENT_REQUIRED');
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
    });
    await db.pharmacyRestockInterest.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: interest.id } },
      data: { status: 'NOTIFIED' },
    });
    captured.push({ interestId: interest.id, reservation, notification });
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

export async function restockRecoveryReport(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  campaignKey?: string
) {
  return db.pharmacyRestockInterest.findMany({
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
}
