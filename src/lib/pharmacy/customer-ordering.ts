import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { blockReasonFor, planAllocation, PharmacyInventoryError } from './inventory';
import { priceFromLot } from './medicine';
import { deliveryTotals } from './customer-delivery';
import { saleTotalMinor } from './settlement';
import { addReservedSaleLine, createSale } from './sales';
import type { LedgerScope } from './stock-ledger';

export type CustomerOrderFulfillment = 'COLLECT' | 'DELIVER';
export type CustomerOrderStatus =
  | 'PROPOSED'
  | 'ACCEPTED'
  | 'PACKING'
  | 'READY_FOR_COLLECTION'
  | 'OUT_FOR_DELIVERY'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'RETURNED';

export class PharmacyCustomerOrderError extends Error {
  constructor(
    readonly reason:
      | 'CUSTOMER_ACCOUNT_REQUIRED'
      | 'CUSTOMER_NOT_FOUND'
      | 'STAFF_ACCESS_REQUIRED'
      | 'ITEM_NOT_ORDERABLE'
      | 'INSUFFICIENT_STOCK'
      | 'INVALID_FULFILLMENT'
      | 'INVALID_STATE'
      | 'ORDER_NOT_FOUND'
      | 'RUNNER_REQUIRED'
      | 'SALE_NOT_COMPLETED'
      | 'RESERVATION_UNAVAILABLE'
  ) {
    super(reason);
  }
}

type CatalogRow = {
  medicineId: string;
  productName: string;
  brandName: string | null;
  presentationId: string;
  presentation: string;
  packLevelId: string;
  packLabel: string;
  unitsPerPack: number;
  printedMrpMinor: number;
  availableUnits: number;
};

type ReservationCandidate = {
  inventoryLotId: string;
  stockLocationId: string;
  organizationId: string;
  branchId: string;
  batchState: 'ACTIVE' | 'RECALLED' | 'QUARANTINED';
  disposition:
    'AVAILABLE' | 'QUARANTINE' | 'DAMAGED' | 'DESTROYED' | 'IN_TRANSIT' | 'RETURN_TO_SUPPLIER';
  expiresAt: Date;
  receivedAt: Date | null;
  packLevelId: string;
  availableUnits: number;
  unitsPerPack: number;
  printedMrpMinor: number;
};

const RELEASABLE_ORDER_STATUSES: CustomerOrderStatus[] = [
  'PROPOSED',
  'ACCEPTED',
  'PACKING',
  'READY_FOR_COLLECTION',
];

export function isCustomerOrderReleaseEligible(status: CustomerOrderStatus) {
  return RELEASABLE_ORDER_STATUSES.includes(status);
}

export function isCustomerOrderReservationDeadlineEnforced(status: CustomerOrderStatus) {
  return !['READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY'].includes(status);
}

export function isCustomerOrderableMedicine(medicine: {
  saleable: boolean;
  otc: boolean;
  rx: boolean;
  restricted: boolean;
  controlled: boolean;
}) {
  return (
    medicine.saleable &&
    medicine.otc &&
    !medicine.rx &&
    !medicine.restricted &&
    !medicine.controlled
  );
}

async function activateBranchScope(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>
) {
  await db.$queryRaw(
    Prisma.sql`SELECT set_config('app.current_branch_id', ${scope.branchId}, true)`
  );
}

export async function listStorefrontCatalog(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  search = ''
) {
  await activateBranchScope(db, scope);
  const query = search.trim();
  const rows = await db.$queryRaw<CatalogRow[]>(Prisma.sql`
    WITH safe_stock AS (
      SELECT batch."medicineId", lot."packLevelId", lot."id" AS "inventoryLotId",
             lot."unitsPerPack", lot."printedMrpMinor", batch."expiresAt", lot."receivedAt",
             GREATEST(0, balance."onHandUnits"
               - COALESCE((SELECT SUM(claim."reservedUnits") FROM "pharmacy_supplier_claims" claim
                   WHERE claim."organizationId" = balance."organizationId"
                     AND claim."branchId" = balance."branchId"
                     AND claim."inventoryLotId" = balance."inventoryLotId"
                     AND claim."status" = 'RESERVED'), 0)
               - COALESCE((SELECT SUM(reservation."reservedUnits") FROM "pharmacy_restock_reservations" reservation
                   WHERE reservation."organizationId" = balance."organizationId"
                     AND reservation."branchId" = balance."branchId"
                     AND reservation."inventoryLotId" = balance."inventoryLotId"
                     AND reservation."stockLocationId" = balance."stockLocationId"
                     AND reservation."status" = 'RESERVED'), 0))::integer AS "availableUnits"
      FROM "pharmacy_stock_balances" balance
      JOIN "pharmacy_inventory_lots" lot
        ON lot."organizationId" = balance."organizationId"
       AND lot."branchId" = balance."branchId" AND lot."id" = balance."inventoryLotId"
      JOIN "pharmacy_manufacturing_batches" batch
        ON batch."organizationId" = lot."organizationId" AND batch."id" = lot."manufacturingBatchId"
      WHERE balance."organizationId" = ${scope.organizationId}
        AND balance."branchId" = ${scope.branchId}
        AND balance."disposition" = 'AVAILABLE'
        AND lot."receivedAt" IS NOT NULL
        AND batch."state" = 'ACTIVE'
        AND batch."expiresAt" > CURRENT_TIMESTAMP
    ), catalog AS (
      SELECT medicine."id" AS "medicineId", medicine."productName", medicine."brandName",
             presentation."id" AS "presentationId", presentation."presentation",
             pack."id" AS "packLevelId", pack."level" AS "packLabel",
             stock."unitsPerPack", stock."printedMrpMinor",
             SUM(stock."availableUnits")::integer AS "availableUnits",
             SUM(SUM(stock."availableUnits")) OVER (
               PARTITION BY medicine."id", presentation."id", pack."id"
             )::integer AS "totalAvailableUnits",
             ROW_NUMBER() OVER (
               PARTITION BY medicine."id", presentation."id", pack."id"
               ORDER BY stock."expiresAt", stock."receivedAt" NULLS FIRST, stock."inventoryLotId"
             ) AS price_rank
      FROM safe_stock stock
      JOIN "pharmacy_medicines" medicine
        ON medicine."organizationId" = ${scope.organizationId} AND medicine."id" = stock."medicineId"
      JOIN "pharmacy_pack_levels" pack
        ON pack."organizationId" = medicine."organizationId" AND pack."id" = stock."packLevelId"
      JOIN "pharmacy_presentations" presentation
        ON presentation."organizationId" = medicine."organizationId" AND presentation."id" = pack."presentationId"
      WHERE stock."availableUnits" > 0
        AND medicine."saleable" AND medicine."otc" AND NOT medicine."rx"
        AND NOT medicine."restricted" AND NOT medicine."controlled"
        AND (${query} = '' OR medicine."productName" ILIKE ${`%${query}%`}
          OR COALESCE(medicine."brandName", '') ILIKE ${`%${query}%`}
          OR presentation."presentation" ILIKE ${`%${query}%`})
      GROUP BY medicine."id", medicine."productName", medicine."brandName",
               presentation."id", presentation."presentation", pack."id", pack."level",
               stock."unitsPerPack", stock."printedMrpMinor", stock."expiresAt",
               stock."receivedAt", stock."inventoryLotId"
    )
    SELECT "medicineId", "productName", "brandName", "presentationId", "presentation",
           "packLevelId", "packLabel", "unitsPerPack", "printedMrpMinor",
           "totalAvailableUnits" AS "availableUnits"
    FROM catalog
    WHERE price_rank = 1 AND "availableUnits" > 0
    ORDER BY "productName", "presentation", "packLabel"
    LIMIT 100
  `);
  return rows.map((row) => ({
    ...row,
    availablePacks: Math.floor(Number(row.availableUnits) / Number(row.unitsPerPack)),
    unitPriceMinor: Number(row.printedMrpMinor),
  }));
}

async function reservationCandidates(
  db: ScopedDb,
  scope: LedgerScope,
  medicineId: string,
  packLevelId: string
) {
  return db.$queryRaw<ReservationCandidate[]>(Prisma.sql`
    SELECT balance."inventoryLotId", balance."stockLocationId", balance."organizationId", balance."branchId",
           batch."state"::text AS "batchState", balance."disposition"::text AS disposition,
           batch."expiresAt", lot."receivedAt", lot."packLevelId", lot."unitsPerPack", lot."printedMrpMinor",
           (balance."onHandUnits"
             - COALESCE((SELECT SUM(claim."reservedUnits") FROM "pharmacy_supplier_claims" claim
                 WHERE claim."organizationId" = balance."organizationId"
                   AND claim."branchId" = balance."branchId"
                   AND claim."inventoryLotId" = balance."inventoryLotId"
                   AND claim."status" = 'RESERVED'), 0)
             - COALESCE((SELECT SUM(reservation."reservedUnits") FROM "pharmacy_restock_reservations" reservation
                 WHERE reservation."organizationId" = balance."organizationId"
                   AND reservation."branchId" = balance."branchId"
                   AND reservation."inventoryLotId" = balance."inventoryLotId"
                   AND reservation."stockLocationId" = balance."stockLocationId"
                   AND reservation."status" = 'RESERVED'), 0))::integer AS "availableUnits"
    FROM "pharmacy_stock_balances" balance
    JOIN "pharmacy_inventory_lots" lot
      ON lot."organizationId" = balance."organizationId"
     AND lot."branchId" = balance."branchId" AND lot."id" = balance."inventoryLotId"
    JOIN "pharmacy_manufacturing_batches" batch
      ON batch."organizationId" = lot."organizationId" AND batch."id" = lot."manufacturingBatchId"
    WHERE balance."organizationId" = ${scope.organizationId}
      AND balance."branchId" = ${scope.branchId}
      AND batch."medicineId" = ${medicineId}
      AND lot."packLevelId" = ${packLevelId}
    ORDER BY batch."expiresAt", lot."receivedAt" NULLS FIRST,
             balance."inventoryLotId", balance."stockLocationId"
    FOR UPDATE OF balance
  `);
}

async function reserveOrderLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    orderId: string;
    orderLineId: string;
    medicineId: string;
    packLevelId: string;
    productName: string;
    saleUnit: 'PACK' | 'STRIP' | 'UNIT';
    requiredUnits: number;
  }
) {
  const candidates = await reservationCandidates(db, scope, input.medicineId, input.packLevelId);
  let plan;
  try {
    plan = planAllocation({
      candidates: candidates.map((candidate) => ({
        ...candidate,
        availableUnits: Number(candidate.availableUnits),
      })),
      requiredUnits: input.requiredUnits,
      scope: { organizationId: scope.organizationId, branchId: scope.branchId, at: new Date() },
    });
  } catch (error) {
    if (error instanceof PharmacyInventoryError) {
      throw new PharmacyCustomerOrderError('INSUFFICIENT_STOCK');
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
        saleUnit: input.saleUnit,
        quantity: allocation.units,
        reason: 'SERVICE_FAILURE',
        inventoryRuleSnapshot: {
          source: 'MKT_ORDER_RESERVATION',
          orderId: input.orderId,
          orderLineId: input.orderLineId,
        },
        capturedByUserId: scope.actorId,
      },
    });
    const interest = await db.pharmacyRestockInterest.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        demandEventId: demand.id,
        orderLineId: input.orderLineId,
        reserveOnArrival: false,
        quantityUnits: allocation.units,
        campaignKey: `order:${input.orderId}`,
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

async function resolveCustomer(
  db: ScopedDb,
  organizationId: string,
  actorUserId: string,
  customerId: string | undefined,
  staff: boolean
) {
  if (customerId && !staff) throw new PharmacyCustomerOrderError('STAFF_ACCESS_REQUIRED');
  const customer = await db.pharmacyCustomer.findFirst({
    where: customerId
      ? { id: customerId, organizationId, active: true }
      : { organizationId, userId: actorUserId, active: true },
  });
  if (!customer) {
    throw new PharmacyCustomerOrderError(
      customerId ? 'CUSTOMER_NOT_FOUND' : 'CUSTOMER_ACCOUNT_REQUIRED'
    );
  }
  return customer;
}

export async function placeCustomerOrder(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    customerId?: string;
    staff: boolean;
    fulfillment: CustomerOrderFulfillment;
    intendedPaymentMethod: 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'WALLET' | 'CREDIT';
    addressLine?: string;
    city?: string;
    deliveryInstructions?: string;
    reservationMinutes?: number;
    lines: Array<{
      medicineId: string;
      presentationId: string;
      packLevelId: string;
      saleUnit: 'PACK';
      quantity: number;
    }>;
  }
) {
  await activateBranchScope(db, scope);
  const customer = await resolveCustomer(
    db,
    scope.organizationId,
    scope.actorId,
    input.customerId,
    input.staff
  );
  const addressLine = input.addressLine?.trim();
  const city = input.city?.trim();
  if (
    (input.fulfillment === 'DELIVER' && (!addressLine || !city)) ||
    (input.fulfillment === 'COLLECT' && (addressLine || city || input.deliveryInstructions))
  ) {
    throw new PharmacyCustomerOrderError('INVALID_FULFILLMENT');
  }
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
  });
  if (!branch) throw new PharmacyCustomerOrderError('ORDER_NOT_FOUND');

  const order = await db.pharmacyCustomerOrder.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: customer.id,
      placedByUserId: scope.actorId,
      fulfillment: input.fulfillment,
      intendedPaymentMethod: input.intendedPaymentMethod,
      addressLine: input.fulfillment === 'DELIVER' ? addressLine : null,
      city: input.fulfillment === 'DELIVER' ? city : null,
      deliveryInstructions:
        input.fulfillment === 'DELIVER' ? input.deliveryInstructions?.trim() || null : null,
      reservationExpiresAt: new Date(
        Date.now() + Math.min(Math.max(input.reservationMinutes ?? 30, 5), 120) * 60_000
      ),
    },
  });

  for (const inputLine of input.lines) {
    const medicine = await db.medicine.findFirst({
      where: {
        id: inputLine.medicineId,
        organizationId: scope.organizationId,
      },
      include: {
        presentations: {
          where: { id: inputLine.presentationId },
          include: { packLevels: { where: { id: inputLine.packLevelId } } },
        },
      },
    });
    if (
      !medicine ||
      !isCustomerOrderableMedicine(medicine) ||
      medicine.presentations[0]?.packLevels.length !== 1
    ) {
      throw new PharmacyCustomerOrderError('ITEM_NOT_ORDERABLE');
    }
    if (
      !Number.isSafeInteger(inputLine.quantity) ||
      inputLine.quantity <= 0 ||
      inputLine.saleUnit !== 'PACK'
    ) {
      throw new PharmacyCustomerOrderError('ITEM_NOT_ORDERABLE');
    }
    const candidates = await reservationCandidates(
      db,
      scope,
      inputLine.medicineId,
      inputLine.packLevelId
    );
    const firstLot = candidates.find(
      (candidate) => candidate.packLevelId === inputLine.packLevelId && candidate.availableUnits > 0
    );
    if (!firstLot) throw new PharmacyCustomerOrderError('INSUFFICIENT_STOCK');
    const canonicalUnitsPerSaleUnit = Number(firstLot.unitsPerPack);
    if (!Number.isSafeInteger(canonicalUnitsPerSaleUnit) || canonicalUnitsPerSaleUnit <= 0) {
      throw new PharmacyCustomerOrderError('ITEM_NOT_ORDERABLE');
    }
    const requiredUnits = inputLine.quantity * canonicalUnitsPerSaleUnit;
    if (!Number.isSafeInteger(requiredUnits)) {
      throw new PharmacyCustomerOrderError('ITEM_NOT_ORDERABLE');
    }
    const pricing = priceFromLot({
      printedMrpMinor: Number(firstLot.printedMrpMinor),
      canonicalUnitsInPack: Number(firstLot.unitsPerPack),
      canonicalUnitsPerSaleUnit,
    });
    const line = await db.pharmacyCustomerOrderLine.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        orderId: order.id,
        ...inputLine,
        canonicalUnitsPerSaleUnit,
        canonicalUnits: requiredUnits,
        unitPriceMinor: pricing.unitPriceMinor,
        lineTotalMinor: pricing.unitPriceMinor * inputLine.quantity,
      },
    });
    await reserveOrderLine(db, scope, {
      orderId: order.id,
      orderLineId: line.id,
      medicineId: line.medicineId,
      packLevelId: line.packLevelId,
      productName: medicine.productName,
      saleUnit: line.saleUnit,
      requiredUnits,
    });
  }
  await appendOrderEvent(db, scope, order.id, 'PLACED', null, 'PROPOSED');
  return readOrder(db, scope.organizationId, order.id);
}

const orderInclude = {
  branch: { select: { id: true, name: true, city: true } },
  customer: { select: { id: true, displayName: true, phoneLast4: true } },
  runner: { select: { id: true, name: true } },
  lines: {
    include: { medicine: { select: { productName: true, brandName: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
  events: { orderBy: { occurredAt: 'asc' as const } },
  deliveryEvidence: {
    select: { id: true, action: true, occurredAt: true, amountMinor: true },
    orderBy: [{ occurredAt: 'asc' as const }, { id: 'asc' as const }],
  },
} satisfies Prisma.PharmacyCustomerOrderInclude;

async function readOrder(db: ScopedDb, organizationId: string, orderId: string) {
  return db.pharmacyCustomerOrder.findFirst({
    where: { id: orderId, organizationId },
    include: orderInclude,
  });
}

export async function listMyCustomerOrders(db: ScopedDb, organizationId: string, userId: string) {
  const customer = await db.pharmacyCustomer.findFirst({
    where: { organizationId, userId, active: true },
    select: { id: true },
  });
  if (!customer) return [];
  return db.pharmacyCustomerOrder.findMany({
    where: { organizationId, customerId: customer.id },
    include: orderInclude,
    orderBy: { createdAt: 'desc' },
  });
}

export async function listStaffCustomerOrders(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>
) {
  await activateBranchScope(db, scope);
  return db.pharmacyCustomerOrder.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
    include: orderInclude,
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
  });
}

async function appendOrderEvent(
  db: ScopedDb,
  scope: LedgerScope,
  orderId: string,
  kind: Parameters<typeof db.pharmacyCustomerOrderEvent.create>[0]['data']['kind'],
  fromStatus: CustomerOrderStatus | null,
  toStatus: CustomerOrderStatus,
  detail?: Prisma.InputJsonValue
) {
  return db.pharmacyCustomerOrderEvent.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      orderId,
      kind,
      fromStatus,
      toStatus,
      actorUserId: scope.actorId,
      detail,
    },
  });
}

export async function releaseOrderReservations(db: ScopedDb, scope: LedgerScope, orderId: string) {
  const at = new Date();
  const interests = await db.pharmacyRestockInterest.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      orderLine: { orderId },
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
    data: { status: 'RELEASED', settledAt: at },
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

export async function cancelMyCustomerOrder(db: ScopedDb, scope: LedgerScope, orderId: string) {
  await activateBranchScope(db, scope);
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM "pharmacy_customer_orders" WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${orderId} FOR UPDATE`
  );
  const customer = await db.pharmacyCustomer.findFirst({
    where: { organizationId: scope.organizationId, userId: scope.actorId, active: true },
    select: { id: true },
  });
  if (!customer) throw new PharmacyCustomerOrderError('CUSTOMER_NOT_FOUND');
  const order = await db.pharmacyCustomerOrder.findFirst({
    where: {
      id: orderId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: customer.id,
    },
  });
  if (!order) throw new PharmacyCustomerOrderError('ORDER_NOT_FOUND');
  if (order.status !== 'PROPOSED' || order.counterSaleId) {
    throw new PharmacyCustomerOrderError('INVALID_STATE');
  }
  await releaseOrderReservations(db, scope, order.id);
  const cancelledAt = new Date();
  await db.pharmacyCustomerOrder.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: order.id } },
    data: { status: 'CANCELLED', cancelledAt },
  });
  await appendOrderEvent(db, scope, order.id, 'CANCELLED', 'PROPOSED', 'CANCELLED');
  return readOrder(db, scope.organizationId, order.id);
}

const STAFF_TRANSITIONS = {
  accept: { from: 'PROPOSED', to: 'ACCEPTED', kind: 'ACCEPTED', at: 'acceptedAt' },
  pack: { from: 'ACCEPTED', to: 'PACKING', kind: 'PACKING_STARTED', at: 'packedAt' },
  ready: {
    from: 'PACKING',
    to: 'READY_FOR_COLLECTION',
    kind: 'READY_FOR_COLLECTION',
    at: 'readyAt',
  },
  dispatch: {
    from: 'PACKING',
    to: 'OUT_FOR_DELIVERY',
    kind: 'OUT_FOR_DELIVERY',
    at: 'outForDeliveryAt',
  },
} as const;

// Runs inside the caller's transaction, after locking the order. Revalidate the
// held lots themselves: selecting a fresh FEFO plan could silently swap stock.
async function revalidateOrderReservations(db: ScopedDb, scope: LedgerScope, orderId: string) {
  const lines = await db.pharmacyCustomerOrderLine.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, orderId },
    select: { id: true, canonicalUnits: true },
  });
  const query = Prisma.sql`
    /* handoff_reservations */
    SELECT interest."orderLineId", reservation."reservedUnits",
           balance."inventoryLotId", balance."stockLocationId",
           balance."organizationId", balance."branchId",
           balance."disposition"::text AS disposition, batch."state"::text AS "batchState",
           batch."expiresAt", lot."receivedAt",
           medicine.saleable, medicine.otc, medicine.rx, medicine.restricted, medicine.controlled,
           (balance."onHandUnits" - COALESCE((
             SELECT SUM(other."reservedUnits") FROM "pharmacy_restock_reservations" other
             WHERE other."organizationId" = balance."organizationId"
               AND other."branchId" = balance."branchId"
               AND other."inventoryLotId" = balance."inventoryLotId"
               AND other."stockLocationId" = balance."stockLocationId"
               AND other.status = 'RESERVED' AND other.id <> reservation.id
           ), 0) - COALESCE((
             SELECT SUM(claim."reservedUnits") FROM "pharmacy_supplier_claims" claim
             WHERE claim."organizationId" = balance."organizationId"
               AND claim."branchId" = balance."branchId"
               AND claim."inventoryLotId" = balance."inventoryLotId"
               AND claim.status = 'RESERVED'
           ), 0))::integer AS "availableUnits"
    FROM "pharmacy_restock_reservations" reservation
    JOIN "pharmacy_restock_interests" interest
      ON interest."organizationId" = reservation."organizationId"
     AND interest."branchId" = reservation."branchId" AND interest.id = reservation."interestId"
    JOIN "pharmacy_customer_order_lines" line
      ON line."organizationId" = interest."organizationId"
     AND line."branchId" = interest."branchId" AND line.id = interest."orderLineId"
    JOIN "pharmacy_stock_balances" balance
      ON balance."organizationId" = reservation."organizationId"
     AND balance."branchId" = reservation."branchId"
     AND balance."inventoryLotId" = reservation."inventoryLotId"
     AND balance."stockLocationId" = reservation."stockLocationId"
     AND balance.disposition = 'AVAILABLE'
    JOIN "pharmacy_inventory_lots" lot
      ON lot."organizationId" = balance."organizationId"
     AND lot."branchId" = balance."branchId" AND lot.id = balance."inventoryLotId"
     AND lot."packLevelId" = line."packLevelId"
    JOIN "pharmacy_manufacturing_batches" batch
      ON batch."organizationId" = lot."organizationId" AND batch.id = lot."manufacturingBatchId"
     AND batch."medicineId" = line."medicineId"
    JOIN "pharmacy_medicines" medicine
      ON medicine."organizationId" = batch."organizationId" AND medicine.id = batch."medicineId"
    WHERE reservation."organizationId" = ${scope.organizationId}
      AND reservation."branchId" = ${scope.branchId} AND line."orderId" = ${orderId}
      AND reservation.status = 'RESERVED'
    ORDER BY batch.id, lot.id, balance."stockLocationId", reservation.id
  `;
  await db.$queryRaw(Prisma.sql`${query} FOR UPDATE OF batch, medicine, lot, balance, reservation`);
  // Read again after any lock wait so reservation/claim totals use a fresh
  // READ COMMITTED snapshot; competing stock writers also lock the balance.
  const reservations = await db.$queryRaw<
    (ReservationCandidate &
      Parameters<typeof isCustomerOrderableMedicine>[0] & {
        orderLineId: string;
        reservedUnits: number;
      })[]
  >(query);
  const at = new Date();
  const coverage = new Map<string, number>();
  for (const reservation of reservations) {
    if (
      !isCustomerOrderableMedicine(reservation) ||
      blockReasonFor(reservation, { ...scope, at }) ||
      !Number.isSafeInteger(reservation.reservedUnits) ||
      reservation.reservedUnits <= 0 ||
      reservation.availableUnits < reservation.reservedUnits
    ) {
      throw new PharmacyCustomerOrderError('RESERVATION_UNAVAILABLE');
    }
    coverage.set(
      reservation.orderLineId,
      (coverage.get(reservation.orderLineId) ?? 0) + reservation.reservedUnits
    );
  }
  if (
    lines.length === 0 ||
    coverage.size !== lines.length ||
    lines.some((line) => coverage.get(line.id) !== line.canonicalUnits)
  ) {
    throw new PharmacyCustomerOrderError('RESERVATION_UNAVAILABLE');
  }
  return reservations;
}

export async function transitionCustomerOrder(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    orderId: string;
    action: keyof typeof STAFF_TRANSITIONS | 'cancel' | 'expire';
    runnerUserId?: string;
  }
) {
  await activateBranchScope(db, scope);
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM "pharmacy_customer_orders" WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${input.orderId} FOR UPDATE`
  );
  const order = await db.pharmacyCustomerOrder.findFirst({
    where: { id: input.orderId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!order) throw new PharmacyCustomerOrderError('ORDER_NOT_FOUND');
  if (input.action === 'cancel' || input.action === 'expire') {
    if (
      !isCustomerOrderReleaseEligible(order.status as CustomerOrderStatus) ||
      order.counterSaleId ||
      (input.action === 'expire' && order.reservationExpiresAt.getTime() > Date.now())
    ) {
      throw new PharmacyCustomerOrderError('INVALID_STATE');
    }
    await releaseOrderReservations(db, scope, order.id);
    const at = new Date();
    const to = input.action === 'cancel' ? 'CANCELLED' : 'EXPIRED';
    await db.pharmacyCustomerOrder.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: order.id } },
      data:
        input.action === 'cancel' ? { status: to, cancelledAt: at } : { status: to, expiredAt: at },
    });
    await appendOrderEvent(db, scope, order.id, to, order.status as CustomerOrderStatus, to);
    return readOrder(db, scope.organizationId, order.id);
  }
  const transition = STAFF_TRANSITIONS[input.action];
  if (order.status !== transition.from) throw new PharmacyCustomerOrderError('INVALID_STATE');
  if (input.action === 'ready' && order.fulfillment !== 'COLLECT') {
    throw new PharmacyCustomerOrderError('INVALID_FULFILLMENT');
  }
  if (input.action === 'dispatch') {
    if (order.fulfillment !== 'DELIVER') {
      throw new PharmacyCustomerOrderError('INVALID_FULFILLMENT');
    }
    if (!input.runnerUserId) throw new PharmacyCustomerOrderError('RUNNER_REQUIRED');
    const runner = await db.user.findFirst({
      where: {
        id: input.runnerUserId,
        organizationId: scope.organizationId,
        organizationRoleId: { not: null },
        status: 'ACTIVE',
      },
    });
    if (!runner) throw new PharmacyCustomerOrderError('RUNNER_REQUIRED');
  }
  if (input.action === 'ready' || input.action === 'dispatch') {
    if (order.reservationExpiresAt.getTime() <= Date.now()) {
      throw new PharmacyCustomerOrderError('RESERVATION_UNAVAILABLE');
    }
    await revalidateOrderReservations(db, scope, order.id);
    if (order.reservationExpiresAt.getTime() <= Date.now()) {
      throw new PharmacyCustomerOrderError('RESERVATION_UNAVAILABLE');
    }
  }
  const at = new Date();
  await db.pharmacyCustomerOrder.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: order.id } },
    data: {
      status: transition.to,
      [transition.at]: at,
      runnerUserId: input.action === 'dispatch' ? input.runnerUserId : undefined,
    },
  });
  await appendOrderEvent(db, scope, order.id, transition.kind, transition.from, transition.to);
  return readOrder(db, scope.organizationId, order.id);
}

export async function startCustomerOrderCheckout(
  db: ScopedDb,
  scope: LedgerScope,
  orderId: string
) {
  await activateBranchScope(db, scope);
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM "pharmacy_customer_orders" WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${orderId} FOR UPDATE`
  );
  const order = await db.pharmacyCustomerOrder.findFirst({
    where: { id: orderId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: {
      lines: { orderBy: { createdAt: 'asc' } },
      deliveryEvidence: { select: { action: true } },
    },
  });
  if (!order) throw new PharmacyCustomerOrderError('ORDER_NOT_FOUND');
  if (!['READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY'].includes(order.status)) {
    throw new PharmacyCustomerOrderError('INVALID_STATE');
  }
  if (
    order.deliveryEvidence?.some((row) =>
      ['REFUSED', 'FAILED', 'PHYSICAL_RETURN'].includes(row.action)
    )
  )
    throw new PharmacyCustomerOrderError('INVALID_STATE');
  if (order.counterSaleId) return { saleId: order.counterSaleId, replayed: true };
  const reservations = await revalidateOrderReservations(db, scope, order.id);
  if (
    isCustomerOrderReservationDeadlineEnforced(order.status as CustomerOrderStatus) &&
    order.reservationExpiresAt.getTime() <= Date.now()
  ) {
    throw new PharmacyCustomerOrderError('RESERVATION_UNAVAILABLE');
  }
  await releaseOrderReservations(db, scope, order.id);
  const sale = await createSale(db, scope);
  await db.pharmacySale.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: sale.id } },
    data: { customerId: order.customerId },
  });
  for (const line of order.lines) {
    await addReservedSaleLine(
      db,
      scope,
      {
        saleId: sale.id,
        medicineId: line.medicineId,
        presentationId: line.presentationId,
        packLevelId: line.packLevelId,
        saleUnit: line.saleUnit,
        quantity: line.quantity,
        canonicalUnitsPerSaleUnit: line.canonicalUnitsPerSaleUnit,
        idempotencyKey: `customer-order:${order.id}:${line.id}`,
      },
      {
        // Handoff confirms that this stock remains committed to the order; the
        // proposal deadline no longer invalidates checkout after that point.
        expiresAt: null,
        allocations: reservations
          .filter((row) => row.orderLineId === line.id)
          .map((row) => ({
            inventoryLotId: row.inventoryLotId,
            stockLocationId: row.stockLocationId,
            units: row.reservedUnits,
          })),
      }
    );
  }
  await db.pharmacyCustomerOrder.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: order.id } },
    data: { counterSaleId: sale.id },
  });
  await appendOrderEvent(
    db,
    scope,
    order.id,
    'CHECKOUT_STARTED',
    order.status as CustomerOrderStatus,
    order.status as CustomerOrderStatus,
    { saleId: sale.id, intendedPaymentMethod: order.intendedPaymentMethod }
  );
  return { saleId: sale.id, replayed: false };
}

export async function completeCustomerOrder(db: ScopedDb, scope: LedgerScope, orderId: string) {
  await activateBranchScope(db, scope);
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM "pharmacy_customer_orders" WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${orderId} FOR UPDATE`
  );
  const order = await db.pharmacyCustomerOrder.findFirst({
    where: { id: orderId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { counterSale: { include: { lines: true } }, deliveryEvidence: true },
  });
  if (!order) throw new PharmacyCustomerOrderError('ORDER_NOT_FOUND');
  if (
    order.deliveryEvidence?.some((row) =>
      ['REFUSED', 'FAILED', 'PHYSICAL_RETURN'].includes(row.action)
    ) ||
    !['READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY'].includes(order.status) ||
    !order.counterSale ||
    order.counterSale.status !== 'COMPLETED'
  ) {
    throw new PharmacyCustomerOrderError('SALE_NOT_COMPLETED');
  }
  if (order.fulfillment === 'DELIVER' && order.intendedPaymentMethod === 'CASH') {
    const cash = deliveryTotals(order.deliveryEvidence);
    if (cash.custodyMinor !== 0 || cash.remittedMinor !== saleTotalMinor(order.counterSale.lines))
      throw new PharmacyCustomerOrderError('SALE_NOT_COMPLETED');
  }
  const completedAt = new Date();
  await db.pharmacyCustomerOrder.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: order.id } },
    data: { status: 'COMPLETED', completedAt },
  });
  await appendOrderEvent(
    db,
    scope,
    order.id,
    'COMPLETED',
    order.status as CustomerOrderStatus,
    'COMPLETED',
    { saleId: order.counterSale.id }
  );
  return readOrder(db, scope.organizationId, order.id);
}
