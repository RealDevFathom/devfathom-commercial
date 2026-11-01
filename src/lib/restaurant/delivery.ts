import 'server-only';

import { createHash } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { RestaurantDeliveryFulfillmentStatus } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type DeliveryErrorReason =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INACTIVE_ZONE'
  | 'MINIMUM_SUBTOTAL'
  | 'INCONSISTENT_SCOPE'
  | 'ALREADY_EXISTS'
  | 'INVALID_TRANSITION';

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly reason: DeliveryErrorReason
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

const PHONE = /^\+[1-9]\d{6,14}$/;
const COUNTRY = /^[A-Z]{2}$/;
type DecimalInput = Prisma.Decimal | string;
const required = (value: string, field: string) => {
  const result = value.trim();
  if (!result) throw new DeliveryError(`${field} is required.`, 'INVALID_INPUT');
  return result;
};

export function normalizeDeliveryPhone(value: string): string {
  const normalized = value.trim().replace(/[\s().-]/g, '');
  if (!PHONE.test(normalized)) {
    throw new DeliveryError('Phone must normalize to E.164 format.', 'INVALID_INPUT');
  }
  return normalized;
}

function nonNegativeMoney(value: DecimalInput, field: string) {
  const decimal = new Prisma.Decimal(value);
  if (!decimal.isFinite() || decimal.isNegative() || decimal.decimalPlaces() > 2) {
    throw new DeliveryError(`${field} must be non-negative money.`, 'INVALID_INPUT');
  }
  return decimal;
}

function nonNegativeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DeliveryError(`${field} must be a non-negative integer.`, 'INVALID_INPUT');
  }
  return value;
}

function transaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

const ZONE_ORDER = [
  { sortOrder: 'asc' as const },
  { name: 'asc' as const },
  { id: 'asc' as const },
];

export function listDeliveryZones(db: ScopedDb, organizationId: string, branchId: string) {
  return db.restaurantDeliveryZone.findMany({
    where: { organizationId, branchId },
    orderBy: ZONE_ORDER,
  });
}

export type DeliveryZoneInput = {
  name: string;
  fixedFee: DecimalInput;
  minimumSubtotal?: DecimalInput;
  promisedMinutes: number;
  sortOrder?: number;
  areaPostalLabel?: string | null;
};

function zoneData(input: DeliveryZoneInput) {
  return {
    name: required(input.name, 'Zone name'),
    fixedFee: nonNegativeMoney(input.fixedFee, 'Fixed fee'),
    minimumSubtotal: nonNegativeMoney(input.minimumSubtotal ?? '0', 'Minimum subtotal'),
    promisedMinutes: nonNegativeInteger(input.promisedMinutes, 'Promised minutes'),
    sortOrder: nonNegativeInteger(input.sortOrder ?? 0, 'Sort order'),
    areaPostalLabel: input.areaPostalLabel?.trim() || null,
  };
}

export function createDeliveryZone(
  db: ScopedDb,
  input: DeliveryZoneInput & { organizationId: string; branchId: string }
) {
  const { organizationId, branchId, ...values } = input;
  return db.restaurantDeliveryZone.create({
    data: { organizationId, branchId, ...zoneData(values) },
  });
}

export async function updateDeliveryZone(
  db: ScopedDb,
  input: DeliveryZoneInput & { organizationId: string; branchId: string; zoneId: string }
) {
  const { organizationId, branchId, zoneId, ...values } = input;
  const changed = await db.restaurantDeliveryZone.updateMany({
    where: { id: zoneId, organizationId, branchId },
    data: zoneData(values),
  });
  if (changed.count !== 1) throw new DeliveryError('Delivery zone does not exist.', 'NOT_FOUND');
  return db.restaurantDeliveryZone.findFirstOrThrow({
    where: { id: zoneId, organizationId, branchId },
  });
}

export async function deactivateDeliveryZone(
  db: ScopedDb,
  input: { organizationId: string; branchId: string; zoneId: string }
) {
  const changed = await db.restaurantDeliveryZone.updateMany({
    where: { id: input.zoneId, organizationId: input.organizationId, branchId: input.branchId },
    data: { active: false },
  });
  if (changed.count !== 1) throw new DeliveryError('Delivery zone does not exist.', 'NOT_FOUND');
}

export async function reactivateDeliveryZone(
  db: ScopedDb,
  input: { organizationId: string; branchId: string; zoneId: string }
) {
  const changed = await db.restaurantDeliveryZone.updateMany({
    where: { id: input.zoneId, organizationId: input.organizationId, branchId: input.branchId },
    data: { active: true },
  });
  if (changed.count !== 1) throw new DeliveryError('Delivery zone does not exist.', 'NOT_FOUND');
}

export async function quoteDeliveryZone(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    zoneId: string;
    subtotal: DecimalInput;
  }
) {
  const zone = await db.restaurantDeliveryZone.findFirst({
    where: {
      id: input.zoneId,
      organizationId: input.organizationId,
      branchId: input.branchId,
      active: true,
    },
  });
  if (!zone) throw new DeliveryError('Active delivery zone does not exist.', 'INACTIVE_ZONE');
  const subtotal = nonNegativeMoney(input.subtotal, 'Subtotal');
  if (subtotal.lessThan(zone.minimumSubtotal)) {
    throw new DeliveryError(
      'Order does not meet the delivery minimum subtotal.',
      'MINIMUM_SUBTOTAL'
    );
  }
  return {
    zoneId: zone.id,
    zoneName: zone.name,
    areaPostalLabel: zone.areaPostalLabel,
    fixedFee: zone.fixedFee,
    minimumSubtotal: zone.minimumSubtotal,
    promisedMinutes: zone.promisedMinutes,
  };
}

export type DeliveryAddressInput = {
  label: string;
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string | null;
  locality: string;
  administrativeArea?: string | null;
  postalCode?: string | null;
  countryCode: string;
  latitude?: DecimalInput | null;
  longitude?: DecimalInput | null;
  isDefault?: boolean;
};

function addressData(input: DeliveryAddressInput) {
  const countryCode = input.countryCode.trim().toUpperCase();
  if (!COUNTRY.test(countryCode))
    throw new DeliveryError('Country code must be ISO alpha-2.', 'INVALID_INPUT');
  const latitude = input.latitude == null ? null : new Prisma.Decimal(input.latitude);
  const longitude = input.longitude == null ? null : new Prisma.Decimal(input.longitude);
  if (
    (latitude === null) !== (longitude === null) ||
    latitude?.lessThan(-90) ||
    latitude?.greaterThan(90) ||
    longitude?.lessThan(-180) ||
    longitude?.greaterThan(180)
  ) {
    throw new DeliveryError('Coordinates must be a valid pair.', 'INVALID_INPUT');
  }
  return {
    label: required(input.label, 'Address label'),
    recipientName: required(input.recipientName, 'Recipient name'),
    normalizedPhone: normalizeDeliveryPhone(input.phone),
    addressLine1: required(input.addressLine1, 'Address line 1'),
    addressLine2: input.addressLine2?.trim() || null,
    locality: required(input.locality, 'Locality'),
    administrativeArea: input.administrativeArea?.trim() || null,
    postalCode: input.postalCode?.trim() || null,
    countryCode,
    latitude,
    longitude,
  };
}

export function listDeliveryAddresses(db: ScopedDb, organizationId: string, customerId: string) {
  return db.restaurantCustomerAddress.findMany({
    where: { organizationId, customerId, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
}

async function lockCustomer(tx: ScopedDb, organizationId: string, customerId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "restaurant_customers" WHERE "organizationId" = ${organizationId} AND "id" = ${customerId} AND "anonymizedAt" IS NULL FOR UPDATE`
  );
  if (rows.length !== 1) throw new DeliveryError('Customer does not exist.', 'NOT_FOUND');
}

export function createDeliveryAddress(
  db: ScopedDb,
  input: DeliveryAddressInput & { organizationId: string; customerId: string }
) {
  return transaction(db, async (tx) => {
    await lockCustomer(tx, input.organizationId, input.customerId);
    const count = await tx.restaurantCustomerAddress.count({
      where: {
        organizationId: input.organizationId,
        customerId: input.customerId,
        deletedAt: null,
      },
    });
    const makeDefault = input.isDefault === true || count === 0;
    if (makeDefault)
      await tx.restaurantCustomerAddress.updateMany({
        where: {
          organizationId: input.organizationId,
          customerId: input.customerId,
          deletedAt: null,
          isDefault: true,
        },
        data: { isDefault: false },
      });
    return tx.restaurantCustomerAddress.create({
      data: {
        organizationId: input.organizationId,
        customerId: input.customerId,
        ...addressData(input),
        isDefault: makeDefault,
      },
    });
  });
}

export function updateDeliveryAddress(
  db: ScopedDb,
  input: DeliveryAddressInput & { organizationId: string; customerId: string; addressId: string }
) {
  return transaction(db, async (tx) => {
    await lockCustomer(tx, input.organizationId, input.customerId);
    if (input.isDefault)
      await tx.restaurantCustomerAddress.updateMany({
        where: {
          organizationId: input.organizationId,
          customerId: input.customerId,
          deletedAt: null,
          isDefault: true,
        },
        data: { isDefault: false },
      });
    const changed = await tx.restaurantCustomerAddress.updateMany({
      where: {
        id: input.addressId,
        organizationId: input.organizationId,
        customerId: input.customerId,
        deletedAt: null,
      },
      data: {
        ...addressData(input),
        ...(input.isDefault === true ? { isDefault: true } : {}),
      },
    });
    if (changed.count !== 1)
      throw new DeliveryError('Delivery address does not exist.', 'NOT_FOUND');
    return tx.restaurantCustomerAddress.findFirstOrThrow({
      where: {
        id: input.addressId,
        organizationId: input.organizationId,
        customerId: input.customerId,
        deletedAt: null,
      },
    });
  });
}

export function setDefaultDeliveryAddress(
  db: ScopedDb,
  input: { organizationId: string; customerId: string; addressId: string }
) {
  return transaction(db, async (tx) => {
    await lockCustomer(tx, input.organizationId, input.customerId);
    const exists = await tx.restaurantCustomerAddress.findFirst({
      where: {
        id: input.addressId,
        organizationId: input.organizationId,
        customerId: input.customerId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!exists) throw new DeliveryError('Delivery address does not exist.', 'NOT_FOUND');
    await tx.restaurantCustomerAddress.updateMany({
      where: {
        organizationId: input.organizationId,
        customerId: input.customerId,
        deletedAt: null,
        isDefault: true,
      },
      data: { isDefault: false },
    });
    return tx.restaurantCustomerAddress.update({
      where: { id: input.addressId },
      data: { isDefault: true },
    });
  });
}

export function deleteDeliveryAddress(
  db: ScopedDb,
  input: { organizationId: string; customerId: string; addressId: string; now?: Date }
) {
  return transaction(db, async (tx) => {
    await lockCustomer(tx, input.organizationId, input.customerId);
    const address = await tx.restaurantCustomerAddress.findFirst({
      where: {
        id: input.addressId,
        organizationId: input.organizationId,
        customerId: input.customerId,
        deletedAt: null,
      },
    });
    if (!address) throw new DeliveryError('Delivery address does not exist.', 'NOT_FOUND');
    await tx.restaurantCustomerAddress.update({
      where: { id: address.id },
      data: { deletedAt: input.now ?? new Date(), isDefault: false },
    });
    if (address.isDefault) {
      const next = await tx.restaurantCustomerAddress.findFirst({
        where: {
          organizationId: input.organizationId,
          customerId: input.customerId,
          deletedAt: null,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      if (next)
        await tx.restaurantCustomerAddress.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
    }
  });
}

export function createDeliveryFulfillment(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    customerId: string;
    orderId: string;
    addressId: string;
    zoneId: string;
    instructions?: string | null;
    deviceId: string;
    idempotencyKey: string;
    now?: Date;
  }
) {
  return transaction(db, async (tx) => {
    const canonicalPayload = JSON.stringify({
      orderId: input.orderId,
      customerId: input.customerId,
      addressId: input.addressId,
      zoneId: input.zoneId,
      instructions: input.instructions?.trim() || null,
    });
    const commandType = `delivery.attach:v1:${createHash('sha256')
      .update(canonicalPayload, 'utf8')
      .digest('hex')}`;
    const replay = await tx.restaurantOrderIdempotencyKey.findUnique({
      where: { deviceId_key: { deviceId: input.deviceId, key: input.idempotencyKey } },
      select: { commandType: true, resultRef: true },
    });
    if (replay) {
      if (replay.commandType !== commandType || !replay.resultRef) {
        throw new DeliveryError(
          'Idempotency key was already used for another command.',
          'INVALID_INPUT'
        );
      }
      const fulfillment = await tx.restaurantDeliveryFulfillment.findFirst({
        where: {
          id: replay.resultRef,
          organizationId: input.organizationId,
          branchId: input.branchId,
          orderId: input.orderId,
        },
      });
      if (!fulfillment)
        throw new DeliveryError(
          'Delivery fulfillment replay is unavailable.',
          'INCONSISTENT_SCOPE'
        );
      return fulfillment;
    }
    await tx.restaurantOrderIdempotencyKey.create({
      data: {
        deviceId: input.deviceId,
        key: input.idempotencyKey,
        commandType,
      },
    });
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "restaurant_orders" WHERE "id" = ${input.orderId} AND "organizationId" = ${input.organizationId} AND "branchId" = ${input.branchId} FOR UPDATE`
    );
    const order = await tx.restaurantOrder.findFirst({
      where: {
        id: input.orderId,
        organizationId: input.organizationId,
        branchId: input.branchId,
        customerId: input.customerId,
        channel: 'DELIVERY',
        status: 'OPEN',
      },
      select: {
        id: true,
        status: true,
        items: {
          where: { status: { not: 'VOIDED' } },
          select: { unitPrice: true, quantity: true, modifiers: { select: { priceDelta: true } } },
        },
        bills: {
          where: { status: { not: 'VOID' } },
          select: { id: true, tenders: { select: { id: true } } },
        },
      },
    });
    if (!order)
      throw new DeliveryError('Delivery order scope is inconsistent.', 'INCONSISTENT_SCOPE');
    if (order.items.length === 0)
      throw new DeliveryError('Delivery order must contain items before attach.', 'INVALID_INPUT');
    if (order.bills.length > 0 || order.bills.some((bill) => bill.tenders.length > 0))
      throw new DeliveryError(
        'Delivery must be attached before any bill or tender.',
        'INVALID_TRANSITION'
      );
    const address = await tx.restaurantCustomerAddress.findFirst({
      where: {
        id: input.addressId,
        organizationId: input.organizationId,
        customerId: input.customerId,
        deletedAt: null,
      },
    });
    if (!address)
      throw new DeliveryError('Delivery address scope is inconsistent.', 'INCONSISTENT_SCOPE');
    const subtotal = order.items.reduce(
      (sum, item) =>
        sum.plus(
          item.unitPrice
            .plus(item.modifiers.reduce((s, m) => s.plus(m.priceDelta), new Prisma.Decimal(0)))
            .times(item.quantity)
        ),
      new Prisma.Decimal(0)
    );
    const zone = await quoteDeliveryZone(tx, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      zoneId: input.zoneId,
      subtotal,
    });
    const now = input.now ?? new Date();
    try {
      const fulfillment = await tx.restaurantDeliveryFulfillment.create({
        data: {
          organizationId: input.organizationId,
          branchId: input.branchId,
          customerId: input.customerId,
          orderId: input.orderId,
          paymentMode: null,
          recipientNameSnapshot: address.recipientName,
          normalizedPhoneSnapshot: address.normalizedPhone,
          addressLine1Snapshot: address.addressLine1,
          addressLine2Snapshot: address.addressLine2,
          localitySnapshot: address.locality,
          administrativeAreaSnapshot: address.administrativeArea,
          postalCodeSnapshot: address.postalCode,
          countryCodeSnapshot: address.countryCode,
          latitudeSnapshot: address.latitude,
          longitudeSnapshot: address.longitude,
          zoneIdSnapshot: zone.zoneId,
          zoneNameSnapshot: zone.zoneName,
          zoneAreaPostalLabelSnapshot: zone.areaPostalLabel,
          deliveryFeeSnapshot: zone.fixedFee,
          deliveryTaxSnapshot: 0,
          promisedMinutesSnapshot: zone.promisedMinutes,
          promisedAt: new Date(now.getTime() + zone.promisedMinutes * 60_000),
          instructions: input.instructions?.trim() || null,
        },
      });
      await tx.restaurantOrderIdempotencyKey.update({
        where: { deviceId_key: { deviceId: input.deviceId, key: input.idempotencyKey } },
        data: { resultRef: fulfillment.id },
      });
      return fulfillment;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new DeliveryError('Order already has a delivery fulfillment.', 'ALREADY_EXISTS');
      throw error;
    }
  });
}

const ALLOWED: Record<
  RestaurantDeliveryFulfillmentStatus,
  readonly RestaurantDeliveryFulfillmentStatus[]
> = {
  PENDING: ['DISPATCHED', 'CANCELLED', 'FAILED'],
  DISPATCHED: ['DELIVERED', 'CANCELLED', 'FAILED'],
  DELIVERED: [],
  CANCELLED: [],
  FAILED: [],
};
export function transitionDeliveryFulfillment(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    fulfillmentId: string;
    status: Exclude<RestaurantDeliveryFulfillmentStatus, 'PENDING'>;
    now?: Date;
  }
) {
  return transaction(db, async (tx) => {
    const [current] = await tx.$queryRaw<
      Array<{
        status: RestaurantDeliveryFulfillmentStatus;
        orderId: string;
        paymentMode: 'PREPAID' | 'COD' | null;
      }>
    >(
      Prisma.sql`SELECT "status", "orderId", "paymentMode" FROM "restaurant_delivery_fulfillments" WHERE "id" = ${input.fulfillmentId} AND "organizationId" = ${input.organizationId} AND "branchId" = ${input.branchId} FOR UPDATE`
    );
    if (!current) throw new DeliveryError('Delivery fulfillment does not exist.', 'NOT_FOUND');
    if (current.status === input.status)
      return tx.restaurantDeliveryFulfillment.findFirstOrThrow({
        where: {
          id: input.fulfillmentId,
          organizationId: input.organizationId,
          branchId: input.branchId,
        },
      });
    if (!ALLOWED[current.status].includes(input.status))
      throw new DeliveryError(
        `Cannot transition delivery from ${current.status} to ${input.status}.`,
        'INVALID_TRANSITION'
      );
    const now = input.now ?? new Date();
    let paymentMode = current.paymentMode;
    if (input.status === 'DISPATCHED') {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "restaurant_bills" WHERE "orderId" = ${current.orderId} AND "status" <> 'VOID' ORDER BY "id" FOR UPDATE`
      );
      const bills = await tx.restaurantBill.findMany({
        where: { orderId: current.orderId, status: { not: 'VOID' } },
        orderBy: { id: 'asc' },
        select: {
          status: true,
          grandTotal: true,
          tenders: { orderBy: { id: 'asc' }, select: { amount: true } },
        },
      });
      if (bills.length === 0)
        throw new DeliveryError(
          'Delivery requires at least one live bill before dispatch.',
          'INVALID_TRANSITION'
        );
      const prepaid = bills.every(
        (bill) =>
          bill.status === 'SETTLED' &&
          bill.tenders.length > 0 &&
          bill.tenders
            .reduce((sum, tender) => sum.plus(tender.amount), new Prisma.Decimal(0))
            .equals(bill.grandTotal)
      );
      const cod = bills.every((bill) => bill.status === 'OPEN' && bill.tenders.length === 0);
      if (!prepaid && !cod)
        throw new DeliveryError(
          'Delivery bills are partial, mixed, or have untrusted tender coverage.',
          'INVALID_TRANSITION'
        );
      paymentMode = prepaid ? 'PREPAID' : 'COD';
    }
    const timestamps =
      input.status === 'DISPATCHED'
        ? { dispatchedAt: now }
        : input.status === 'DELIVERED'
          ? { deliveredAt: now }
          : input.status === 'CANCELLED'
            ? { cancelledAt: now }
            : { failedAt: now };
    return tx.restaurantDeliveryFulfillment.update({
      where: { id: input.fulfillmentId },
      data: { status: input.status, paymentMode, ...timestamps },
    });
  });
}
