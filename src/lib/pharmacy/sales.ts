import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { priceFromLot } from './medicine';
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
import {
  allocateForSale,
  allocateReservedForSale,
  loadStockCandidatesForRead,
  reverseMovements,
} from './stock-ledger';
import type { LedgerScope, ReservedSaleAllocation } from './stock-ledger';
import { postSaleReturnEntry, postUnidentifiedSaleReturnEntry } from './finance-postings';
import { isRecoverableSale, recoveryDashboard, RESTOCK_REQUEST_TTL_DAYS } from './back-in-stock';
import { trackSideEffect } from '@/lib/side-effects/scope';
import { lockPatientConsent } from './consent-writer';

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
      | 'PRICE_ABOVE_MRP'
      | 'MARGIN_GUARDRAIL'
      | 'APPROVAL_REQUIRED'
      | 'REGULATED_DISCOUNT_REFUSED'
      | 'RETURN_EXCEEDS_SOLD'
      | 'IDEMPOTENCY_CONFLICT'
      | 'CONSENT_REQUIRED'
      | 'UNSAFE_STOCK'
      | 'CROSS_BRANCH_REFERENCE'
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

export async function createSale(db: ScopedDb, scope: LedgerScope, quotation = false) {
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
  approvedByUserId?: string;
  approvalPolicy?: string;
  override?: { inventoryLotId: string; reason: string; approvalPolicy: string };
  idempotencyKey: string;
};

export async function addSaleLine(db: ScopedDb, scope: LedgerScope, input: AddSaleLineInput) {
  return addSaleLineWithAllocation(db, scope, input);
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

async function addSaleLineWithAllocation(
  db: ScopedDb,
  scope: LedgerScope,
  input: AddSaleLineInput,
  reservation?: ReservedSaleAllocation
) {
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
  });
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  let unitPriceMinor = 0,
    ceiling = 0,
    costMinor = 0;
  for (const part of allocation.allocations) {
    const lot = lotById.get(part.inventoryLotId);
    if (!lot) throw new PharmacySaleError('NOT_FOUND');
    const price = priceFromLot({
      printedMrpMinor: lot.printedMrpMinor,
      canonicalUnitsInPack: lot.unitsPerPack,
      canonicalUnitsPerSaleUnit: input.canonicalUnitsPerSaleUnit,
    });
    unitPriceMinor = Math.max(unitPriceMinor, price.unitPriceMinor);
    ceiling = Math.max(ceiling, price.proRataCeilingMinor);
    costMinor += lot.unitCostMinor * part.units;
  }
  const grossMinor = unitPriceMinor * input.quantity;
  const discountMinor = input.discountMinor ?? 0;
  validateDiscount({
    regulated: medicine.rx || medicine.restricted || medicine.controlled,
    discountMinor,
    grossMinor,
    costMinor,
    approvedByUserId: input.approvedByUserId,
    approvalPolicy: input.approvalPolicy,
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
      proRataCeilingMinor: ceiling,
      unitCostMinor: Math.ceil(costMinor / input.quantity),
      discountKind: input.discountKind,
      discountMinor,
      approvalPolicy: input.approvalPolicy,
      approvedByUserId: input.approvedByUserId,
      idempotencyKey: input.idempotencyKey,
    },
  });
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
          stockMovementId: allocation.movementIds[index]!,
        },
      })
    )
  );
  await event(db, scope, sale.id, 'LINE_ADDED', undefined, { saleLineId: line.id });
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
  const transitions = {
    hold: ['OPEN', 'HELD', 'HELD'],
    resume: ['HELD', 'OPEN', 'RESUMED'],
    convertQuotation: ['QUOTATION', 'OPEN', 'QUOTATION_CONVERTED'],
    void: ['OPEN', 'VOID', 'VOIDED'],
  } as const;
  const [from, to, kind] = transitions[action];
  if (sale.status !== from) throw new PharmacySaleError('INVALID_STATE');
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
    discountMinor: number;
    canonicalUnits: number;
  },
  units: number
) {
  return Math.floor(
    ((line.quantity * line.unitPriceMinor - line.discountMinor) * units) / line.canonicalUnits
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
          medicine: { select: { productName: true } },
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
      saleUnit: line.saleUnit,
      quantity: line.quantity,
      canonicalUnitsPerSaleUnit: line.canonicalUnitsPerSaleUnit,
      canonicalUnits: line.canonicalUnits,
      returnedUnits,
      unidentifiedUnits,
      lots,
      returnedMinor: returnedLineValue(line, returnedUnits),
      netMinor: line.quantity * line.unitPriceMinor - line.discountMinor,
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
    const holding = await db.pharmacyUnidentifiedReturnHold.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        returnId: saleReturn.id,
        saleLineId: line.id,
        quarantineLocationId: quarantineLocationId!,
        canonicalUnits: input.canonicalUnits,
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
    const returnedLine = await db.pharmacySaleReturnLine.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        returnId: saleReturn.id,
        saleLineId: line.id,
        inventoryLotId: allocation.inventoryLotId,
        stockLocationId,
        canonicalUnits: units,
        integrityDecision: `${disposition}: ${input.integrityDecision}`,
        stockMovementId: movement.id,
      },
    });
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
  }
) {
  if (!input.requestedMedicineId && !input.requestedText?.trim())
    throw new PharmacySaleError('INVALID_QUANTITY');
  if (input.customerId && !input.consentRecorded) throw new PharmacySaleError('CONSENT_REQUIRED');
  return db.unfulfilledDemandEvent.create({
    data: {
      ...input,
      inventoryRuleSnapshot: input.inventoryRuleSnapshot as Prisma.InputJsonValue,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      capturedByUserId: scope.actorId,
    },
  });
}

/** Call inside the caller's transaction before assigning revenue to a request. */
async function lockRecoveryLine(db: ScopedDb, scope: LedgerScope, saleLineId: string) {
  await db.$queryRaw(Prisma.sql`
    SELECT id FROM pharmacy_sale_lines
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
      AND id = ${saleLineId} FOR UPDATE
  `);
  const credited = await db.unfulfilledDemandEvent.count({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      recoveredSaleLineId: saleLineId,
    },
  });
  if (credited) throw new PharmacySaleError('INVALID_STATE');
}

export async function recoverDemandWithAlternate(
  db: ScopedDb,
  scope: LedgerScope,
  demandId: string,
  saleLineId: string
) {
  await lockRecoveryLine(db, scope, saleLineId);
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
  input: { inventoryLotId: string; at?: Date; skipUnavailable?: boolean }
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
  ) {
    if (input.skipUnavailable) return [];
    throw new PharmacySaleError('UNSAFE_STOCK');
  }

  const interests = await db.pharmacyRestockInterest.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
      createdAt: { gte: new Date(at.getTime() - RESTOCK_REQUEST_TTL_DAYS * 86_400_000) },
      demandEvent: { requestedMedicineId: lot.batch.medicineId, status: 'OPEN' },
      notifications: { none: {} },
      reservation: { is: null },
    },
    include: { patient: { select: { phone: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const captured = [];
  for (const candidate of interests) {
    // Serialize arrivals for this request, then recheck after taking the lock.
    // A second lot must not reserve or enqueue it again while delivery is pending.
    await db.$queryRaw(Prisma.sql`
      SELECT id FROM pharmacy_restock_interests
      WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
        AND id = ${candidate.id} FOR UPDATE
    `);
    const interest = await db.pharmacyRestockInterest.findFirst({
      where: {
        id: candidate.id,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: 'OPEN',
        notifications: { none: {} },
        reservation: { is: null },
      },
      include: { patient: { select: { phone: true } } },
    });
    if (!interest) continue;
    // Consent writers hold this lock through commit. Keep the consent read and
    // notification insert in the same critical section so revocation cannot
    // invalidate the consent ID and roll back the goods receipt.
    if (interest.patientId && interest.channel) {
      await lockPatientConsent(db, scope.organizationId, interest.patientId);
    }
    const consent =
      interest.patientId && interest.channel
        ? await db.patientConsent.findFirst({
            where: {
              organizationId: scope.organizationId,
              patientId: interest.patientId,
              purpose: 'REMINDERS',
              channel: interest.channel,
            },
            orderBy: { version: 'desc' },
          })
        : null;
    if (
      interest.patientId &&
      interest.channel &&
      (!consent?.granted || consent.revokedAt || !interest.patient?.phone)
    ) {
      if (input.skipUnavailable) continue;
      throw new PharmacySaleError('CONSENT_REQUIRED');
    }

    let reservation = null;
    if (interest.reserveOnArrival) {
      let stockLocationId = lot.balances[0]!.stockLocationId;
      if (input.skipUnavailable) {
        // GRN posting must still succeed when an outstanding request is larger
        // than this delivery. These new lot balances belong to its transaction.
        const available = (await loadStockCandidatesForRead(db, scope, lot.batch.medicineId)).find(
          (row) =>
            row.inventoryLotId === lot.id &&
            row.disposition === 'AVAILABLE' &&
            row.availableUnits >= interest.quantityUnits
        );
        if (!available) continue;
        stockLocationId = available.stockLocationId;
      }
      reservation = await db.pharmacyRestockReservation.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          interestId: interest.id,
          inventoryLotId: lot.id,
          stockLocationId,
          reservedUnits: interest.quantityUnits,
        },
      });
    }
    if (!interest.patientId || !interest.channel || !consent) {
      captured.push({ interestId: interest.id, reservation, notification: null });
      continue;
    }
    const notification = await db.pharmacyRestockNotification.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        interestId: interest.id,
        channel: interest.channel,
        destination: interest.patient!.phone!,
        consentId: consent.id,
        inventoryLotId: lot.id,
        idempotencyKey: `restock:${interest.id}`,
      },
    });
    // The notification and its outbox entry commit with stock receipt. The
    // existing tenant drainer (and cron retry) dispatch only committed entries.
    const queued = db.outboundEffect.create({
      data: {
        organizationId: scope.organizationId,
        kind: 'pharmacy-back-in-stock',
        payload: { branchId: scope.branchId, notificationId: notification.id },
      },
    });
    trackSideEffect(queued);
    await queued;
    captured.push({ interestId: interest.id, reservation, notification });
  }
  return captured;
}

export async function optOutRestockInterest(db: ScopedDb, scope: LedgerScope, interestId: string) {
  const interest = await db.pharmacyRestockInterest.findFirst({
    where: { id: interestId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!interest || interest.status === 'RECOVERED') throw new PharmacySaleError('NOT_FOUND');
  if (interest.orderLineId) throw new PharmacySaleError('INVALID_STATE');
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
  await lockRecoveryLine(db, scope, input.saleLineId);
  await db.$queryRaw(Prisma.sql`
    SELECT id FROM pharmacy_restock_interests
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
      AND id = ${input.interestId} FOR UPDATE
  `);
  const interest = await db.pharmacyRestockInterest.findFirst({
    where: {
      id: input.interestId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: { in: ['OPEN', 'NOTIFIED'] },
    },
    include: {
      demandEvent: true,
      notifications: {
        where: { status: 'SENT', sentAt: { not: null } },
        orderBy: { sentAt: 'desc' },
        take: 1,
      },
    },
  });
  if (interest?.orderLineId) throw new PharmacySaleError('INVALID_STATE');
  const line = await db.pharmacySaleLine.findFirst({
    where: { id: input.saleLineId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { sale: { include: { customer: { select: { patientId: true } } } } },
  });
  if (!interest || !line || line.sale.status !== 'COMPLETED' || line.sale.receiptNumber === null)
    throw new PharmacySaleError('CROSS_BRANCH_REFERENCE');
  const recoveredAt = new Date();
  const notifiedAt = interest.notifications[0]?.sentAt;
  const sameSku = line.medicineId === interest.demandEvent.requestedMedicineId;
  // Manual same-SKU recovery predates automated messaging. Keep it available
  // for reservations, SMS, absent consent and mock/failed deliveries. A sent
  // notice still uses the seven-day attribution window.
  if (
    notifiedAt
      ? !line.sale.completedAt ||
        !isRecoverableSale({
          notifiedAt,
          soldAt: line.sale.completedAt,
          sameCustomer: Boolean(
            line.sale.customer?.patientId &&
              line.sale.customer.patientId === (interest.patientId ?? interest.demandEvent.customerId)
          ),
          sameSku,
        })
      : !sameSku
  )
    throw new PharmacySaleError('INVALID_STATE');
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

export async function restockRecoveryDashboard(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  campaignKey?: string
) {
  const interests = await db.pharmacyRestockInterest.findMany({
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
      demandEvent: {
        select: {
          requestedMedicineId: true,
          requestedText: true,
          quantity: true,
          estimatedValueMinor: true,
          medicine: {
            select: { strengths: { select: { ingredient: { select: { name: true } } } } },
          },
        },
      },
      notifications: { orderBy: { queuedAt: 'asc' }, take: 1, select: { inventoryLotId: true } },
      recoveredSale: {
        select: { id: true, receiptNumber: true, receiptDeviceId: true, businessDate: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  const saleLines = await db.pharmacySaleLine.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      id: {
        in: interests.flatMap((row) => (row.recoveredSaleLineId ? [row.recoveredSaleLineId] : [])),
      },
    },
    select: {
      id: true,
      quantity: true,
      unitPriceMinor: true,
      discountMinor: true,
      canonicalUnits: true,
      returnLines: { select: { canonicalUnits: true } },
      unidentifiedReturnHolds: { select: { canonicalUnits: true } },
    },
  });
  const lots = await db.pharmacyInventoryLot.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      id: {
        in: interests.flatMap((row) => row.notifications.map((notice) => notice.inventoryLotId)),
      },
    },
    select: { id: true, supplierName: true },
  });
  const lineById = new Map(saleLines.map((line) => [line.id, line]));
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  // Historical duplicates must not multiply revenue either.
  const creditedLines = new Set<string>();
  const dashboard = recoveryDashboard(
    interests.map((interest) => {
      const line = interest.recoveredSaleLineId ? lineById.get(interest.recoveredSaleLineId) : null;
      const credit = interest.status === 'RECOVERED' && line && !creditedLines.has(line.id);
      if (credit) creditedLines.add(line.id);
      // Completed-sale refunds are capped at returned goods. Subtract their
      // value once, including returns pending payment, rather than subtracting
      // both the return and its subsequent cash refund.
      const returnedUnits = line
        ? line.returnLines.reduce((sum, row) => sum + row.canonicalUnits, 0) +
          line.unidentifiedReturnHolds.reduce((sum, row) => sum + row.canonicalUnits, 0)
        : 0;
      const lotId = interest.notifications[0]?.inventoryLotId;
      const salts =
        interest.demandEvent.medicine?.strengths.map((part) => part.ingredient.name) ?? [];
      return {
        branch: scope.branchId,
        salt: [...new Set(salts)].sort().join(' + ') || 'Unknown',
        distributor: (lotId ? lotById.get(lotId)?.supplierName : null) ?? 'Unassigned',
        estimatedLostMinor: interest.demandEvent.estimatedValueMinor ?? 0,
        recoveredMinor:
          credit && line
            ? Math.max(
                0,
                line.quantity * line.unitPriceMinor - line.discountMinor -
                  returnedLineValue(line, returnedUnits)
              )
            : 0,
      };
    })
  );
  return { ...dashboard, interests };
}
